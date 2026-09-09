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

  var articles = qsa('article');

  // bodyOf/findAnchorIdx/skipAsCached are shared (see dom_helpers.js) — this
  // mirrors expand_step.js's skip rule exactly, or the settle check would
  // keep demanding clicks for posts expand_step.js deliberately never clicks
  // (or, worse, stay quiet about a revealed reply it DOES click).
  var anchorIdx = findAnchorIdx(articles, ANCHOR);
  var baseline = window.__qcExpandBaseline || null;
  var prefixes = articles.map(function (a) { return bodyOf(a).slice(0, 60); });

  var isArticleCollapsed = function (art) {
    if (!art) return false;
    var controls = qsa('.cuf-more, [class*="cuf-more"], a, button', art).filter(function (el) {
      return (el.className && /\bcuf-more\b/.test(el.className)) || /^Expand Post$/i.test(txt(el));
    });
    for (var i = 0; i < controls.length; i++) {
      if (isVisible(controls[i])) return true;
    }
    return false;
  };

  var stillCollapsed = articles.reduce(function (n, art, idx) {
    if (skipAsCached(idx, anchorIdx, baseline, prefixes)) return n;
    return isArticleCollapsed(art) ? n + 1 : n;
  }, 0);

  // deepByText (shared, see dom_helpers.js) must mirror expand_step.js's
  // exactly, or the settle-check and the tick loop disagree about what's
  // still hidden.
  var stillHasMoreComments = deepByText('a, button', /^(view\s+)?\d*\s*more\s+comments?$/i).length;

  return { stillCollapsed: stillCollapsed, stillHasMoreComments: stillHasMoreComments };
})()
