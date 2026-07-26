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

  var stillCollapsed = articles.reduce(function (n, art, idx) {
    if (anchorIdx >= 0 && idx >= anchorIdx) return n;
    return /Expand Post\s*$/i.test(bodyOf(art)) ? n + 1 : n;
  }, 0);

  return { stillCollapsed: stillCollapsed };
})()
