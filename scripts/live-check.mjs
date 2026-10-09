/**
 * Live checks against xiaohongshu.com, as whatever the profile is logged in as.
 *
 * Run: node scripts/live-check.mjs
 *
 * Logged out this confirms: the site renders for this browser, the login signal
 * is read from the page store rather than the (anonymous) web_session cookie,
 * and gated pages report a login redirect instead of returning empty data.
 * Logged in it additionally exercises search and note reading end to end.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChromeBrowser } from '../lib/browser.js';
import * as xhs from '../lib/xhs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = new ChromeBrowser({
  debugPort: 9461,
  userDataDir: path.join(here, '.tmp-chrome-live'),
  headless: false,
});

const cut = (value, max = 1_200) => {
  const json = JSON.stringify(value);
  return json === undefined ? 'undefined' : json.slice(0, max);
};
let failures = 0;
const check = (label, condition, detail) => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${cut(detail, 400)}`}`);
};

try {
  await browser.ensure();
  await browser.navigate(xhs.URLS.explore, { settleMs: 4_500 });

  const page = await browser.run('rt.page()');
  check('xiaohongshu.com renders for this browser', /xiaohongshu\.com/.test(page.url) && /小红书/.test(page.title), page);

  const state = await xhs.loginState(browser);
  console.log('loginState →', cut(state, 700));
  check('login is decided by the page store, not the cookie', typeof state.byStore === 'boolean' && typeof state.byNickname === 'boolean');

  const locateLogin = await browser.run('rt.locate({ text: "登录" })');
  check('a text locator resolves a real element (never a <script>)', locateLogin.found === true && locateLogin.tag !== 'script', locateLogin);

  const missing = await browser.run('rt.locate({ text: "no such control zzz" })');
  check('an unmatched locator reports zero candidates', missing.found === false, missing);

  const search = await xhs.searchNotes(browser, '咖啡探店', { limit: 5 });
  console.log('searchNotes →', cut({ ok: search.ok, source: search.source, count: search.items?.length, finalUrl: search.finalUrl }, 500));
  if (state.loggedIn) {
    check('logged in: search returns notes carrying noteId and url', search.ok === true && (search.items ?? []).some((item) => item.noteId && item.url), search.items?.slice(0, 2));
    const target = (search.items ?? []).find((item) => item.url);
    if (target) {
      const note = await xhs.readNote(browser, target.url);
      check('logged in: a searched note reads back with content', note.ok === true && note.note.desc.length > 0, note.ok ? { title: note.note.title, descChars: note.note.desc.length, comments: note.note.comments.length } : note);
    }
  } else {
    // The site is inconsistent: it sometimes redirects a gated page to /login
    // and sometimes serves the page with no results. The contract that matters
    // is that a logged-out read never masquerades as an empty success.
    check(
      'logged out: search fails loudly instead of reporting empty success',
      search.ok === false && (search.items ?? []).length === 0,
      { ok: search.ok, redirectedToLogin: search.redirectedToLogin, finalUrl: search.finalUrl },
    );
    const profile = await xhs.readProfile(browser, '5f6f0a2b000000000101f2f0');
    check('logged out: profile read never reports success', profile.ok === false, { ok: profile.ok, redirectedToLogin: profile.redirectedToLogin, reason: profile.reason });
  }

  const report = await xhs.pageReport(browser, { outlineLimit: 6 });
  check('pageReport returns page, outline and text', report.page !== undefined && Array.isArray(report.outline) && typeof report.text === 'string', { outline: report.outline?.length });

  await browser.dispose();
  console.log(failures === 0 ? 'ALL LIVE CHECKS PASS' : `${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.log('FAILED:', error?.stack ?? error);
  await browser.dispose().catch(() => {});
  process.exitCode = 1;
}
