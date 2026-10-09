/**
 * Xiaohongshu site layer.
 *
 * Two deliberate design choices:
 *
 * 1. Reads prefer the page's own `window.__INITIAL_STATE__` over DOM scraping.
 *    It is the same payload the web app renders from, so it survives class-name
 *    churn far better than selectors do.
 * 2. Writes are expressible as a step list. A failing step returns the exact
 *    step, the page URL, and an interactive-element outline, so a broken
 *    selector is a one-line fix instead of a guessing game. These flows are
 *    best-effort by construction: the site can change any of them at any time.
 */

export const URLS = {
  origin: 'https://www.xiaohongshu.com',
  explore: 'https://www.xiaohongshu.com/explore',
  search: 'https://www.xiaohongshu.com/search_result',
  profile: 'https://www.xiaohongshu.com/user/profile',
  messages: 'https://www.xiaohongshu.com/messages',
  creatorPublish: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=menu',
};

/** Every site selector the write flows depend on, in one place. */
export const SELECTORS = {
  commentInput: 'div[contenteditable="true"]',
  chatInput: 'div[contenteditable="true"], textarea',
  titleInput: 'input[placeholder*="标题"], input[placeholder*="title"]',
  publishEditor: 'div[contenteditable="true"]',
  fileInput: 'input[type="file"]',
  sendButtonText: '发送',
  dmButtonText: '私信',
  replyText: '回复',
  publishButtonText: '发布',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A write flow stopped at one identifiable step. */
export class XhsFlowError extends Error {
  constructor(step, cause, steps) {
    super(`step "${step}" failed: ${cause.message}`);
    this.name = 'XhsFlowError';
    this.step = step;
    this.steps = steps;
  }
}

export function noteUrl(input) {
  const value = String(input ?? '').trim();
  if (value.length === 0) throw new Error('a note id or URL is required');
  if (/^https?:\/\//i.test(value)) return value;
  return `${URLS.explore}/${encodeURIComponent(value)}`;
}

export function profileUrl(input) {
  const value = String(input ?? '').trim();
  if (value.length === 0) throw new Error('a user id or profile URL is required');
  if (/^https?:\/\//i.test(value)) return value;
  return `${URLS.profile}/${encodeURIComponent(value)}`;
}

async function waitUntil(browser, body, { timeoutMs = 20_000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await browser.run(body).catch((error) => ({ ok: false, error: error.message }));
    if (last && last.ok === true) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

async function locate(browser, target) {
  const located = await browser.run(`rt.locate(${JSON.stringify(target)})`);
  if (!located || located.found !== true) {
    throw new Error(`no visible element matched ${JSON.stringify(target)} (${located?.reason ?? 'unknown'})`);
  }
  return located;
}

async function clickTarget(browser, target) {
  const located = await locate(browser, target);
  await browser.clickAt(located.rect.x, located.rect.y);
  return located;
}

/** Hover without pressing, for controls that only appear on mouse-over. */
async function hoverTarget(browser, target) {
  const located = await locate(browser, target);
  await browser.sendPage('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(located.rect.x),
    y: Math.round(located.rect.y),
    button: 'none',
  });
  await sleep(500);
  return located;
}

async function clearActiveElement(browser) {
  const cleared = await browser.run(`(() => {
    const el = document.activeElement;
    if (!el) return { ok: false, reason: 'nothing focused' };
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { ok: true, kind: 'contenteditable' };
    }
    if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.select();
      return { ok: true, kind: el.tagName.toLowerCase() };
    }
    return { ok: false, reason: 'active element is not editable' };
  })()`);
  if (cleared?.ok === true) {
    await browser.pressKey('Backspace', { code: 'Backspace', windowsVirtualKeyCode: 8 });
  }
  return cleared;
}

async function typeInto(browser, target, text, { clear = true } = {}) {
  const located = await clickTarget(browser, target);
  if (clear) await clearActiveElement(browser);
  await browser.insertText(text);
  const focused = await browser.run('({ ok: true, tag: document.activeElement ? document.activeElement.tagName.toLowerCase() : "none" })');
  return { located, focused };
}

// --------------------------------------------------------------------- reads

/**
 * The page store is the only trustworthy login signal.
 *
 * Xiaohongshu hands an *anonymous* `web_session` cookie to logged-out visitors,
 * so cookie presence alone reports a logged-in session that does not exist — it
 * was wrong for every logged-out page during development. The Vue store's
 * `user.loggedIn` / `user.userInfo.nickname` is authoritative.
 */
async function readLoginVerdict(browser) {
  return browser.run(`(() => {
    const S = window.__INITIAL_STATE__;
    const user = rt.unwrap(S && S.user);
    const login = rt.unwrap(S && S.login);
    if (!user && !login) return null;
    const info = rt.unwrap(user && user.userInfo);
    return {
      ok: true,
      userLoggedIn: user ? user.loggedIn === true : false,
      nickname: info ? (info.nickname || info.nickName || '') : '',
      showLogin: !!(login && login.showLogin),
    };
  })()`);
}

export async function loginState(browser, { hydrate = false } = {}) {
  await browser.sendPage('Network.enable', {}).catch(() => undefined);
  const cookieResult = await browser
    .sendPage('Network.getCookies', { urls: [URLS.origin, 'https://creator.xiaohongshu.com'] })
    .catch(() => ({ cookies: [] }));
  const cookies = cookieResult?.cookies ?? [];
  const sessionCookie = cookies.find(
    (cookie) => cookie.name === 'web_session' && typeof cookie.value === 'string' && cookie.value.length > 8,
  );

  let page = await browser.run('rt.page()').catch(() => undefined);
  let verdict = await readLoginVerdict(browser).catch(() => null);

  // A blank tab or a non-Xiaohongshu page has no store to read; load the feed
  // once so the answer is real rather than "unknown, assume logged out".
  if (hydrate && verdict === null) {
    await browser.navigate(URLS.explore, { settleMs: 3_000 });
    page = await browser.run('rt.page()').catch(() => undefined);
    verdict = await readLoginVerdict(browser).catch(() => null);
  }

  const byStore = verdict?.userLoggedIn === true;
  const byNickname = typeof verdict?.nickname === 'string' && verdict.nickname.length > 0;
  const loggedIn = byStore || byNickname;

  const evidence = [
    byStore ? 'page store reports user.loggedIn' : 'page store does not report a login',
    byNickname ? `profile nickname "${verdict.nickname}"` : undefined,
    sessionCookie !== undefined ? 'web_session cookie present (also issued to logged-out visitors, so not decisive)' : 'no web_session cookie',
    verdict?.showLogin ? 'login modal is open' : undefined,
    page?.url ? `url ${page.url}` : undefined,
  ].filter(Boolean);

  return {
    loggedIn,
    byStore,
    byNickname,
    hasSessionCookie: sessionCookie !== undefined,
    storeReadable: verdict !== null,
    evidence: evidence.join('; '),
    nickname: verdict?.nickname ?? '',
    currentUrl: page?.url ?? '',
  };
}

export async function searchNotes(browser, keyword, { limit = 20 } = {}) {
  const url = `${URLS.search}?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed&type=51`;
  const page = await browser.navigate(url, { settleMs: 4_500 });
  const result = await browser.run(`(() => {
    const S = window.__INITIAL_STATE__;
    const search = rt.unwrap(S && S.search);
    let raw = search && (search.feeds || (search.searchFeedData && search.searchFeedData.feeds));
    raw = rt.unwrap(raw);
    const list = Array.isArray(raw) ? raw : [];
    const items = list.map((item) => {
      const card = rt.unwrap(item.noteCard || item.note_card) || item;
      const user = rt.unwrap(card.user) || {};
      const interact = rt.unwrap(card.interactInfo || card.interact_info) || {};
      const cover = rt.unwrap(card.cover) || {};
      const noteId = card.noteId || card.note_id || item.id || card.id;
      const token = item.xsecToken || item.xsec_token || card.xsecToken;
      return {
        noteId: noteId,
        title: card.displayTitle || card.display_title || card.title || '',
        type: card.type || '',
        author: user.nickname || user.nickName || user.nick_name || '',
        authorId: user.userId || user.user_id || '',
        likedCount: interact.likedCount || interact.liked_count || '',
        cover: cover.urlDefault || cover.url_default || cover.urlPre || '',
        url: noteId
          ? '${URLS.explore}/' + noteId + (token ? '?xsec_token=' + token + '&xsec_source=pc_search' : '')
          : '',
      };
    });
    if (items.length > 0) return { ok: true, source: 'initial-state', items: rt.clip(items, { maxArray: ${Math.max(1, Math.min(limit, 60))}, maxString: 300 }) };
    const links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/explore/"]')).map((a) => ({
      noteId: (a.getAttribute('href') || '').split('/explore/')[1] || '',
      title: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      url: a.href,
    })).filter((entry) => entry.noteId);
    return { ok: links.length > 0, source: 'dom', items: links.slice(0, ${Math.max(1, Math.min(limit, 60))}) };
  })()`);
  return {
    keyword,
    url,
    finalUrl: page?.url ?? '',
    redirectedToLogin: /\/login/.test(page?.url ?? ''),
    ...result,
  };
}

export async function readNote(browser, input) {
  const url = noteUrl(input);
  const page = await browser.navigate(url, { settleMs: 3_500 });
  const result = await browser.run(`(() => {
    const S = window.__INITIAL_STATE__;
    const noteStore = rt.unwrap(S && S.note);
    const map = rt.unwrap(noteStore && noteStore.noteDetailMap);
    if (!map) return { ok: false, reason: 'page has no noteDetailMap (note may need a fresh xsec_token, or the page was blocked)' };
    const entry = rt.unwrap(Object.values(map).find((value) => value && rt.unwrap(value).note));
    if (!entry) return { ok: false, reason: 'noteDetailMap was empty' };
    const n = rt.unwrap(entry.note);
    const u = rt.unwrap(n.user) || {};
    const i = rt.unwrap(n.interactInfo) || {};
    const comments = rt.unwrap(entry.comments) || {};
    const commentList = rt.unwrap(comments.list) || [];
    return {
      ok: true,
      note: {
        noteId: n.noteId,
        title: n.title || '',
        desc: n.desc || '',
        type: n.type || '',
        ipLocation: n.ipLocation || '',
        publishTime: n.time || n.lastUpdateTime || 0,
        author: { id: u.userId || '', name: u.nickname || u.nickName || '', redId: u.redId || '' },
        interact: {
          liked: i.likedCount || '0',
          collected: i.collectedCount || '0',
          comment: i.commentCount || '0',
          shared: i.shareCount || '0',
        },
        tags: (rt.unwrap(n.tagList) || []).map((tag) => rt.unwrap(tag).name).filter(Boolean),
        images: (rt.unwrap(n.imageList) || []).map((img) => {
          const image = rt.unwrap(img) || {};
          const infos = rt.unwrap(image.infoList) || [];
          const first = rt.unwrap(infos[0]) || {};
          return image.urlDefault || image.url || first.url || '';
        }).filter(Boolean),
        comments: commentList.map((c) => {
          const comment = rt.unwrap(c);
          const commentUser = rt.unwrap(comment.userInfo) || {};
          return {
            id: comment.id,
            content: comment.content || '',
            liked: comment.likeCount || '0',
            time: comment.createTime || 0,
            user: commentUser.nickname || commentUser.nickName || '',
            userId: commentUser.userId || commentUser.user_id || '',
            replies: (rt.unwrap(comment.subComments) || []).map((s) => {
              const reply = rt.unwrap(s);
              const replyUser = rt.unwrap(reply.userInfo) || {};
              return { id: reply.id, content: reply.content || '', user: replyUser.nickname || replyUser.nickName || '' };
            }),
          };
        }),
        commentsHasMore: comments.hasMore === true,
      },
    };
  })()`);
  return { url, finalUrl: page?.url ?? '', redirectedToLogin: /\/login/.test(page?.url ?? ''), ...result };
}

export async function readProfile(browser, input) {
  const url = profileUrl(input);
  const page = await browser.navigate(url, { settleMs: 3_500 });
  const result = await browser.run(`(() => {
    const S = window.__INITIAL_STATE__;
    const user = rt.unwrap(S && S.user);
    const pageData = rt.unwrap(user && (user.userPageData || user.user_page_data)) || {};
    const info = rt.unwrap(pageData.basicInfo || pageData.basic_info) || rt.unwrap(user && user.userInfo) || null;
    const feedsRaw = rt.unwrap(pageData.feeds || pageData.notes);
    const feeds = Array.isArray(feedsRaw) ? feedsRaw : (rt.unwrap(feedsRaw && (feedsRaw.value || feedsRaw.feeds)) || []);
    const notes = (Array.isArray(feeds) ? feeds : []).map((item) => {
      const card = rt.unwrap(item.noteCard || item.note_card) || item;
      const interact = rt.unwrap(card.interactInfo || card.interact_info) || {};
      const noteId = card.noteId || card.note_id || item.id || card.id;
      const token = item.xsecToken || item.xsec_token || card.xsecToken;
      return {
        noteId: noteId,
        title: card.displayTitle || card.display_title || '',
        likedCount: interact.likedCount || interact.liked_count || '',
        url: noteId ? '${URLS.explore}/' + noteId + (token ? '?xsec_token=' + token + '&xsec_source=pc_user' : '') : '',
      };
    });
    const body = document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600) : '';
    return {
      ok: (info !== null && !!(info.nickname || info.nickName || info.userId)) || notes.length > 0,
      profile: info ? {
        id: info.userId || info.user_id || '',
        name: info.nickname || info.nickName || '',
        redId: info.redId || info.red_id || '',
        desc: info.desc || '',
        fans: info.fans || (rt.unwrap(info.interactions) && rt.unwrap(info.interactions)[0] && rt.unwrap(info.interactions)[0].count) || '',
        follows: info.follows || '',
      } : { name: '', desc: body.slice(0, 160) },
      notes: notes,
      loggedOutHint: /登录|扫码/.test(body),
    };
  })()`);
  const redirectedToLogin = /\/login/.test(page?.url ?? '');
  return {
    url,
    finalUrl: page?.url ?? '',
    redirectedToLogin,
    ...result,
    ok: result.ok === true && redirectedToLogin === false,
    reason: redirectedToLogin ? 'the profile redirected to the login page; log in with xhs_login first' : undefined,
  };
}

/** Compact page report used as the diagnostic payload when a flow breaks. */
export async function pageReport(browser, { outlineLimit = 50 } = {}) {
  const page = await browser.run('rt.page()').catch((error) => ({ error: error.message }));
  const outline = await browser.run(`rt.outline(${Math.max(1, Math.min(outlineLimit, 120))})`).catch(() => []);
  const text = await browser.run('rt.pageText(1500)').catch(() => '');
  return { page, outline, text };
}

// -------------------------------------------------------------------- writes

function makeRecorder() {
  const steps = [];
  return {
    steps,
    async step(name, fn) {
      try {
        const value = await fn();
        steps.push({ step: name, ok: true, detail: value === undefined ? undefined : value });
        return value;
      } catch (error) {
        steps.push({ step: name, ok: false, error: error.message });
        throw new XhsFlowError(name, error, steps);
      }
    },
  };
}

export async function postComment(browser, { noteUrl: input, text, replyTo } = {}) {
  const url = noteUrl(input);
  const recorder = makeRecorder();
  await recorder.step('open note', async () => {
    await browser.navigate(url, { settleMs: 3_000 });
    return url;
  });

  if (typeof replyTo === 'string' && replyTo.trim().length > 0) {
    await recorder.step('open reply box', async () => {
      const needle = replyTo.trim().slice(0, 40);
      const located = await hoverTarget(browser, { text: needle });
      const replyButton = await browser.run(`rt.locate({ text: ${JSON.stringify(SELECTORS.replyText)} })`);
      if (!replyButton || replyButton.found !== true) throw new Error('no 回复 control appeared next to the matched comment');
      await browser.clickAt(replyButton.rect.x, replyButton.rect.y);
      await sleep(600);
      return { matched: located.text, replyButton: replyButton.text };
    });
  }

  await recorder.step('focus comment box', async () => {
    const located = await locate(browser, { css: SELECTORS.commentInput });
    await browser.clickAt(located.rect.x, located.rect.y);
    await sleep(400);
    const focused = await browser.run(`(() => {
      const el = document.activeElement;
      return { ok: !!el && !!el.isContentEditable, tag: el ? el.tagName.toLowerCase() : 'none', placeholder: el ? (el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '') : '' };
    })()`);
    if (focused?.ok !== true) throw new Error(`comment box did not take focus (active: ${focused?.tag ?? 'none'})`);
    return focused;
  });

  await recorder.step('type comment', async () => {
    await clearActiveElement(browser);
    await browser.insertText(text);
    await sleep(500);
    const typed = await browser.run(`(() => {
      const el = document.activeElement;
      const v = el ? (el.isContentEditable ? el.innerText : el.value) : '';
      return { ok: (v || '').indexOf(${JSON.stringify(text.slice(0, 12))}) >= 0, typed: (v || '').slice(0, 80) };
    })()`);
    if (typed?.ok !== true) throw new Error(`comment text did not land in the editor (saw: ${typed?.typed ?? ''})`);
    return typed;
  });

  await recorder.step('send', async () => {
    const button = await browser.run(`rt.locate({ text: ${JSON.stringify(SELECTORS.sendButtonText)} })`);
    if (!button || button.found !== true) throw new Error('no 发送 button found');
    await browser.clickAt(button.rect.x, button.rect.y);
    await sleep(1_500);
    const after = await browser.run(`(() => {
      const el = document.activeElement;
      const v = el ? (el.isContentEditable ? el.innerText : el.value) : '';
      return { ok: (v || '').trim().length === 0, remaining: (v || '').slice(0, 60) };
    })()`);
    return { emptiedEditor: after?.ok === true, remaining: after?.remaining ?? '' };
  });

  const verification = await verifyComment(browser, text);
  return { ok: true, url, steps: recorder.steps, verification };
}

async function verifyComment(browser, text) {
  const needle = String(text).slice(0, 20);
  await sleep(1_500);
  const found = await browser.run(`(() => {
    const S = window.__INITIAL_STATE__;
    const map = S && S.note && S.note.noteDetailMap;
    if (map) {
      const entry = Object.values(map).find((value) => value && value.comments);
      const list = (entry && entry.comments && entry.comments.list) || [];
      const hit = list.find((c) => (c.content || '').indexOf(${JSON.stringify(needle)}) >= 0);
      if (hit) return { ok: true, via: 'initial-state', content: (hit.content || '').slice(0, 80) };
    }
    const body = document.body ? document.body.innerText : '';
    if (body.indexOf(${JSON.stringify(needle)}) >= 0) return { ok: true, via: 'dom-text' };
    return { ok: false, via: 'none' };
  })()`);
  return found;
}

export async function sendDirectMessage(browser, { userId, text } = {}) {
  const url = profileUrl(userId);
  const recorder = makeRecorder();

  await recorder.step('open profile', async () => {
    await browser.navigate(url, { settleMs: 3_000 });
    return url;
  });

  await recorder.step('open conversation', async () => {
    let entry = await browser.run(`rt.locate({ text: ${JSON.stringify(SELECTORS.dmButtonText)} })`);
    if (!entry || entry.found !== true) {
      entry = await browser.run('rt.locate({ text: "发消息" })');
    }
    if (!entry || entry.found !== true) throw new Error('no 私信 / 发消息 control on the profile page');
    await browser.clickAt(entry.rect.x, entry.rect.y);
    await sleep(1_200);
    return { control: entry.text };
  });

  await recorder.step('find composer', async () => {
    await waitUntil(browser, `(() => {
      const el = document.querySelector(${JSON.stringify(SELECTORS.chatInput)});
      return { ok: !!el && el.getBoundingClientRect().width > 2 };
    })()`, { timeoutMs: 15_000, label: 'chat composer' });
    const located = await locate(browser, { css: SELECTORS.chatInput });
    await browser.clickAt(located.rect.x, located.rect.y);
    await sleep(400);
    return located;
  });

  await recorder.step('type message', async () => {
    await clearActiveElement(browser);
    await browser.insertText(text);
    await sleep(500);
    const typed = await browser.run(`(() => {
      const el = document.activeElement;
      const v = el ? (el.isContentEditable ? el.innerText : el.value) : '';
      return { ok: (v || '').indexOf(${JSON.stringify(text.slice(0, 12))}) >= 0, typed: (v || '').slice(0, 80) };
    })()`);
    if (typed?.ok !== true) throw new Error(`message text did not land in the composer (saw: ${typed?.typed ?? ''})`);
    return typed;
  });

  await recorder.step('send', async () => {
    const button = await browser.run(`rt.locate({ text: ${JSON.stringify(SELECTORS.sendButtonText)} })`);
    if (button && button.found === true) {
      await browser.clickAt(button.rect.x, button.rect.y);
    } else {
      await browser.pressKey('Enter', { code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    await sleep(1_500);
    const after = await browser.run(`(() => {
      const el = document.activeElement;
      const v = el ? (el.isContentEditable ? el.innerText : el.value) : '';
      return { ok: (v || '').trim().length === 0, remaining: (v || '').slice(0, 60) };
    })()`);
    return { emptiedComposer: after?.ok === true, remaining: after?.remaining ?? '' };
  });

  const needle = String(text).slice(0, 16);
  await sleep(1_200);
  const verification = await browser.run(`(() => {
    const body = document.body ? document.body.innerText : '';
    return { ok: body.indexOf(${JSON.stringify(needle)}) >= 0, via: 'conversation-text' };
  })()`);

  return { ok: true, url, steps: recorder.steps, verification };
}

export async function publishNote(browser, { images, title, content, tags } = {}) {
  const recorder = makeRecorder();
  const files = Array.isArray(images) ? images.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];

  await recorder.step('open creator page', async () => {
    await browser.navigate(URLS.creatorPublish, { settleMs: 4_000 });
    const report = await browser.run('rt.page()');
    if (/login|signin/i.test(report?.url ?? '')) throw new Error('creator platform redirected to login; run xhs_login first');
    return report?.url ?? '';
  });

  await recorder.step('upload images', async () => {
    if (files.length === 0) return { skipped: 'no images supplied' };
    await browser.setFileInput(SELECTORS.fileInput, files);
    await waitUntil(browser, `(() => {
      const editor = document.querySelector(${JSON.stringify(SELECTORS.publishEditor)});
      const previews = document.querySelectorAll('img[src^="blob:"], img[src^="http"]').length;
      return { ok: !!editor || previews > 0, previews: previews };
    })()`, { timeoutMs: 120_000, intervalMs: 1_500, label: 'image upload to finish' });
    return { files };
  });

  if (typeof title === 'string' && title.trim().length > 0) {
    await recorder.step('fill title', async () => {
      await typeInto(browser, { css: SELECTORS.titleInput }, title);
      return { length: title.length };
    });
  }

  if (typeof content === 'string' && content.trim().length > 0) {
    await recorder.step('fill body', async () => {
      const body = typeof tags === 'string' && tags.trim().length > 0 ? `${content}\n${tags}` : content;
      const editor = await browser.run(`rt.locate({ css: ${JSON.stringify(SELECTORS.publishEditor)} })`);
      if (!editor || editor.found !== true) throw new Error('no publish editor found');
      await browser.clickAt(editor.rect.x, editor.rect.y);
      await sleep(400);
      await clearActiveElement(browser);
      await browser.insertText(body);
      await sleep(600);
      const typed = await browser.run(`(() => {
        const el = document.activeElement;
        const v = el ? (el.isContentEditable ? el.innerText : el.value) : '';
        return { ok: (v || '').indexOf(${JSON.stringify(body.slice(0, 12))}) >= 0, seen: (v || '').slice(0, 80) };
      })()`);
      if (typed?.ok !== true) throw new Error(`body text did not land in the editor (saw: ${typed?.seen ?? ''})`);
      return typed;
    });
  }

  const publishStep = await recorder.step('submit', async () => {
    const button = await browser.run(`rt.locate({ text: ${JSON.stringify(SELECTORS.publishButtonText)} })`);
    if (!button || button.found !== true) throw new Error('no 发布 button found');
    await browser.clickAt(button.rect.x, button.rect.y);
    await sleep(4_000);
    const report = await browser.run('rt.page()');
    const body = await browser.run('rt.pageText(500)');
    const success = !/publish/i.test(report?.url ?? '') || /发布成功|已发布/.test(body ?? '');
    return { submitted: true, url: report?.url ?? '', success };
  });

  return { ok: true, steps: recorder.steps, submitted: publishStep.submitted, url: publishStep.url };
}
