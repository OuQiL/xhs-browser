# Xiaohongshu (RED) Browser — DSH plugin

Lets the agent operate a real, logged-in Xiaohongshu session: search, read notes,
post a comment, send a direct message, and publish an image note.

It drives a normal visible Chrome through the DevTools Protocol. There is **no
bundled headless browser and no third-party dependency** — Node's built-in
`WebSocket` and `fetch` are the whole transport.

---

## Read this before using it

**Xiaohongshu's terms prohibit automated operation.** Scripted login, posting,
commenting, and messaging put the account at risk of rate limiting, reduced
reach, or a ban. Some of that is not reversible. Prefer a secondary account
until you trust the behaviour.

**There is a hard scope boundary.** This plugin does one human-reviewed action
per call: one comment, one message, one note. It deliberately has no bulk mode,
no mass messaging, no comment flooding, and no follow/unfollow automation.
Mass unsolicited messaging is spam and is not a configuration away — it would
require new code.

**Writes run unattended by default.** The plugin ships with
`writeActions: auto`, so a comment, message, or note is published as soon as the
agent calls the tool — no confirmation prompt. Set `writeActions: approve` to
route every write through the DSH approval service instead (it is fail-closed:
a missing service, or a session approval policy of `never`, refuses the write).
`writeActions: blocked` refuses everything.

Because nothing is reviewed in `auto` mode, **every write is recorded**. An
append-only `.xhs-audit.jsonl` in the session workspace gets one line before the
action runs (exact text, recipient, image paths, mode) and one after (outcome,
failing step, final URL), sharing a `writeId`. The attempt line is written
before the flow starts, so an interrupted run still leaves a record of what it
was about to post. This is deliberately not a gate — it never blocks a write,
even if logging fails.

**Detection is reduced, not eliminated.** Chrome is launched with
`--disable-blink-features=AutomationControlled`, `navigator.webdriver` is
deleted on every new document, and the traffic is a real browser with a real
profile — the site rendered fully with no challenge during development. That is
not a guarantee.

---

## Installation

Already installed in the `desktop` profile as bundle `@local/xhs-browser`
(symlinked from this directory). To reinstall elsewhere:

```
plugin_manager action=install_bundle target="<absolute path to this directory>"
```

The row is `xhs-browser`; toggle it with
`plugin_manager action=set_plugin target=include:xhs-browser enabled=<bool>`.

> **Module reload caveat.** DSH keeps ESM modules for the lifetime of the
> process, so editing these files while DSH runs does **not** change live
> behaviour — the cached generation keeps serving. Restart DSH to load a new
> generation. Toggling the plugin row does not defeat the module cache.

## Logging in

1. `xhs_login` — opens Chrome on xiaohongshu.com and reports login state.
2. Scan the QR code with the Xiaohongshu app in the Chrome window that opened.
3. `xhs_login` again to confirm.

The session lives in the plugin's own Chrome profile
(`$DSH_HOME/xhs-browser/chrome-profile` by default), so it is isolated from your
everyday browsing and survives restarts. A dedicated profile is also required,
not just nice to have: Chrome 136+ ignores `--remote-debugging-port` for the
default profile directory.

If Chrome is already open on that profile **without** the debug port, a second
launch just hands off to it and the port never opens. The plugin detects this
and says so; close that window and retry.

## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `xhs_browser` | driver | `status` / `start` / `stop` / `goto` / `snapshot` / `outline` / `screenshot` / `click` / `type` / `press` / `scroll` / `text` |
| `xhs_login` | — | Open the login page, report login state, save a screenshot |
| `xhs_search` | read | Keyword search → note id, title, author, likes, and a URL carrying `xsec_token` |
| `xhs_note` | read | One note: body, author, engagement, tags, image URLs, comments and replies |
| `xhs_profile` | read | A user's profile and their notes |
| `xhs_comment` | **write** | One comment, optionally a reply to an existing comment |
| `xhs_dm` | **write** | One direct message, via the recipient's profile |
| `xhs_publish` | **write** | One image-and-text note via the creator platform |

Write tools publish unattended under the default `auto` mode. Their schemas
carry the full payload, so one tool call is one complete action — there is no
partial or multi-target form.

### Audit trail

`.xhs-audit.jsonl` in the session workspace, one JSON object per line:

```json
{"time":"2026-10-09T11:24:57.851Z","writeId":"mv0vp0my-chz11q","tool":"xhs_comment","mode":"auto","approval":"not-requested","phase":"attempt","target":{"note":"https://www.xiaohongshu.com/explore/abc","text":"…","replyTo":null}}
{"time":"2026-10-09T11:24:57.853Z","writeId":"mv0vp0my-chz11q","tool":"xhs_comment","phase":"result","ok":true,"url":"…"}
```

`phase` is `attempt`, then `result` or `error`. Pair the lines by `writeId`.

`click` / `type` take a locator: `css=…`, `text=…` (visible text), `ph=…`
(placeholder), or a bare string treated as visible text. `nth` picks among
matches. These are escape hatches for when a high-level tool breaks because the
site changed.

Screenshots are written to `<session workspace>/.xhs-shots/` and the tool result
contains the file path, so the file can be opened directly.

## Configuration

Set on the plugin row (see `cordis.patch.yml`). Unknown keys are ignored with a
warning; invalid values fall back to the default.

| Key | Default | Meaning |
|---|---|---|
| `chromePath` | `''` | Explicit path to `chrome.exe` / `msedge.exe`. Empty auto-detects. |
| `debugPort` | `9333` | Local DevTools port for the dedicated Chrome instance. |
| `userDataDir` | `''` | Chrome profile directory. Empty → `$DSH_HOME/xhs-browser/chrome-profile`. |
| `headless` | `false` | Leave false: QR login needs a window, and headless is easier to detect. |
| `writeActions` | `'auto'` | `auto` runs writes immediately; `approve` requires a DSH approval grant per write; `blocked` refuses all writes. |
| `auditLog` | `true` | Append every write attempt and outcome to `.xhs-audit.jsonl` in the session workspace. |

The plugin deliberately declares **no `Config` export**. A workspace-authored
bundle is loaded from its own directory, so a bare specifier such as
`@deepseek-ai/schemastery` cannot resolve from the dsh installation — it fails
with `ERR_MODULE_NOT_FOUND` and the whole row reports "failed to import".
Settings are therefore read from the raw row config and normalised in
`index.js`.

## Architecture

```
index.js              plugin entry: export apply/inject/name, config normalisation, teardown
lib/cdp.js            zero-dependency DevTools Protocol client (flat sessions, event waiters)
lib/browser.js        Chrome discovery/launch/attach, navigation, input, screenshots, file upload
lib/page-runtime.js   in-page runtime prepended to every evaluation; stealth patch source
lib/xhs.js            site layer: extractors and the write flows
lib/tools.js          tool registration, approval gate, diagnostics
scripts/              standalone checks (see below)
```

Two decisions worth knowing:

**Reads prefer the page's own `window.__INITIAL_STATE__` over DOM scraping.** It
is the payload the web app renders from, so it survives class-name churn far
better than selectors. Two consequences are handled explicitly: the store is a
Vue tree, so most branches are `ref` objects that must be unwrapped; and it
contains circular references, so it may never be `JSON.stringify`-ed directly —
`rt.clip` is depth- and node-bounded instead.

**Writes are step lists that report the failing step.** A broken selector yields
the step name, the page URL, an interactive-element outline, the visible text,
and a screenshot rather than an opaque timeout.

## Verification status

Honest split between what has been proven and what has not.

**Proven on this machine**

- Chrome launches headful from the DSH host process and CDP attaches; the
  browser re-attaches to an already-running instance without relaunching.
- `xiaohongshu.com` renders fully in this profile with a working QR login modal
  and no bot challenge; the store's real key structure was read live
  (`user.loggedIn`, `login.showLogin`, `feed.feeds`, `search.feeds`,
  `note.noteDetailMap`).
- Clicking fires real DOM handlers; typing lands in both `<input>` and
  `contenteditable` elements, including CJK text.
- Occlusion and off-viewport targeting are detected and reported rather than
  silently clicking the wrong thing.
- Login state is decided by the page store. The `web_session` cookie is
  **also issued to logged-out visitors**, so a cookie-only check reports a
  logged-in session that does not exist — that bug existed and was caught here.
- Logged-out reads fail loudly instead of returning empty success.
- The write-mode matrix: `auto` never consults the approval service and does
  reach the browser; `approve` fails closed with no service and on a `rejected`
  ask; `blocked` refuses regardless; an invalid value falls back to `auto`.
- The audit trail records the exact payload and the outcome, joined by
  `writeId`; `auditLog: false` writes nothing; argument validation runs before
  the gate.
- `scripts/tools-check.mjs`, `scripts/interaction-check.mjs`, and
  `scripts/live-check.mjs` all pass.

**Not proven — needs a logged-in session**

- `xhs_search` / `xhs_note` / `xhs_profile` success paths. Their extractors are
  written against the live store shapes actually observed (`feed.feeds` ref →
  array of items carrying `id`, `noteCard`, `xsecToken`), but no logged-in read
  has been executed.
- All three write flows: `xhs_comment`, `xhs_dm`, `xhs_publish`. The approval
  gate, the fail-closed path, and every underlying input primitive are verified;
  the site-specific selectors (comment box, 发送 button, 私信 control,
  creator-platform upload and 发布) are best-effort and are the most likely
  thing to need adjustment. Run one write, read the returned step list, and fix
  the offending selector in `SELECTORS` at the top of `lib/xhs.js`.

Run the checks yourself:

```
node scripts/tools-check.mjs          # no browser, no network
node scripts/interaction-check.mjs    # local fixture page
node scripts/live-check.mjs           # live site, logged in or out
```

They launch their own Chrome on ports 9460/9461 with throwaway profiles under
`scripts/.tmp-chrome-*`. Kill any leftover windows from those profiles before
re-running, or the relaunch will hand off to the running instance.

## Known limitations

- Selectors and routes change without notice; expect to maintain `lib/xhs.js`.
- Note URLs need a `xsec_token`. A bare note id usually will not load; use the
  URL returned by `xhs_search`.
- `Input.insertText` composes text directly. If the site ever requires real
  per-key events for a field, switch that field to `Input.dispatchKeyEvent`.
- `xhs_publish` assumes images are local absolute paths and uploads them through
  the page's file input.
- One browser window is shared state: if you click around in it while the agent
  works, expect surprises.
