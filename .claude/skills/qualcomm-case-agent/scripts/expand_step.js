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
  // Shadow-DOM-aware version of byText. Confirmed live (2026-07-30, case
  // 08503838): the per-post "More comments" pagination button renders as a
  // real `<button class="slds-button">More comments</button>` — but inside an
  // LWC's shadow root, unlike "Expand Post" which sits in plain light DOM.
  // Plain `document.querySelectorAll('a, button')` never pierces a shadow
  // boundary, so it silently found 0 of these buttons every run while they
  // sat fully rendered and unclicked on screen (verified against capture.png:
  // 4 unclicked "More comments" buttons, 7 real comments never captured, on a
  // run that reported pendingMoreComments: 0). Recurse into every element's
  // .shadowRoot, not just the light-DOM tree.
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

  // Trigger LWC IntersectionObserver: Chatter lazy-mounts nested components 
  // (like "More comments") only when the parent article enters the viewport.
  // CDP doesn't trigger scroll naturally, so we force them into view.
  articles.forEach(function (a) {
    try { a.scrollIntoView({ behavior: 'instant', block: 'nearest' }); } catch(e) {}
  });

  // Locate the cached anchor post. Match on a 40-char body prefix: relative
  // timestamps ("2 days ago") drift between runs, body text does not.
  var anchorIdx = -1;
  if (ANCHOR && ANCHOR.bodyStart) {
    var needle = String(ANCHOR.bodyStart).replace(/\s+/g, ' ').trim().slice(0, 40);
    for (var i = 0; i < articles.length && needle; i++) {
      if (bodyOf(articles[i]).indexOf(needle) === 0) { anchorIdx = i; break; }
    }
  }

  // Same strict badge parse as extract_case.js: the count must PRECEDE the
  // phrase. Chatter's per-item "Chatter Feed Item <n>" status region otherwise
  // reads back as a bogus feed total (see extract_case.js).
  var displayed = null;
  var statuses = qsa("[role='status']");
  for (var si = 0; si < statuses.length; si++) {
    var m = txt(statuses[si]).match(/(\d+)\s+Chatter\s+Feed\s+Items?\b/i);
    if (m) { displayed = Number(m[1]); break; }
  }

  var top = articles[0]
    ? { author: txt(articles[0].querySelector('a')), bodyStart: bodyOf(articles[0]).slice(0, 80) }
    : null;

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

  // Filter expand controls to genuinely visible and active controls inside an article.
  var expandControls = qsa('.cuf-more, [class*="cuf-more"], a, button')
    .filter(function (e) {
      var isExpandText = /^Expand Post$/i.test(txt(e));
      var isCufMore = e.className && /\bcuf-more\b/.test(e.className);
      if (!isExpandText && !isCufMore) return false;
      if (!e.closest('article')) return false;
      return isVisible(e);
    })
    .filter(function (e, idx, arr) {
      return !arr.some(function (other) {
        if (other === e) return false;
        if (other.contains) return other.contains(e);
        var p = e.parentElement || e.parent;
        while (p) {
          if (p === other) return true;
          p = p.parentElement || p.parent;
        }
        return false;
      });
    });
  // Nested-reply pagination is NEVER anchor-skipped: a reply added to an OLD
  // post renders as an <article> BELOW the anchor, so skipping it there is how
  // a new reply stays invisible to every update run (case 08503838).
  var moreCommentControls = deepByText('a, button', /^(view\s+)?\d*\s*more\s+comments?$/i).filter(isVisible);

  // Baseline = the posts on screen BEFORE this run expanded anything, kept on
  // `window` across ticks (same tab, no reload mid-expansion). PROBE ticks keep
  // refreshing it while the feed lazy-loads; the first clicking tick freezes it.
  // A post that is NOT in the baseline was revealed by a "More comments" click
  // this run — i.e. it is new content, so it must be expanded even though it
  // sits below the anchor. Without this, the anchor skip (which exists so old
  // cached bodies are never re-extracted and re-identified) would also swallow
  // every freshly revealed reply.
  var prefixes = articles.map(function (a) { return bodyOf(a).slice(0, 60); });
  if (PROBE || !window.__qcExpandBaseline) window.__qcExpandBaseline = prefixes.slice();
  var baseline = window.__qcExpandBaseline;

  var skipAsCached = function (e) {
    var art = e.closest('article');
    var idx = art ? articles.indexOf(art) : -1;
    if (!(anchorIdx >= 0 && idx >= anchorIdx)) return false;
    return baseline.indexOf(prefixes[idx]) >= 0;
  };

  var result = {
    articles: articles.length,
    displayed: displayed,
    anchorIdx: anchorIdx,
    top: top,
    // Controls that still hide content THIS run is responsible for. The PROBE
    // tick reports them before clicking anything, which is what lets the fast
    // no-update check refuse to call a feed unchanged while content is hidden.
    pendingExpand: expandControls.filter(function (e) { return !skipAsCached(e); }).length,
    pendingMoreComments: moreCommentControls.length,
    clickedExpand: 0,
    clickedViewMore: 0,
    clickedDescription: 0,
    clickedMoreComments: 0,
    remainingExpand: 0,
  };
  if (PROBE) return result;

  // Expand posts. Incremental run: only those ABOVE the anchor — old posts stay
  // collapsed and the --merge dedupe keeps their cached verbatim bodies.
  expandControls.forEach(function (e) {
    if (skipAsCached(e)) { result.remainingExpand++; return; }
    fire(e);
    result.clickedExpand++;
  });

  // Per-post nested-reply pagination ("More comments" under a post's Like/
  // Comment row). Unlike "View More Posts" this is scoped to one post's
  // thread, not a whole-feed page load, so all currently-visible instances
  // are safe to click in the same tick — new replies it reveals (and any of
  // their own truncated bodies) get picked up by next tick's re-run.
  moreCommentControls.forEach(function (e) {
    fire(e);
    result.clickedMoreComments++;
  });

  // Pagination: one "View More Posts" per tick (each click loads a page), and
  // only while the anchor is still off-screen.
  if (anchorIdx < 0) {
    var more = byText('button, a', /^View More/i)[0];
    if (more) { fire(more); result.clickedViewMore = 1; }
  }

  // Description panel is a full-run concern — on an update run it is cached.
  if (!ANCHOR) {
    var desc = deepByText('button', /^Description$/i).filter(function (b) {
      return b.getAttribute('aria-expanded') === 'false';
    })[0];
    if (desc) { fire(desc); result.clickedDescription = 1; }
  }

  return result;
})()
