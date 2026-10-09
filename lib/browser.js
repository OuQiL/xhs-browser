/**
 * Chrome lifecycle and page control.
 *
 * The browser is a normal, visible Chrome running against a dedicated user
 * data directory, so the Xiaohongshu session is separate from the user's
 * everyday browsing profile and can be logged in once by scanning a QR code.
 * Chrome 136+ refuses `--remote-debugging-port` for the default profile, which
 * is another reason the dedicated directory is required rather than optional.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { CdpConnection, CdpError, fetchVersion } from './cdp.js';
import { STEALTH_SOURCE, wrapOperation } from './page-runtime.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
  process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
  process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
];

export function findChromePath(explicit) {
  const candidates = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  throw new Error(
    'no Chromium browser found; set the plugin config `chromePath` to chrome.exe or msedge.exe',
  );
}

export function defaultUserDataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(homedir(), '.dsh');
  return path.join(home, 'xhs-browser', 'chrome-profile');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChromeBrowser {
  constructor(options = {}) {
    this.chromePath = options.chromePath;
    this.debugPort = options.debugPort ?? 9333;
    this.host = '127.0.0.1';
    this.userDataDir = options.userDataDir ?? defaultUserDataDir();
    this.headless = options.headless === true;
    this.windowSize = options.windowSize ?? '1440,960';
    this.connection = undefined;
    this.sessionId = undefined;
    this.targetId = undefined;
    this.launchedByUs = false;
  }

  get connected() {
    return this.connection !== undefined && this.connection.closed === false && this.sessionId !== undefined;
  }

  // ---------------------------------------------------------------- lifecycle

  async ensure() {
    if (this.connected) return this;
    let version;
    try {
      version = await fetchVersion(this.debugPort, { host: this.host, timeoutMs: 1_200 });
    } catch {
      version = undefined;
    }
    if (version === undefined) {
      await this.#launch();
      try {
        version = await fetchVersion(this.debugPort, { host: this.host });
      } catch (error) {
        throw new Error(
          `${error.message}. If Chrome is already open with this profile (${this.userDataDir}) but without --remote-debugging-port=${this.debugPort}, ` +
            'close that window and retry: a second launch only hands off to the running instance instead of opening the port.',
        );
      }
    }
    this.connection = await CdpConnection.open(version.webSocketDebuggerUrl, { timeoutMs: 20_000 });
    await this.#attachPage();
    return this;
  }

  async #launch() {
    const chromePath = findChromePath(this.chromePath);
    mkdirSync(this.userDataDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.debugPort}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
      '--disable-sync',
      '--disable-background-networking',
      '--lang=zh-CN',
      `--window-size=${this.windowSize}`,
      '--window-position=80,60',
      ...(this.headless ? ['--headless=new'] : []),
      'about:blank',
    ];
    const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    this.launchedByUs = true;
  }

  async #attachPage() {
    const { targetInfos } = await this.connection.send('Target.getTargets');
    const pages = (targetInfos ?? []).filter((target) => target.type === 'page');
    const preferred =
      pages.find((target) => /xiaohongshu\.com/.test(target.url ?? '')) ??
      pages.find((target) => (target.url ?? '') === 'about:blank') ??
      pages[0];
    const targetId = preferred?.targetId ?? (await this.connection.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const attached = await this.connection.send('Target.attachToTarget', { targetId, flatten: true });
    this.targetId = targetId;
    this.sessionId = attached.sessionId;
    await this.sendPage('Page.enable', {});
    await this.sendPage('Runtime.enable', {});
    await this.sendPage('DOM.enable', {});
    await this.sendPage('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SOURCE }).catch(() => undefined);
    await this.sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => undefined);
  }

  /** Send a page-scoped command, re-attaching once if the session went stale. */
  async sendPage(method, params = {}, { timeoutMs, retries = 1 } = {}) {
    if (this.connection === undefined) throw new Error('browser is not started; call xhs_browser action=start first');
    try {
      return await this.connection.send(method, params, { sessionId: this.sessionId, timeoutMs });
    } catch (error) {
      const stale =
        error instanceof CdpError &&
        typeof error.message === 'string' &&
        /Session with given id not found|Target closed|Not attached|detached/i.test(error.message);
      if (!stale || retries <= 0) throw error;
      this.sessionId = undefined;
      await this.#attachPage();
      return this.sendPage(method, params, { timeoutMs, retries: retries - 1 });
    }
  }

  // ------------------------------------------------------------------- page IO

  async evaluate(expression, { timeoutMs = 30_000, awaitPromise = true } = {}) {
    const result = await this.sendPage(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
      { timeoutMs },
    );
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      const text =
        detail.exception?.description ??
        detail.exception?.value ??
        detail.text ??
        'unknown page evaluation error';
      throw new Error(`page evaluation failed: ${String(text).split('\n')[0]}`);
    }
    return result.result?.value;
  }

  /** Evaluate one operation against the injected in-page runtime. */
  async run(body, options) {
    return this.evaluate(wrapOperation(body), options);
  }

  async url() {
    const page = await this.run('rt.page()');
    return page?.url ?? '';
  }

  async navigate(url, { timeoutMs = 45_000, settleMs = 2_500 } = {}) {
    const loaded = this.connection
      .waitFor('Page.loadEventFired', { sessionId: this.sessionId, timeoutMs })
      .catch(() => undefined);
    await this.sendPage('Page.navigate', { url }, { timeoutMs });
    await loaded;
    await sleep(settleMs);
    return this.run('rt.page()');
  }

  async screenshot({ fullPage = false } = {}) {
    const result = await this.sendPage(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: fullPage },
      { timeoutMs: 30_000 },
    );
    return result.data;
  }

  async clickAt(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.sendPage('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
    await this.sendPage('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await sleep(40);
    await this.sendPage('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    await sleep(150);
  }

  async insertText(text) {
    await this.sendPage('Input.insertText', { text });
    await sleep(120);
  }

  async pressKey(key, { code, windowsVirtualKeyCode, modifiers = 0 } = {}) {
    const keyCode = windowsVirtualKeyCode ?? key.toUpperCase().charCodeAt(0) ?? 13;
    await this.sendPage('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: code ?? key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await this.sendPage('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: code ?? key,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await sleep(150);
  }

  /** Attach local files to a file input by absolute path. */
  async setFileInput(selector, files) {
    const { root } = await this.sendPage('DOM.getDocument', { depth: 1 });
    const { nodeId } = await this.sendPage('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no file input matched selector ${selector}`);
    await this.sendPage('DOM.setFileInputFiles', { nodeId, files });
    return true;
  }

  async closePage() {
    if (this.targetId !== undefined) {
      await this.connection?.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
      this.targetId = undefined;
      this.sessionId = undefined;
    }
  }

  async dispose() {
    this.sessionId = undefined;
    this.targetId = undefined;
    if (this.connection !== undefined) {
      this.connection.close('browser disposed');
      this.connection = undefined;
    }
    this.launchedByUs = false;
  }
}
