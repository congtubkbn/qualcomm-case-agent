// scripts/dom_helpers.js
//
// Shared DOM helpers for page scripts (expand_step.js, check_collapsed.js,
// switch_tab.js, login_fill.js). Textually prepended into every eval payload
// by browser.mjs's buildPayload() — NOT imported (no `import`/`export`; page
// scripts run inside the tab via CDP eval, not as ES modules), so these are
// plain `var` declarations that land in the same function scope the payload
// wraps the page script in.
//
// Why this file exists: each page script used to hand-copy its own txt/qsa/
// isVisible/deepByText/fire, and the copies drifted — expand_step.js's
// deepByText scanned shadow roots but skipped the isVisible filter that
// check_collapsed.js's copy already had. Case 08503838 showed the cost: a
// per-post "More comments" button renders inside an LWC shadow root (unlike
// "Expand Post", which sits in plain light DOM), and a caller with the
// non-isVisible-aware copy could act on a hit its sibling script would have
// filtered out. One canonical copy, injected everywhere, means a fix lands
// for every caller at once instead of requiring a hunt across four files.
//
// A page script's own `var txt = ...` (etc.) would silently SHADOW the injected copy — `var`
// redeclaration in the same function scope just keeps the last assignment, no error — which is
// why the hand-copies in expand_step.js/check_collapsed.js/switch_tab.js/login_fill.js had to be
// REMOVED, not just left alongside this file: a leftover local copy would keep winning and this
// consolidation would have zero effect for that script.
var txt = function (el) {
  return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
};

var qsa = function (sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
};

var isVisible = function (el) {
  if (!el) return false;
  var cls = el.className || '';
  if (typeof cls === 'string' && /\b(hidden|fadeOut)\b/i.test(cls)) return false;
  if (el.classList) {
    if (el.classList.contains('hidden') || el.classList.contains('fadeOut')) return false;
  }
  if (el.closest) {
    var hiddenAncestor = el.closest('.hidden, .fadeOut, [style*="display: none"], [style*="display:none"]');
    if (hiddenAncestor) return false;
  }
  if (el.style) {
    if (el.style.display === 'none' || el.style.visibility === 'hidden' || el.style.opacity === '0') return false;
  }
  if (typeof window !== 'undefined' && window.getComputedStyle) {
    try {
      var style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    } catch (e) {}
  }
  if (el.offsetParent === null && (!el.style || el.style.position !== 'fixed')) {
    return false;
  }
  return true;
};

// Shadow-DOM-aware text search, isVisible-aware. Recurses into every
// element's .shadowRoot, not just the light-DOM tree — a plain
// querySelectorAll never pierces a shadow boundary (see case 08503838
// above).
var deepByText = function (sel, re) {
  var out = [];
  (function scan(root) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.matches && el.matches(sel) && re.test(txt(el)) && isVisible(el)) out.push(el);
      if (el.shadowRoot) scan(el.shadowRoot);
    }
  })(document);
  return out;
};

// Plain el.click() can silently no-op on Lightning/Aura controls whose real
// handler listens for pointer/mouse events rather than the synthetic click
// event .click() dispatches. Fire the fuller event sequence a real
// interaction produces, then .click() too as a harmless belt-and-suspenders
// fallback.
var fire = function (el) {
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
    try {
      var Ctor = (/^pointer/.test(type) && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
    } catch (e) { /* Ctor unsupported in this environment — click() below still fires */ }
  });
  el.click();
};

// A post's comment body lives in one of a few Chatter markup shapes; fall
// back to the article itself when none of them is present.
var bodyOf = function (a) {
  var b = a.querySelector(".feedBodyInner, .cuf-feedBodyText, [class*='feedBody']");
  return txt(b || a);
};

// Locate the cached anchor post. Match on a 40-char body prefix: relative
// timestamps ("2 days ago") drift between runs, body text does not.
var findAnchorIdx = function (articles, anchor) {
  var anchorIdx = -1;
  if (anchor && anchor.bodyStart) {
    var needle = String(anchor.bodyStart).replace(/\s+/g, ' ').trim().slice(0, 40);
    for (var i = 0; i < articles.length && needle; i++) {
      if (bodyOf(articles[i]).indexOf(needle) === 0) { anchorIdx = i; break; }
    }
  }
  return anchorIdx;
};

// Cached-and-below-the-anchor is the only skip; a post absent from the run's
// baseline was revealed by a "More comments" click and counts wherever it
// sits. `!baseline` is a null-safety guard for a caller that runs before the
// baseline is initialized — currently unreachable (expand_step.js's __PROBE
// tick always sets window.__qcExpandBaseline before any caller needs it) but
// kept as cheap insurance against a future change to that call order.
var skipAsCached = function (idx, anchorIdx, baseline, prefixes) {
  if (!(anchorIdx >= 0 && idx >= anchorIdx)) return false;
  return !baseline || baseline.indexOf(prefixes[idx]) >= 0;
};
