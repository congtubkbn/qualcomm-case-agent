// scripts/find_case_link.js
//
// PHASE 1 "click the search result" — done browser-side instead of by the agent.
// The manual path costs a full `snapshot -c` of the results page (tens of KB of
// accessibility tree) just to learn one @ref. This returns the case URL plus the
// header fields that live ONLY on the results row (title/status/priority — the
// Feed view has none of them, and scrape_case.mjs rejects an empty title).
//
// Parameter: __CODE (injected by browser.mjs evalFile).
// Rules: one IIFE whose final expression is the result OBJECT (eval runs in
// expression context); never JSON.stringify — agent-browser serializes once.
(function () {
  var CODE = String(typeof __CODE !== 'undefined' ? __CODE : '');
  var txt = function (el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  };
  var qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  if (/\/s\/case\//.test(location.pathname)) {
    return { state: 'ON_CASE', href: location.href, fields: {}, rows: 0 };
  }

  var links = qsa('a[href*="/s/case/"]');
  if (!links.length) return { state: 'NO_LINK', href: '', fields: {}, rows: 0 };

  // Prefer the row that actually mentions the requested code; the global search
  // can return neighbours (related cases, mentions) alongside the exact match.
  var hit = null, row = null;
  for (var i = 0; i < links.length; i++) {
    var r = links[i].closest('tr, li, [role="row"]');
    if (txt(links[i]).indexOf(CODE) >= 0 || (r && txt(r).indexOf(CODE) >= 0)) {
      hit = links[i]; row = r; break;
    }
  }
  var exact = !!hit;
  if (!hit) { hit = links[0]; row = hit.closest('tr, li, [role="row"]'); }

  // Map cells onto header labels — column ORDER is not guaranteed, names are.
  var fields = {};
  var cells = [];
  if (row) {
    cells = qsa('td, th', row).map(txt).filter(Boolean);
    var table = row.closest('table');
    var heads = table ? qsa('thead th, th', table).map(txt) : [];
    var offset = cells.length - heads.length; // leading checkbox/row-number column
    for (var h = 0; h < heads.length; h++) {
      var key = heads[h].toLowerCase();
      var val = cells[h + (offset > 0 ? offset : 0)] || '';
      if (!key || !val || val === CODE) continue;
      if (/subject|title/.test(key)) { if (!fields.title) fields.title = val; }
      else if (/status/.test(key)) { if (!fields.status) fields.status = val; }
      else if (/priority/.test(key)) { if (!fields.priority) fields.priority = val; }
      else if (/severity/.test(key)) { if (!fields.severity) fields.severity = val; }
      else if (/account|customer/.test(key)) { if (!fields.customer) fields.customer = val; }
    }
  }

  // Title is mandatory downstream (scrape_case.mjs exits 5 without one). If the
  // header mapping missed, fall back to the longest descriptive cell.
  if (!fields.title) {
    var best = '';
    for (var c = 0; c < cells.length; c++) {
      var v = cells[c];
      if (v === CODE || v.length < 10 || /^\d/.test(v)) continue;
      if (v.length > best.length) best = v;
    }
    if (best) fields.title = best;
  }

  // Salesforce Lightning search-result anchors carry a generic stub href
  // (`/s/case/Case/Default`); the real SFID route is only reached via the
  // framework's click-delegated router, which requires a TRUSTED click event
  // (CDP/OS-level), not a script-dispatched one and not a plain `open(href)`
  // navigation (both land on the stub). Mark the exact element so the caller
  // can issue a real `agent-browser click` on it without a full snapshot.
  hit.setAttribute('data-cq-hit', '1');
  return { state: 'FOUND', href: hit.href, exact: exact, fields: fields, rows: links.length };
})()
