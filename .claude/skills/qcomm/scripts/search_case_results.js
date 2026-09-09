// scripts/search_case_results.js
//
// In-page script that waits for global-search results to render and extracts
// the matching case link plus whatever fields (title/status/priority/severity)
// can be read off the result row.
//
// Parameters (injected by caller / buildPayload):
//   __CODE     (string, required) - case code to match against link text/row text
//   __TIMEOUT  (number, optional) - max wait timeout in ms (default 25000)
//
// Returns:
//   { state: 'AUTH', url: string }
//   | { state: 'ON_CASE', href: string, fields: {} }
//   | { state: 'FOUND', href: string, exact: boolean, fields: object, rows: number }
//   | { state: 'NO_LINK', href: '', fields: {}, rows: number, reason: string }

(function() {
  var timeout = typeof __TIMEOUT !== 'undefined' ? __TIMEOUT : 25000;
  var code = typeof __CODE !== 'undefined' ? String(__CODE) : '';

  var txt = function (el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  };
  var qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function checkSearch() {
    if (location.hostname === 'account.qualcomm.com') {
      return { state: 'AUTH', url: location.href };
    }
    if (location.pathname.indexOf('/s/case/') >= 0 && location.pathname.indexOf('/s/case/Case/Default') === -1) {
      return { state: 'ON_CASE', href: location.href, fields: {} };
    }

    var nonStubLinks = qsa('a[href*="/s/case/"]').filter(function(a) {
      return a.href.indexOf('/s/case/Case/Default') === -1;
    });

    var hit = null, row = null;
    for (var i = 0; i < nonStubLinks.length; i++) {
      var r = nonStubLinks[i].closest('tr, li, [role="row"]');
      if (txt(nonStubLinks[i]).indexOf(code) >= 0 || (r && txt(r).indexOf(code) >= 0)) {
        hit = nonStubLinks[i]; row = r; break;
      }
    }
    var exact = !!hit;
    if (!hit && nonStubLinks.length > 0) {
      hit = nonStubLinks[0];
      row = hit.closest('tr, li, [role="row"]');
    }

    if (!hit) {
      return null;
    }

    var fields = {};
    var cells = [];
    if (row) {
      cells = qsa('td, th', row).map(txt).filter(Boolean);
      var table = row.closest('table');
      var heads = table ? qsa('thead th, th', table).map(txt) : [];
      var offset = cells.length - heads.length;
      for (var h = 0; h < heads.length; h++) {
        var key = heads[h].toLowerCase();
        var val = cells[h + (offset > 0 ? offset : 0)] || '';
        if (!key || !val || val === code) continue;
        if (/subject|title/.test(key)) { if (!fields.title) fields.title = val; }
        else if (/status/.test(key)) { if (!fields.status) fields.status = val; }
        else if (/priority/.test(key)) { if (!fields.priority) fields.priority = val; }
        else if (/severity/.test(key)) { if (!fields.severity) fields.severity = val; }
      }
    }

    if (!fields.title) {
      var best = '';
      for (var c = 0; c < cells.length; c++) {
        var v = cells[c];
        if (v === code || v.length < 10 || /^\d/.test(v)) continue;
        if (v.length > best.length) best = v;
      }
      if (best) fields.title = best;
    }

    qsa('[data-cq-hit]').forEach(function (el) { el.removeAttribute('data-cq-hit'); });
    hit.setAttribute('data-cq-hit', '1');
    hit.removeAttribute('target');

    return {
      state: 'FOUND',
      href: hit.href,
      exact: exact,
      fields: fields,
      rows: nonStubLinks.length
    };
  }

  var immediate = checkSearch();
  if (immediate) return Promise.resolve(immediate);

  return new Promise(function(resolve) {
    var timer = null;
    var pollTimer = null;
    var observer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (observer) observer.disconnect();
    }

    timer = setTimeout(function() {
      cleanup();
      var last = checkSearch();
      if (last) resolve(last);
      else resolve({ state: 'NO_LINK', href: '', fields: {}, rows: 0, reason: 'Timeout waiting for search results to render' });
    }, timeout);

    pollTimer = setInterval(function() {
      var res = checkSearch();
      if (res) {
        cleanup();
        resolve(res);
      }
    }, 500);

    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(function() {
        var res = checkSearch();
        if (res) {
          cleanup();
          resolve(res);
        }
      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    }
  });
})()
