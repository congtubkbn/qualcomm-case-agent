// scripts/check_collapsed.js
//
// Pure read: how many non-anchor posts still end in the "Expand Post" label
// right now. Deliberately does NOT click anything — expand_step.js's fire()
// (synthetic pointer/mouse events + .click()) has an observable side effect
// on this control even though it never actually expands it (Aura's real
// handler appears to require a trusted, real click — see run_case.mjs's
// post-expand-loop settle retry): calling fire() measurably changes what the
// body text reads on the SAME tick, which made a settle-check reusing
// expand_step.js self-poison its own reading (observed: case 08417053,
// settling always read 0 right after expand_step.js fired, even though a
// completely passive read of the identical DOM the same instant reported 3).
// This script exists purely so the settle-check can get an honest read.
//
// Parameter: __ANCHOR — same shape as expand_step.js; posts at/after the
// anchor are old cached posts that are SUPPOSED to stay collapsed and must
// not count here.
(function () {
  var ANCHOR = (typeof __ANCHOR !== 'undefined') ? __ANCHOR : null;

  var txt = function (el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  };
  var qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };
  var bodyOf = function (a) {
    var b = a.querySelector(".feedBodyInner, .cuf-feedBodyText, [class*='feedBody']");
    return txt(b || a);
  };

  var articles = qsa('article');

  var anchorIdx = -1;
  if (ANCHOR && ANCHOR.bodyStart) {
    var needle = String(ANCHOR.bodyStart).replace(/\s+/g, ' ').trim().slice(0, 40);
    for (var i = 0; i < articles.length && needle; i++) {
      if (bodyOf(articles[i]).indexOf(needle) === 0) { anchorIdx = i; break; }
    }
  }

  // Mirror expand_step.js's skip rule exactly, or the settle check would keep
  // demanding clicks for posts expand_step.js deliberately never clicks (or,
  // worse, stay quiet about a revealed reply it DOES click). Cached-and-below-
  // the-anchor is the only skip; a post absent from the run's baseline was
  // revealed by a "More comments" click and counts wherever it sits.
  var baseline = window.__qcExpandBaseline || null;
  var prefixes = articles.map(function (a) { return bodyOf(a).slice(0, 60); });
  var skipAsCached = function (idx) {
    if (!(anchorIdx >= 0 && idx >= anchorIdx)) return false;
    return !baseline || baseline.indexOf(prefixes[idx]) >= 0;
  };

  var stillCollapsed = articles.reduce(function (n, art, idx) {
    if (skipAsCached(idx)) return n;
    return /Expand Post\s*$/i.test(bodyOf(art)) ? n + 1 : n;
  }, 0);

  // Same class of issue as "Expand Post": fire()'s synthetic events can no-op
  // on the per-post "N more comments" nested-reply pagination link too, and
  // unlike Expand Post this had NO settle-check at all — a click that never
  // actually loaded the reply looked identical to "nothing left to expand"
  // (observed: case 08503838, a reply dropped out of case.json with no error).
  //
  // The REAL cause of that drop (confirmed live, 2026-07-30, case 08503838):
  // this control renders as `<button class="slds-button">More comments</button>`
  // inside an LWC shadow root, unlike "Expand Post" which sits in plain light
  // DOM. Plain `document.querySelectorAll` never pierces a shadow boundary, so
  // this read reported 0 while 4 fully-rendered, unclicked buttons sat on
  // screen (7 real comments never captured, on a run that verified clean).
  // Must mirror expand_step.js's deepByText exactly, or the settle-check and
  // the tick loop disagree about what's still hidden.
  var deepByText = function (sel, re) {
    var out = [];
    (function scan(root) {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.matches && el.matches(sel) && re.test(txt(el))) out.push(el);
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    })(document);
    return out;
  };
  var stillHasMoreComments = deepByText('a, button', /^(view\s+)?\d*\s*more\s+comments?$/i).length;

  return { stillCollapsed: stillCollapsed, stillHasMoreComments: stillHasMoreComments };
})()
