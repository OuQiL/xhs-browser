/**
 * Tool-definition checks: no browser, no network.
 *
 * Run: node scripts/tools-check.mjs
 *
 * Guards the schema dialect, the write-mode matrix (auto / approve / blocked),
 * the audit trail, and the renderer's handling of file paths versus base64.
 */

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { registerTools } from '../lib/tools.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
};

/** Collect registrations; `browser` and `approval` are supplied per scenario. */
function build(config, browser, approval) {
  const registered = new Map();
  const ctx = {
    get: (name) => (name === 'approval' ? approval : undefined),
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {}; } },
  };
  const disposers = registerTools(ctx, browser, config);
  return { registered, disposers };
}

const stubBrowser = {
  connected: false,
  debugPort: 9333,
  userDataDir: 'x',
  chromePath: undefined,
  headless: false,
  ensure: async () => {},
};

// ---------------------------------------------------------------- registration

const main = build({}, stubBrowser, undefined);
const expected = ['xhs_browser', 'xhs_login', 'xhs_search', 'xhs_note', 'xhs_profile', 'xhs_comment', 'xhs_dm', 'xhs_publish'];
check('registers exactly the 8 intended tools', main.registered.size === 8 && expected.every((n) => main.registered.has(n)), [...main.registered.keys()]);
check('returns one disposer per tool', main.disposers.length === 8, main.disposers.length);
for (const [name, definition] of main.registered) {
  check(`${name}: object-rooted parameter schema`, definition.parameters?.type === 'object' && typeof definition.parameters.properties === 'object');
  check(`${name}: output schema plus renderer`, definition.output?.schema?.type === 'object' && typeof definition.output.render === 'function');
}

check('xhs_comment requires note and text', JSON.stringify(main.registered.get('xhs_comment').parameters.required) === JSON.stringify(['note', 'text']));
check('xhs_publish requires images, title and content', JSON.stringify(main.registered.get('xhs_publish').parameters.required) === JSON.stringify(['images', 'title', 'content']));
check('xhs_dm requires user and text', JSON.stringify(main.registered.get('xhs_dm').parameters.required) === JSON.stringify(['user', 'text']));

// ------------------------------------------------------------------- renderer

const browserRender = main.registered.get('xhs_browser').output.render({ action: 'screenshot' }, { screenshot: '/w/.xhs-shots/shot.png', fullPage: false });
check('xhs_browser render keeps the screenshot path', browserRender[0].text.includes('/w/.xhs-shots/shot.png'));

const loginRender = main.registered.get('xhs_login').output.render({}, { loggedIn: false, screenshot: '/w/.xhs-shots/login.png', instruction: 'scan' });
check('xhs_login render keeps the screenshot path', loginRender[0].text.includes('/w/.xhs-shots/login.png'));

const leak = main.registered.get('xhs_note').output.render({}, { ok: true, screenshot: '/p.png', base64: 'AAAA'.repeat(50), dataUrl: 'data:image/png;base64,AAAA' });
check('render strips real base64 payloads', leak[0].text.includes('/p.png') && !leak[0].text.includes('AAAAAAAA') && !leak[0].text.includes('data:image/png'));

const circular = { ok: true, screenshot: '/c.png' };
circular.self = circular;
check('render survives circular values', main.registered.get('xhs_note').output.render({}, circular)[0].text.includes('[circular]'));

// ------------------------------------------------------------------ write gate

/** A browser whose ensure() fails, so the flow stops before touching any site. */
const failingBrowser = { ...stubBrowser, ensure: async () => { throw new Error('stub browser: not started'); } };
const execFor = (cwd) => ({ agent: { id: 'a', session: { header: { cwd } } } });
const readAudit = (dir) => readFileSync(path.join(dir, '.xhs-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

// auto (default): must not consult the approval service at all, and must audit.
const autoDir = mkdtempSync(path.join(tmpdir(), 'xhs-audit-'));
let approvalConsulted = false;
const auto = build(
  {},
  failingBrowser,
  { request: async () => { approvalConsulted = true; return 'allowed-once'; } },
);
let autoError;
try {
  await auto.registered.get('xhs_comment').execute({ note: 'https://www.xiaohongshu.com/explore/abc', text: '自动化测试评论' }, execFor(autoDir));
} catch (error) {
  autoError = error.message;
}
check('auto mode: never consults the approval service', approvalConsulted === false);
check('auto mode: reaches the browser instead of stopping at a gate', autoError === 'stub browser: not started', autoError);

const auditLines = readAudit(autoDir);
check('auto mode: audit records the attempt before running', auditLines[0]?.phase === 'attempt' && auditLines[0]?.mode === 'auto' && auditLines[0]?.approval === 'not-requested', auditLines[0]);
check('auto mode: audit captures the exact comment text', auditLines[0]?.target?.text === '自动化测试评论' && auditLines[0]?.target?.note.includes('/explore/abc'), auditLines[0]?.target);
check('auto mode: audit records the failure outcome', auditLines[1]?.phase === 'error' && auditLines[1]?.error === 'stub browser: not started', auditLines[1]);
check('auto mode: both audit lines share one writeId', auditLines[0]?.writeId !== undefined && auditLines[0].writeId === auditLines[1]?.writeId, auditLines.map((l) => l.writeId));

// auditLog: false must silence it.
const silentDir = mkdtempSync(path.join(tmpdir(), 'xhs-silent-'));
const silent = build({ auditLog: false }, failingBrowser, undefined);
await silent.registered.get('xhs_dm').execute({ user: 'u1', text: 'hi' }, execFor(silentDir)).catch(() => {});
check('auditLog:false writes no audit file', readdirSync(silentDir).length === 0, readdirSync(silentDir));

// approve: fail-closed when the service is missing.
const approveGate = build({ writeActions: 'approve' }, failingBrowser, undefined);
try {
  await approveGate.registered.get('xhs_comment').execute({ note: 'abc', text: 'hi' }, execFor(mkdtempSync(path.join(tmpdir(), 'xhs-approve-'))));
  check('approve mode refuses without an approval service', false, 'it did not throw');
} catch (error) {
  check('approve mode refuses without an approval service', /approval service is unavailable/.test(error.message), error.message);
}

// approve: a "never" policy surfaces as rejected, and the message names the fix.
const rejectedGate = build({ writeActions: 'approve' }, failingBrowser, { request: async () => 'rejected' });
try {
  await rejectedGate.registered.get('xhs_dm').execute({ user: 'u1', text: 'hi' }, execFor(mkdtempSync(path.join(tmpdir(), 'xhs-reject-'))));
  check('approve mode refuses a rejected ask', false, 'it did not throw');
} catch (error) {
  check('approve mode refuses a rejected ask, and points at writeActions=auto', /outcome: rejected/.test(error.message) && /writeActions to "auto"/.test(error.message), error.message);
}

// blocked: refuses every write, regardless of the approval service.
const blocked = build({ writeActions: 'blocked' }, failingBrowser, { request: async () => 'allowed-once' });
try {
  await blocked.registered.get('xhs_dm').execute({ user: 'u1', text: 'hi' }, execFor(mkdtempSync(path.join(tmpdir(), 'xhs-blocked-'))));
  check('blocked mode refuses every write', false, 'it did not throw');
} catch (error) {
  check('blocked mode refuses every write', /disabled by plugin config/.test(error.message), error.message);
}

// Argument validation must run before the gate, so a malformed call never
// reaches the approval prompt or the audit trail.
try {
  await blocked.registered.get('xhs_publish').execute({ images: ['/definitely/not/here.png'], title: 't', content: 'c' }, execFor(mkdtempSync(path.join(tmpdir(), 'xhs-argfirst-'))));
  check('argument validation precedes the write gate', false, 'it did not throw');
} catch (error) {
  check('argument validation precedes the write gate', /do not exist/.test(error.message), error.message);
}

// An invalid writeActions value falls back to auto.
const bogus = build({ writeActions: 'whatever' }, failingBrowser, { request: async () => { approvalConsulted = true; return 'allowed-once'; } });
approvalConsulted = false;
await bogus.registered.get('xhs_dm').execute({ user: 'u1', text: 'hi' }, execFor(mkdtempSync(path.join(tmpdir(), 'xhs-bogus-')))).catch(() => {});
check('an invalid writeActions value falls back to auto', approvalConsulted === false);

console.log(failures === 0 ? 'ALL TOOL-DEFINITION CHECKS PASS' : `${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
