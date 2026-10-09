/**
 * Xiaohongshu (RED) browser plugin — Host half.
 *
 * Registers `xhs_*` tools that drive a real, logged-in Chrome over the DevTools
 * Protocol. Everything irreversible is gated by the Host approval service, so
 * the user sees and approves the exact comment text, recipient, or note before
 * anything is sent.
 *
 * This plugin declares no `Config` export and imports nothing outside `node:`
 * builtins on purpose. A workspace-authored bundle is loaded from its own
 * directory, so a bare specifier such as `@deepseek-ai/schemastery` cannot be
 * resolved from the dsh installation: it fails with ERR_MODULE_NOT_FOUND and
 * the whole row reports "failed to import". Settings are therefore read from
 * the raw row config and defaulted here.
 *
 * @module @local/xhs-browser
 */

import { ChromeBrowser } from './lib/browser.js';
import { registerTools } from './lib/tools.js';

export const name = 'xhs-browser';

/** One tool registry is the only hard dependency; approval is requested optionally. */
export const inject = ['tools'];

const DEFAULTS = {
  chromePath: '',
  debugPort: 9333,
  userDataDir: '',
  headless: false,
  writeActions: 'auto',
  auditLog: true,
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));
const WRITE_MODES = new Set(['auto', 'approve', 'blocked']);

/** Defaults plus a light type check; unknown keys are reported, not fatal. */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS };
  const warnings = [];

  if (source.chromePath !== undefined) {
    if (typeof source.chromePath === 'string') config.chromePath = source.chromePath;
    else warnings.push('chromePath must be a string; using the auto-detected browser');
  }
  if (source.debugPort !== undefined) {
    if (Number.isFinite(source.debugPort) && source.debugPort > 0 && source.debugPort < 65536) {
      config.debugPort = Math.trunc(source.debugPort);
    } else {
      warnings.push(`debugPort must be a port number; using ${DEFAULTS.debugPort}`);
    }
  }
  if (source.userDataDir !== undefined) {
    if (typeof source.userDataDir === 'string') config.userDataDir = source.userDataDir;
    else warnings.push('userDataDir must be a string; using the default profile directory');
  }
  if (source.headless !== undefined) {
    if (typeof source.headless === 'boolean') config.headless = source.headless;
    else warnings.push('headless must be a boolean; using false');
  }
  if (source.writeActions !== undefined) {
    if (WRITE_MODES.has(source.writeActions)) config.writeActions = source.writeActions;
    else warnings.push('writeActions must be "auto", "approve" or "blocked"; using "auto"');
  }
  if (source.auditLog !== undefined) {
    if (typeof source.auditLog === 'boolean') config.auditLog = source.auditLog;
    else warnings.push('auditLog must be a boolean; using true');
  }
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown config key "${key}" was ignored`);
  }

  return { config, warnings };
}

export function apply(ctx, rawConfig = {}) {
  const { config, warnings } = normalizeConfig(rawConfig);
  for (const warning of warnings) {
    ctx.logger?.warn?.(`[xhs-browser] ${warning}`);
  }

  const browser = new ChromeBrowser({
    chromePath: config.chromePath.length > 0 ? config.chromePath : undefined,
    debugPort: config.debugPort,
    userDataDir: config.userDataDir.length > 0 ? config.userDataDir : undefined,
    headless: config.headless,
  });

  const disposers = registerTools(ctx, browser, config);

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* one failing disposer must not strand the rest */
      }
    }
    void browser.dispose();
  });
}
