/**
 * Interaction primitives, isolated from any real site.
 *
 * Run: node scripts/interaction-check.mjs
 *
 * Proves that locate/click/type/occlusion/viewport behaviour is correct on its
 * own, so a failure against xiaohongshu.com can be attributed to the site
 * rather than to the driver.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ChromeBrowser } from '../lib/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = new ChromeBrowser({
  debugPort: 9460,
  userDataDir: path.join(here, '.tmp-chrome-interaction'),
  headless: false,
});

const show = (value) => JSON.stringify(value);
let failures = 0;
const check = (label, condition, detail) => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${show(detail)}`}`);
};

try {
  await browser.ensure();
  await browser.navigate(pathToFileURL(path.join(here, 'fixture.html')).href, { settleMs: 700 });

  const press = await browser.run('rt.locate({ text: "Press Me" })');
  check('locate prefers the in-viewport match', press.found === true && press.inViewport === true && press.rect.x < 1440, press);

  await browser.clickAt(press.rect.x, press.rect.y);
  check('a real click fires the DOM handler', (await browser.run('window.state.clicked')) === 1);

  const input = await browser.run('rt.locate({ css: "#a" })');
  await browser.clickAt(input.rect.x, input.rect.y);
  await browser.insertText('你好 hello 123');
  check('typed text lands in an <input>', (await browser.run('document.querySelector("#a").value')) === '你好 hello 123');

  const editable = await browser.run('rt.locate({ css: "#ed" })');
  await browser.clickAt(editable.rect.x, editable.rect.y);
  await browser.insertText('富文本内容');
  check('typed text lands in a contenteditable', ((await browser.run('document.querySelector("#ed").innerText')) || '').includes('富文本内容'));

  const overlayButton = await browser.run('rt.locate({ css: "#over" })');
  await browser.clickAt(overlayButton.rect.x, overlayButton.rect.y);
  check('overlay shown by a real click', (await browser.run('window.state.overlayShown')) === 1);
  const occluded = await browser.run('rt.locate({ text: "Press Me" })');
  check('locate reports occlusion under the overlay', occluded.found === true && occluded.occluded === true, occluded);

  const hide = await browser.run('rt.locate({ text: "Hide Overlay" })');
  check("the overlay's own button is reachable", hide.found === true && hide.occluded !== true, hide);
  await browser.clickAt(hide.rect.x, hide.rect.y);
  check('click dismissed the overlay', (await browser.run('document.querySelector("#overlay").style.display')) === 'none');

  const deep = await browser.run('rt.locate({ css: "#deep" })');
  check('scrolled a below-the-fold element into view', deep.found === true && deep.inViewport === true, deep);

  const outline = await browser.run('rt.outline(30)');
  const tags = [...new Set((outline || []).map((entry) => entry.tag))];
  check('outline lists interactive elements only', (outline || []).length > 4 && !tags.includes('script'), { count: outline.length, tags });

  const missing = await browser.run('rt.locate({ text: "no such control zzz" })');
  check('an unmatched locator reports zero candidates, not a script tag', missing.found === false && missing.candidateCount === 0, missing);

  const circular = await browser.run('(() => { const o = { name: "x" }; o.self = o; return rt.clip(o, { maxDepth: 6 }); })()');
  check('clip survives a circular object', circular && circular.name === 'x', circular);

  await browser.dispose();
  console.log(failures === 0 ? 'ALL INTERACTION CHECKS PASS' : `${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  console.log('FAILED:', error?.stack ?? error);
  await browser.dispose().catch(() => {});
  process.exitCode = 1;
}
