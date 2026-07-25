// scripts/expand_step.js
//
// PHASE 1.5 (A and B) as ONE browser-side tick, called in a loop from
// run_case.mjs. The manual path is snapshot -> read refs -> click -> snapshot,
// once per control: on a 9-post case that is ~15 accessibility-tree dumps the
// model has to read. Here the clicking happens in the page and only a small
// counters object crosses the wire.
//
// Parameter: __ANCHOR (injected by browser.mjs evalFile)
//   null            -> 1.5A full expansion: paginate to the end, expand everything.
//   {author, bodyStart} -> 1.5B incremental: stop paginating once the newest CACHED
//                      comment is on screen, and expand only the posts above it.
//
// Round 0 doubles as the fast "no update" probe: it reports `displayed`, the top
// post's author/bodyStart and `anchorIdx` before anything has been clicked.
(function () {
  var ANCHOR = (typeof __ANCHOR !== 'undefined') ? __ANCHOR : null;
  var PROBE = (typeof __PROBE !== 'undefined') ? __PROBE : false;

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
  var byText = function (sel, re) {
    return qsa(sel).filter(function (e) { return re.test(txt(e)); });
  };
  // Plain `el.click()` can silently no-op on Lightning/Aura controls whose real
  // handler listens for pointer/mouse events rather than the synthetic click
  // event .click() dispatches — observed as the same "Expand Post" label
  // getting re-clicked tick after tick without ever actually expanding. Fire
  // the fuller event sequence a real interaction produces, then .click() too
  // as a harmless belt-and-suspenders fallback.
  var fire = function (el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
      try {
        var Ctor = (/^pointer/.test(type) && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
      } catch (e) { /* Ctor unsupported in this environment — click() below still fires */ }
    });
    el.click();
  };

  var articles = qsa('article');

  // Locate the cached anchor post. Match on a 40-char body prefix: relative
  // timestamps ("2 days ago") drift between runs, body text does not.
  var anchorIdx = -1;
  if (ANCHOR && ANCHOR.bodyStart) {
    var needle = String(ANCHOR.bodyStart).replace(/\s+/g, ' ').trim().slice(0, 40);
    for (var i = 0; i < articles.length && needle; i++) {
      if (bodyOf(articles[i]).indexOf(needle) === 0) { anchorIdx = i; break; }
    }
  }

  var displayed = null;
  var st = qsa("[role='status']").filter(function (s) { return /Chatter Feed Item/i.test(txt(s)); })[0];
  if (st) { var m = txt(st).match(/(\d+)/); displayed = m ? Number(m[1]) : null; }

  var top = articles[0]
    ? { author: txt(articles[0].querySelector('a')), bodyStart: bodyOf(articles[0]).slice(0, 80) }
    : null;

  var result = {
    articles: articles.length,
    displayed: displayed,
    anchorIdx: anchorIdx,
    top: top,
    clickedExpand: 0,
    clickedViewMore: 0,
    clickedDescription: 0,
    remainingExpand: 0,
  };
  if (PROBE) return result;

  // Expand posts. Incremental run: only those ABOVE the anchor — old posts stay
  // collapsed and the --merge dedupe keeps their cached verbatim bodies.
  byText('a, button', /^Expand Post$/i).forEach(function (e) {
    var art = e.closest('article');
    var idx = art ? articles.indexOf(art) : -1;
    if (anchorIdx >= 0 && idx >= anchorIdx) { result.remainingExpand++; return; }
    fire(e);
    result.clickedExpand++;
  });

  // Pagination: one "View More Posts" per tick (each click loads a page), and
  // only while the anchor is still off-screen.
  if (anchorIdx < 0) {
    var more = byText('button, a', /^View More/i)[0];
    if (more) { fire(more); result.clickedViewMore = 1; }
  }

  // Description panel is a full-run concern — on an update run it is cached.
  if (!ANCHOR) {
    var desc = byText('button', /^Description$/i).filter(function (b) {
      return b.getAttribute('aria-expanded') === 'false';
    })[0];
    if (desc) { fire(desc); result.clickedDescription = 1; }
  }

  return result;
})()
