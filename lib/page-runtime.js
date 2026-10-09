/**
 * In-page runtime.
 *
 * `HELPERS` is plain ES5-ish JavaScript that is prepended to every evaluated
 * operation, so each CDP call is self-contained: no injected-state assumption
 * survives navigation, a re-attach, or a reload. It deliberately avoids
 * backticks and `${` so it can live inside a template literal here.
 *
 * Two facts about xiaohongshu.com shape this code:
 *   - `window.__INITIAL_STATE__` is a Vue store, so most branches are `ref`
 *     objects; `unwrap` follows `__v_isRef` until it reaches real data.
 *   - The store holds circular references, so nothing here may `JSON.stringify`
 *     a state subtree directly. `clip` is depth- and node-bounded instead.
 */

const HELPERS = String.raw`
var rt = (function () {
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1,
    TITLE: 1, HEAD: 1, HTML: 1, BODY: 1, BR: 1, BASE: 1
  };
  function style(el) { try { return getComputedStyle(el); } catch (e) { return null; } }
  function box(el) {
    try { return el.getBoundingClientRect(); } catch (e) { return null; }
  }
  function unwrap(value) {
    var node = value;
    for (var i = 0; node && typeof node === 'object' && node.__v_isRef === true && i < 8; i += 1) {
      node = node.value;
    }
    return node;
  }
  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return false;
    var r = box(el);
    if (!r || r.width < 2 || r.height < 2) return false;
    var s = style(el);
    if (!s) return false;
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    return true;
  }
  function innerText(el) {
    var raw = el.innerText;
    if (raw === undefined || raw === null || raw === '') {
      if (SKIP_TAGS[el.tagName]) return '';
      raw = el.textContent || '';
    }
    return String(raw).replace(/\s+/g, ' ').trim();
  }
  function centre(el) {
    var r = box(el);
    if (!r) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, bottom: r.bottom };
  }
  function inViewport(c) {
    if (!c) return false;
    return c.x >= 0 && c.y >= 0 && c.x <= window.innerWidth && c.y <= window.innerHeight;
  }
  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    return innerText(el).slice(0, 80) ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      '';
  }
  function clickable(el) {
    var node = el;
    for (var i = 0; node && i < 8; i += 1, node = node.parentElement) {
      var tag = node.tagName;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'LABEL') return node;
      if (node.getAttribute('role') === 'button' || node.getAttribute('role') === 'link') return node;
      var s = style(node);
      if (s && s.cursor === 'pointer') return node;
    }
    return el;
  }
  function scrollTo(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
  }
  function all() {
    var nodes = document.querySelectorAll('*');
    var out = [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (!SKIP_TAGS[nodes[i].tagName]) out.push(nodes[i]);
    }
    return out;
  }
  function score(el, target) {
    if (target.text === undefined) return 2;
    var t = innerText(el);
    if (t.length === 0) return -1;
    if (t === target.text) return 0;
    if (t.indexOf(target.text) >= 0) return 1;
    return -1;
  }
  function locate(target) {
    target = target || {};
    var candidates = [];
    if (target.css) {
      try { candidates = Array.prototype.slice.call(document.querySelectorAll(target.css)); } catch (e) { candidates = []; }
    } else if (target.placeholder !== undefined) {
      var ph = target.placeholder;
      candidates = all().filter(function (el) {
        var p = el.getAttribute && el.getAttribute('placeholder');
        return typeof p === 'string' && p.indexOf(ph) >= 0;
      });
    } else if (target.text !== undefined) {
      candidates = all().filter(function (el) { return score(el, target) >= 0; });
    } else {
      return { found: false, reason: 'no locator given' };
    }

    var usable = candidates.filter(visible);
    if (usable.length === 0) {
      return {
        found: false,
        reason: candidates.length === 0 ? 'nothing matched the locator' : 'every match was invisible or zero-sized',
        candidateCount: candidates.length,
        candidateTags: candidates.slice(0, 6).map(function (el) { return el.tagName.toLowerCase(); })
      };
    }

    // Prefer something a click can actually reach. An element rendered outside
    // the viewport (a hidden menu, an oversized carousel slide) has a real
    // bounding box but no reachable screen position.
    var inView = usable.filter(function (el) { return inViewport(centre(el)); });
    var pool = inView.length > 0 ? inView : usable;

    pool.sort(function (a, b) {
      var d = score(a, target) - score(b, target);
      if (d !== 0) return d;
      var ra = box(a), rb = box(b);
      var aa = ra ? ra.width * ra.height : 1e12;
      var ab = rb ? rb.width * rb.height : 1e12;
      return aa - ab;
    });

    var index = typeof target.nth === 'number' ? target.nth : 0;
    if (index < 0 || index >= pool.length) index = 0;
    var chosen = pool[index];
    var hit = target.noClickable ? chosen : clickable(chosen);
    if (!visible(hit)) hit = chosen;
    scrollTo(hit);
    var c = centre(hit);

    var occluded = false, occludedBy = '';
    if (c) {
      try {
        var top = document.elementFromPoint(c.x, c.y);
        if (top && top !== hit && !hit.contains(top) && !top.contains(hit)) {
          occluded = true;
          occludedBy = top.tagName.toLowerCase() + ' ' + describe(top).slice(0, 40);
        }
      } catch (e) { /* elementFromPoint can throw for out-of-viewport points */ }
    }

    return {
      found: true,
      matchCount: usable.length,
      index: index,
      tag: hit.tagName ? hit.tagName.toLowerCase() : '',
      role: hit.getAttribute ? (hit.getAttribute('role') || '') : '',
      text: describe(hit),
      occluded: occluded,
      occludedBy: occludedBy,
      inViewport: inViewport(c),
      rect: c
    };
  }
  function outline(limit) {
    limit = limit || 60;
    var selector = 'a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],label';
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    var out = [];
    for (var i = 0; i < nodes.length && out.length < limit; i += 1) {
      var el = nodes[i];
      if (!visible(el)) continue;
      var c = centre(el);
      if (!c) continue;
      out.push({
        i: out.length,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        editable: el.isContentEditable ? true : false,
        text: describe(el),
        placeholder: el.getAttribute('placeholder') || '',
        x: Math.round(c.x),
        y: Math.round(c.y)
      });
    }
    return out;
  }
  function pageText(limit) {
    limit = limit || 4000;
    var t = document.body ? (document.body.innerText || '') : '';
    return String(t).replace(/\n{3,}/g, '\n\n').slice(0, limit);
  }
  function clip(value, options) {
    options = options || {};
    var maxArray = options.maxArray || 30;
    var maxString = options.maxString || 1200;
    var maxDepth = options.maxDepth || 8;
    var budget = options.maxNodes || 4000;
    function walk(node, depth) {
      if (node === null || node === undefined) return null;
      var t = typeof node;
      if (t === 'string') return node.length > maxString ? node.slice(0, maxString) + '…' : node;
      if (t === 'number' || t === 'boolean') return node;
      if (t === 'function') return undefined;
      if (depth >= maxDepth) return '[depth]';
      budget -= 1;
      if (budget < 0) return '[truncated]';
      if (Array.isArray(node)) {
        var arr = [];
        for (var i = 0; i < node.length && i < maxArray; i += 1) {
          var v = walk(node[i], depth + 1);
          if (v !== undefined) arr.push(v);
        }
        if (node.length > maxArray) arr.push('[+' + (node.length - maxArray) + ' more]');
        return arr;
      }
      if (t === 'object') {
        var o = {};
        var keys = Object.keys(node);
        for (var k = 0; k < keys.length && k < 80; k += 1) {
          var val = walk(node[keys[k]], depth + 1);
          if (val !== undefined) o[keys[k]] = val;
        }
        return o;
      }
      return null;
    }
    try { return walk(value, 0); } catch (e) { return '[unserializable: ' + e.message + ']'; }
  }
  function state() { return window.__INITIAL_STATE__ || null; }
  function pick(path) {
    var node = window.__INITIAL_STATE__;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i += 1) {
      node = unwrap(node);
      if (node === null || node === undefined) return null;
      node = node[parts[i]];
    }
    return unwrap(node);
  }
  function page() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0),
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  }
  function scrollByPx(dx, dy) {
    window.scrollBy({ left: dx || 0, top: dy || 0, behavior: 'instant' });
    return { scrollY: Math.round(window.scrollY) };
  }
  return {
    visible: visible, centre: centre, describe: describe, locate: locate, outline: outline,
    pageText: pageText, clip: clip, state: state, page: page, scrollBy: scrollByPx,
    unwrap: unwrap, pick: pick
  };
})();
window.__xhsRt = rt;
`;

/** Wrap one operation so it re-defines the runtime, then evaluates `body`. */
export function wrapOperation(body) {
  return `(() => {\n${HELPERS}\nreturn (${body});\n})()`;
}

/**
 * Removed before any page script runs. Chrome is also launched with
 * `--disable-blink-features=AutomationControlled`; this closes the remaining
 * `navigator.webdriver` tell. It reduces, not eliminates, automated-session
 * fingerprinting.
 */
export const STEALTH_SOURCE = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
if (!window.chrome) { window.chrome = {}; }
if (!window.chrome.runtime) { window.chrome.runtime = {}; }
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
`;
