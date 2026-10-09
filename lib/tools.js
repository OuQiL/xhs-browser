/**
 * Model-facing tools.
 *
 * Schema dialect: `ctx.tools.register` takes raw JSON Schema, restricted to
 * `type / oneOf / properties / required / additionalProperties / items / enum /
 * const` plus annotations. Output schemas are the unconstrained-object form on
 * purpose: `render` owns what the model reads, so a richer output schema would
 * add validation failure modes without adding information.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as xhs from './xhs.js';

/** Unconstrained-object output: any JSON object passes, `render` shapes the text. */
const OBJECT_OUTPUT = { type: 'object' };

function text(content) {
  return [{ type: 'text', text: content }];
}

/**
 * Strip binary payloads before rendering a value to the model.
 *
 * Only keys that actually carry base64 are dropped. `screenshot` holds a file
 * path, not image data, so stripping it too would hide the one thing the model
 * needs in order to look at the page.
 */
const BINARY_KEYS = new Set(['screenshotBase64', 'base64', 'png', 'imageData', 'dataUrl']);

function renderJson(value) {
  const seen = new WeakSet();
  const json = JSON.stringify(
    value,
    (key, entry) => {
      if (BINARY_KEYS.has(key)) return undefined;
      if (typeof entry === 'object' && entry !== null) {
        if (seen.has(entry)) return '[circular]';
        seen.add(entry);
      }
      return entry;
    },
    2,
  );
  if (json === undefined) return '(no value)';
  return json.length > 24_000 ? `${json.slice(0, 24_000)}\n… [truncated ${json.length - 24_000} chars]` : json;
}

function renderReport(title, value) {
  return text(`## ${title}\n\n\`\`\`json\n${renderJson(value)}\n\`\`\``);
}

/** `css=…`, `text=…`, `ph=…`; a bare string means "match this visible text". */
function parseTarget(selector, nth) {
  if (typeof selector !== 'string' || selector.trim().length === 0) {
    throw new Error('selector is required; use "css=…", "text=…", "ph=…" or a bare visible-text string');
  }
  const raw = selector.trim();
  const index = typeof nth === 'number' && Number.isFinite(nth) ? Math.max(0, Math.trunc(nth)) : undefined;
  if (raw.startsWith('css=')) return { css: raw.slice(4), nth: index };
  if (raw.startsWith('text=')) return { text: raw.slice(5), nth: index };
  if (raw.startsWith('ph=')) return { placeholder: raw.slice(3), nth: index };
  return { text: raw, nth: index };
}

function workspaceRoot(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

function saveShot(data, exec) {
  const dir = path.join(workspaceRoot(exec), '.xhs-shots');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `xhs-${stamp}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const BROWSER_ACTIONS = [
  'status',
  'start',
  'stop',
  'goto',
  'snapshot',
  'outline',
  'screenshot',
  'click',
  'type',
  'press',
  'scroll',
  'text',
];

export function registerTools(ctx, browser, config) {
  const disposers = [];

  /**
   * `auto`     — no interactive gate; the write proceeds and is audited.
   * `approve`  — the DSH approval service must grant it first (GUI prompt).
   * `blocked`  — every write is refused.
   */
  const writeMode = config?.writeActions === 'approve' || config?.writeActions === 'blocked' ? config.writeActions : 'auto';
  const auditEnabled = config?.auditLog !== false;

  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };

  // ------------------------------------------------------------ audit + writes

  /**
   * Append-only record of every write attempt.
   *
   * Automation without review must still be reconstructable after the fact:
   * this is the only way to answer "what did it actually post, and when".
   * The attempt line is written before the flow runs so a crash mid-flow still
   * leaves evidence of what was about to happen. A failing log never blocks or
   * fails the write itself.
   */
  function audit(exec, entry) {
    if (!auditEnabled) return;
    try {
      const dir = workspaceRoot(exec);
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, '.xhs-audit.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch {
      /* an unwritable audit log must not break the operation */
    }
  }

  function describeTarget(toolName, args) {
    if (toolName === 'xhs_publish') {
      return { title: String(args.title ?? ''), images: Array.isArray(args.images) ? args.images : [], body: String(args.content ?? ''), tags: args.tags };
    }
    if (toolName === 'xhs_dm') return { recipient: String(args.user ?? ''), text: String(args.text ?? '') };
    return { note: String(args.note ?? ''), text: String(args.text ?? ''), replyTo: args.replyTo };
  }

  /** Gate one irreversible action, then run it and audit both attempt and outcome. */
  async function runWrite(exec, { toolName, args, en, zh, run }) {
    if (writeMode === 'blocked') {
      throw new Error(`write actions are disabled by plugin config (writeActions: blocked); refusing ${toolName}`);
    }

    let approvalOutcome;
    if (writeMode === 'approve') {
      const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
      if (approval === undefined) {
        throw new Error(
          'writeActions is "approve" but the Host approval service is unavailable, so this irreversible action cannot be confirmed; refusing to proceed (fail-closed). Set writeActions to "auto" to run without an interactive gate.',
        );
      }
      const agent = exec?.agent;
      if (agent === undefined) {
        throw new Error('writeActions is "approve" but this tool was invoked without an Agent scope, so no one can approve; refusing to proceed.');
      }
      approvalOutcome = await approval.request({
        agent,
        toolName,
        callId: exec?.callId,
        reason: en,
        displayReason: { en, zh },
        signal: exec?.signal,
      });
      if (approvalOutcome !== 'allowed-once') {
        throw new Error(
          `${toolName} was not approved (approval outcome: ${String(approvalOutcome)}), so nothing was sent. ` +
            (approvalOutcome === 'rejected' || approvalOutcome === 'unavailable'
              ? 'Note that DSH returns "rejected" without asking whenever the session approval policy is "never". Set writeActions to "auto" to run without an interactive gate.'
              : 'The user declined or cancelled the request.'),
        );
      }
    }

    const writeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    audit(exec, { writeId, tool: toolName, mode: writeMode, approval: approvalOutcome ?? 'not-requested', phase: 'attempt', target: describeTarget(toolName, args) });

    let result;
    try {
      result = await run();
    } catch (error) {
      audit(exec, { writeId, tool: toolName, phase: 'error', error: error.message });
      throw error;
    }

    const ok = result?.ok !== false;
    audit(exec, {
      writeId,
      tool: toolName,
      phase: 'result',
      ok,
      failedStep: result?.failedStep,
      url: result?.url,
      steps: Array.isArray(result?.steps) ? result.steps.map((step) => ({ step: step.step, ok: step.ok, error: step.error })) : undefined,
    });
    return { writeId, mode: writeMode, ...result };
  }

  /** Turn a flow failure into a diagnostic the model can act on. */
  async function diagnose(exec, error) {
    const report = await xhs.pageReport(browser).catch(() => undefined);
    let screenshot;
    try {
      screenshot = saveShot(await browser.screenshot(), exec);
    } catch {
      screenshot = undefined;
    }
    return {
      ok: false,
      failedStep: error instanceof xhs.XhsFlowError ? error.step : undefined,
      steps: error instanceof xhs.XhsFlowError ? error.steps : undefined,
      error: error.message,
      screenshot,
      page: report?.page,
      outline: report?.outline,
      pageText: report?.text,
    };
  }

  // -------------------------------------------------------------- driver tool

  register({
    name: 'xhs_browser',
    description: [
      'Drive the Xiaohongshu (RED) browser session: check status, start/stop Chrome, navigate, and inspect or manipulate the live page.',
      'Use `start` before any other action. Use `snapshot` to see what is on screen (page meta + interactive-element outline + visible text), and `screenshot` to save a PNG you can open.',
      '`click`/`type` accept `css=…`, `text=…`, `ph=…` (placeholder) or a bare string matched against visible text; add `nth` to pick among several matches.',
      'These are low-level escape hatches for when a high-level xhs_* tool breaks because the site changed.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: BROWSER_ACTIONS, description: 'What to do.' },
        url: { type: 'string', description: 'Target URL for goto, or a route name: explore | search | messages | creator.' },
        selector: { type: 'string', description: 'Element locator for click/type.' },
        value: { type: 'string', description: 'Text to enter for type.' },
        key: { type: 'string', description: 'Key name for press, e.g. Enter, Escape, PageDown.' },
        dy: { type: 'number', description: 'Vertical scroll delta in pixels for scroll.' },
        nth: { type: 'number', description: 'Zero-based index among matching elements.' },
        fullPage: { type: 'boolean', description: 'Capture beyond the viewport for screenshot.' },
      },
      required: ['action'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (args, value) => renderReport(`xhs_browser ${args.action}`, value),
    },
    presentCall(args) {
      return { card: 'generic', title: `Xiaohongshu: ${args.action}`, kind: 'other', rawInput: args.url ?? args.selector ?? args.key };
    },
    async execute(args, exec) {
      const action = args.action;
      if (BROWSER_ACTIONS.includes(action)) exec.signal?.throwIfAborted?.();

      if (action === 'status') {
        const state = {
          connected: browser.connected,
          debugPort: browser.debugPort,
          userDataDir: browser.userDataDir,
          chromePath: browser.chromePath ?? '(auto-detected)',
          headless: browser.headless,
          launchedByUs: browser.launchedByUs,
        };
        if (browser.connected) {
          state.url = await browser.url().catch((error) => `unavailable: ${error.message}`);
          state.login = await xhs.loginState(browser).catch((error) => ({ error: error.message }));
        }
        return state;
      }

      if (action === 'start') {
        await browser.ensure();
        const page = await browser.run('rt.page()').catch(() => undefined);
        return { started: true, url: page?.url ?? '', login: await xhs.loginState(browser) };
      }

      if (action === 'stop') {
        await browser.dispose();
        return { stopped: true, note: 'the Chrome window stays open; only the CDP connection was released' };
      }

      await browser.ensure();

      if (action === 'goto') {
        const routes = {
          explore: xhs.URLS.explore,
          search: xhs.URLS.search,
          messages: xhs.URLS.messages,
          creator: xhs.URLS.creatorPublish,
          home: xhs.URLS.origin,
        };
        const target = routes[args.url] ?? args.url;
        if (typeof target !== 'string' || target.length === 0) throw new Error('goto requires url (a URL or one of: explore, search, messages, creator, home)');
        const page = await browser.navigate(target);
        return { navigated: true, page };
      }

      if (action === 'screenshot') {
        const file = saveShot(await browser.screenshot({ fullPage: args.fullPage === true }), exec);
        return { screenshot: file, fullPage: args.fullPage === true };
      }

      if (action === 'snapshot' || action === 'outline') {
        const report = await xhs.pageReport(browser, { outlineLimit: 80 });
        return { ...report, screenshot: saveShot(await browser.screenshot(), exec) };
      }

      if (action === 'text') {
        return { text: await browser.run('rt.pageText(6000)') };
      }

      if (action === 'click') {
        const located = await browser.run(`rt.locate(${JSON.stringify(parseTarget(args.selector, args.nth))})`);
        if (located?.found !== true) {
          throw new Error(`no visible element matched ${args.selector} (${located?.reason ?? 'unknown'}; ${located?.candidateCount ?? 0} candidates)`);
        }
        if (located.occluded === true) {
          throw new Error(
            `the target is covered by another element (${located.occludedBy}), so a click would land on the overlay instead; dismiss it first (for example xhs_browser action=press key=Escape) and try again`,
          );
        }
        if (located.inViewport === false) {
          throw new Error(
            `the target is rendered outside the viewport (centre ${Math.round(located.rect?.x ?? 0)},${Math.round(located.rect?.y ?? 0)}), so a click cannot reach it; try a different selector or scroll the containing panel first`,
          );
        }
        await browser.clickAt(located.rect.x, located.rect.y);
        return { clicked: located.text, tag: located.tag, matchCount: located.matchCount };
      }

      if (action === 'type') {
        if (typeof args.value !== 'string') throw new Error('type requires value');
        const located = await browser.run(`rt.locate(${JSON.stringify(parseTarget(args.selector, args.nth))})`);
        if (located?.found !== true) throw new Error(`no visible element matched ${args.selector} (${located?.reason ?? 'unknown'})`);
        await browser.clickAt(located.rect.x, located.rect.y);
        await browser.insertText(args.value);
        return { typed: args.value.length, into: located.text || located.tag };
      }

      if (action === 'press') {
        const key = typeof args.key === 'string' && args.key.length > 0 ? args.key : 'Enter';
        await browser.pressKey(key, { code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : undefined });
        return { pressed: key };
      }

      if (action === 'scroll') {
        const dy = typeof args.dy === 'number' && Number.isFinite(args.dy) ? args.dy : 800;
        return await browser.run(`rt.scrollBy(0, ${Math.trunc(dy)})`);
      }

      throw new Error(`unsupported action ${String(action)}`);
    },
  });

  // ---------------------------------------------------------------- login tool

  register({
    name: 'xhs_login',
    description:
      'Open the Xiaohongshu login page in the plugin Chrome profile and report whether a session is already active. If not logged in, tell the user to scan the QR code in the Chrome window that just opened, then call this tool again to confirm. The session persists in the profile directory across restarts.',
    parameters: {
      type: 'object',
      properties: {
        waitSeconds: { type: 'number', description: 'How long to wait for the user to finish scanning before reporting (default 0).' },
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => renderReport('xhs_login', value),
    },
    presentCall() {
      return { card: 'generic', title: 'Xiaohongshu login', kind: 'other' };
    },
    async execute(args, exec) {
      await browser.ensure();
      const before = await xhs.loginState(browser);
      if (before.loggedIn) return { loggedIn: true, ...before };
      await browser.navigate(xhs.URLS.origin, { settleMs: 3_000 });
      const waitMs = Math.max(0, Math.min(Number(args.waitSeconds) || 0, 300)) * 1_000;
      if (waitMs > 0) {
        const deadline = Date.now() + waitMs;
        for (;;) {
          const state = await xhs.loginState(browser);
          if (state.loggedIn) return { loggedIn: true, ...state };
          if (Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          exec.signal?.throwIfAborted?.();
        }
      }
      const after = await xhs.loginState(browser);
      return {
        loggedIn: after.loggedIn,
        ...after,
        instruction: after.loggedIn
          ? 'session is active'
          : 'A Chrome window is open on xiaohongshu.com. Ask the user to scan the QR code with the Xiaohongshu app, then call xhs_login again.',
        screenshot: saveShot(await browser.screenshot(), exec),
      };
    },
  });

  // -------------------------------------------------------------- read tools

  register({
    name: 'xhs_search',
    description:
      'Search Xiaohongshu for notes matching a keyword and return structured results (note id, title, author, like count, and a URL that already carries the required xsec_token). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword.' },
        limit: { type: 'number', description: 'Maximum notes to return (1-60, default 20).' },
      },
      required: ['keyword'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (args, value) => renderReport(`xhs_search "${args.keyword}"`, value),
    },
    presentCall(args) {
      return { card: 'generic', title: `Search Xiaohongshu: ${args.keyword}`, kind: 'search', rawInput: args.keyword };
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.();
      await browser.ensure();
      await assertLoggedIn(browser);
      const limit = Math.max(1, Math.min(Number(args.limit) || 20, 60));
      const result = await xhs.searchNotes(browser, String(args.keyword), { limit });
      if (result.ok !== true) {
        const why = result.redirectedToLogin ? 'the search page redirected to login' : 'the search page returned no parseable results';
        throw new Error(`search failed: ${why}${result.reason ? ` (${result.reason})` : ''}; final url was ${result.finalUrl || result.url}`);
      }
      return result;
    },
  });

  register({
    name: 'xhs_note',
    description:
      'Read one Xiaohongshu note: title, body, author, engagement counts, tags, image URLs, and the visible comments with their replies. Read-only. Pass a note id or a full URL; a URL from xhs_search already carries the xsec_token the site requires.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note id or full note URL.' },
      },
      required: ['note'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => renderReport('xhs_note', value),
    },
    presentCall(args) {
      return { card: 'generic', title: 'Read Xiaohongshu note', kind: 'read', rawInput: args.note, locations: [] };
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.();
      await browser.ensure();
      const result = await xhs.readNote(browser, String(args.note));
      if (result.ok !== true) {
        throw new Error(
          `could not read note: ${result.reason ?? 'unknown'}${result.redirectedToLogin ? ' (the page redirected to login; run xhs_login first)' : ''}; final url was ${result.finalUrl || result.url}`,
        );
      }
      return result;
    },
  });

  register({
    name: 'xhs_profile',
    description:
      'Read a Xiaohongshu user profile: display name, RED id, bio, and that user\'s notes with URLs. Pass a user id or profile URL. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'User id or full profile URL.' },
      },
      required: ['user'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => renderReport('xhs_profile', value),
    },
    presentCall(args) {
      return { card: 'generic', title: 'Read Xiaohongshu profile', kind: 'read', rawInput: args.user };
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.();
      await browser.ensure();
      const result = await xhs.readProfile(browser, String(args.user));
      if (result.ok !== true) {
        throw new Error(
          `could not read profile: ${result.reason ?? 'the page carried no profile data'}; final url was ${result.finalUrl || result.url}`,
        );
      }
      return result;
    },
  });

  // ------------------------------------------------------------- write tools

  register({
    name: 'xhs_comment',
    description: [
      'Publish ONE comment (or a reply to an existing comment) on a Xiaohongshu note, as the logged-in account.',
      'This is public and cannot be undone. The default configuration posts it directly, with no confirmation prompt; the plugin setting writeActions="approve" restores an interactive gate.',
      'Every call is recorded in .xhs-audit.jsonl in the session workspace, including the exact text and the outcome.',
      'Use `replyTo` with a snippet of the comment you are replying to in order to open that comment\'s reply box.',
      'Do not use this to post bulk or repetitive comments; one call is one comment.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note id or full note URL to comment on.' },
        text: { type: 'string', description: 'Exact comment text to publish.' },
        replyTo: { type: 'string', description: 'Optional snippet of an existing comment to reply to.' },
      },
      required: ['note', 'text'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => renderReport('xhs_comment', value),
    },
    presentCall(args) {
      return { card: 'generic', title: 'Comment on Xiaohongshu', kind: 'edit', rawInput: args.text };
    },
    async execute(args, exec) {
      const text = String(args.text ?? '');
      if (text.trim().length === 0) throw new Error('comment text is required');
      if (text.length > 1_000) throw new Error('comment text exceeds the platform limit of 1000 characters');
      const url = xhs.noteUrl(String(args.note));
      return runWrite(exec, {
        toolName: 'xhs_comment',
        args,
        en: `Post a public comment on ${url}:\n\n${text}`,
        zh: `在小红书笔记下发表公开评论\n笔记：${url}\n内容：${text}`,
        run: async () => {
          await browser.ensure();
          await assertLoggedIn(browser);
          try {
            return await xhs.postComment(browser, { noteUrl: url, text, replyTo: args.replyTo });
          } catch (error) {
            return await diagnose(exec, error);
          }
        },
      });
    },
  });

  register({
    name: 'xhs_dm',
    description: [
      'Send ONE direct message to a Xiaohongshu user, as the logged-in account, by opening their profile and using the 私信 control.',
      'The default configuration sends it directly, with no confirmation prompt; the plugin setting writeActions="approve" restores an interactive gate.',
      'Every call is recorded in .xhs-audit.jsonl in the session workspace, including the exact recipient and text.',
      'One call is one message. Bulk or unsolicited messaging is out of scope by design and must not be attempted with repeated calls.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'Recipient user id or profile URL.' },
        text: { type: 'string', description: 'Exact message text to send.' },
      },
      required: ['user', 'text'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => renderReport('xhs_dm', value),
    },
    presentCall(args) {
      return { card: 'generic', title: 'Send Xiaohongshu direct message', kind: 'edit', rawInput: args.text };
    },
    async execute(args, exec) {
      const text = String(args.text ?? '');
      if (text.trim().length === 0) throw new Error('message text is required');
      if (text.length > 1_000) throw new Error('message text exceeds the platform limit of 1000 characters');
      const url = xhs.profileUrl(String(args.user));
      return runWrite(exec, {
        toolName: 'xhs_dm',
        args,
        en: `Send a direct message to ${url}:\n\n${text}`,
        zh: `给小红书用户发送私信\n收件人：${url}\n内容：${text}`,
        run: async () => {
          await browser.ensure();
          await assertLoggedIn(browser);
          try {
            return await xhs.sendDirectMessage(browser, { userId: url, text });
          } catch (error) {
            return await diagnose(exec, error);
          }
        },
      });
    },
  });

  register({
    name: 'xhs_publish',
    description: [
      'Publish ONE image-and-text note on Xiaohongshu through the creator platform, using local image files.',
      'The default configuration publishes directly, with no confirmation prompt; the plugin setting writeActions="approve" restores an interactive gate.',
      'Images must be absolute local paths. The creator platform upload can take a while; the flow waits up to two minutes.',
      'Publishing is public and effectively irreversible. Every call is recorded in .xhs-audit.jsonl in the session workspace.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        images: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to local image files, in display order.' },
        title: { type: 'string', description: 'Note title (up to 20 characters on Xiaohongshu).' },
        content: { type: 'string', description: 'Note body text.' },
        tags: { type: 'string', description: 'Optional topic tags appended to the body, e.g. "#旅行 #美食".' },
      },
      required: ['images', 'title', 'content'],
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => renderReport('xhs_publish', value),
    },
    presentCall(args) {
      return { card: 'generic', title: `Publish note: ${args.title ?? ''}`, kind: 'edit', rawInput: args.title };
    },
    async execute(args, exec) {
      const images = Array.isArray(args.images) ? args.images.map((entry) => String(entry)) : [];
      if (images.length === 0) throw new Error('at least one image path is required');
      const missing = images.filter((file) => !existsSync(file));
      if (missing.length > 0) throw new Error(`these image paths do not exist: ${missing.join(', ')}`);
      const title = String(args.title ?? '');
      const content = String(args.content ?? '');
      if (title.trim().length === 0) throw new Error('title is required');
      return runWrite(exec, {
        toolName: 'xhs_publish',
        args,
        en: `Publish a note to Xiaohongshu.\nTitle: ${title}\nImages:\n${images.join('\n')}\nBody:\n${content}${args.tags ? `\n${args.tags}` : ''}`,
        zh: `发布一篇小红书图文笔记\n标题：${title}\n图片：\n${images.join('\n')}\n正文：\n${content}${args.tags ? `\n${args.tags}` : ''}`,
        run: async () => {
          await browser.ensure();
          await assertLoggedIn(browser);
          try {
            return await xhs.publishNote(browser, { images, title, content, tags: args.tags });
          } catch (error) {
            return await diagnose(exec, error);
          }
        },
      });
    },
  });

  return disposers;
}

/** Reads on a logged-out session return empty pages, which reads as a bug. */
async function assertLoggedIn(browser) {
  const state = await xhs.loginState(browser, { hydrate: true });
  if (state.loggedIn !== true) {
    throw new Error(
      `not logged in to Xiaohongshu: ${state.evidence}. Call xhs_login, have the user scan the QR code in the Chrome window, then retry.`,
    );
  }
  return state;
}
