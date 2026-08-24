// fast_landing.mjs — Deep Module: Direct Nav + Event-Driven Search & Landing Engine.
// Provides fast-path direct navigation for cached cases and in-page observer for Lightning DOM.

export const STUB_PATH_RE = /\/s\/case\/Case\/Default(?:$|[/?#])/i;

/**
 * Checks if a URL is empty or points to the generic Lightning un-routed case stub.
 * @param {string} [url]
 * @returns {boolean}
 */
export function isStubUrl(url) {
  if (!url || typeof url !== 'string') return true;
  try {
    const parsed = new URL(url);
    return STUB_PATH_RE.test(parsed.pathname);
  } catch {
    return STUB_PATH_RE.test(url);
  }
}

/**
 * In-page script that evaluates page state or uses MutationObserver to wait for ON_CASE / AUTH.
 */
const IN_PAGE_OBSERVE_SCRIPT = `
(function() {
  var timeout = typeof __TIMEOUT !== 'undefined' ? __TIMEOUT : 15000;
  var code = typeof __CODE !== 'undefined' ? String(__CODE) : '';

  function checkState() {
    if (location.hostname === 'account.qualcomm.com') {
      return { state: 'AUTH', url: location.href };
    }
    if (location.pathname.indexOf('/s/case/') >= 0 && location.pathname.indexOf('/s/case/Case/Default') === -1) {
      return { state: 'ON_CASE', href: location.href };
    }
    return null;
  }

  var immediate = checkState();
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
      var last = checkState();
      if (last) resolve(last);
      else resolve({ state: 'TIMEOUT', href: location.href });
    }, timeout);

    pollTimer = setInterval(function() {
      var res = checkState();
      if (res) {
        cleanup();
        resolve(res);
      }
    }, 500);

    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(function() {
        var res = checkState();
        if (res) {
          cleanup();
          resolve(res);
        }
      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    }
  });
})()
`;

/**
 * In-page script that waits for search results to render and extracts fields & link info.
 */
const IN_PAGE_SEARCH_SCRIPT = `
(function() {
  var timeout = typeof __TIMEOUT !== 'undefined' ? __TIMEOUT : 25000;
  var code = typeof __CODE !== 'undefined' ? String(__CODE) : '';

  var txt = function (el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
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
        if (v === code || v.length < 10 || /^\\d/.test(v)) continue;
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
`;

/**
 * Fast-path direct navigation and event-driven landing engine.
 * @param {string} code 8-digit Qualcomm case code (e.g. "08603854")
 * @param {Object} options
 * @param {import('./cdp_client.mjs').CdpClient} options.cdp Active CDP client
 * @param {Object} [options.cached] Cached case metadata (caseUrl, url, title, fields)
 * @param {string} [options.portalUrl='https://support.qualcomm.com']
 * @param {number} [options.timeout=25000]
 * @returns {Promise<{
 *   state: 'OK' | 'AUTH' | 'NOT_FOUND' | 'BLOCKED' | 'STUB',
 *   href: string,
 *   fields: Record<string, string>,
 *   fastPathUsed: boolean,
 *   durationMs: number,
 *   url?: string,
 *   reason?: string,
 *   diagnostics?: string[]
 * }>}
 */
export async function fastLandOnCase(code, options = {}) {
  const {
    cdp,
    cached,
    portalUrl = 'https://support.qualcomm.com',
    timeout = 25000,
  } = options;

  const start = performance.now();
  const caseUrl = cached?.caseUrl || cached?.url;
  const baseUrl = portalUrl.replace(/\/+$/, '');
  const diagnostics = [];

  const logDiag = (msg) => {
    diagnostics.push(msg);
    process.stderr.write(`[fast_landing] ${msg}\n`);
  };

  // 1. Fast Path: Direct Navigation if cached case URL is known and valid
  if (caseUrl && !isStubUrl(caseUrl)) {
    logDiag(`Attempting direct navigation to cached URL: ${caseUrl}`);
    try {
      await cdp.navigate(caseUrl, { waitUntil: 'load', timeout: Math.min(timeout, 25000) });

      const probe = await cdp.eval(
        IN_PAGE_OBSERVE_SCRIPT,
        { __CODE: code, __TIMEOUT: Math.min(timeout, 15000) },
        { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
      );

      const durationMs = Math.round(performance.now() - start);

      if (probe?.state === 'ON_CASE' && !isStubUrl(probe.href || caseUrl)) {
        logDiag(`Direct navigation succeeded in ${durationMs}ms (state=ON_CASE, href=${probe.href || caseUrl})`);
        return {
          state: 'OK',
          href: probe.href || caseUrl,
          fields: {
            title: cached?.title || cached?.fields?.title || '',
            status: cached?.status || cached?.fields?.status || '',
            priority: cached?.priority || cached?.fields?.priority || '',
            ...(cached?.fields || {}),
          },
          fastPathUsed: true,
          durationMs,
          diagnostics,
        };
      }

      if (probe?.state === 'AUTH') {
        logDiag(`Direct navigation redirected to AUTH: ${probe.url}`);
        return {
          state: 'AUTH',
          href: '',
          fields: {},
          fastPathUsed: true,
          durationMs,
          url: probe.url || '',
          diagnostics,
        };
      }

      const reason = probe?.state ? `state was '${probe.state}'` : 'did not reach ON_CASE';
      logDiag(`Direct navigation to ${caseUrl} inconclusive (${reason}). Falling back to global search.`);
    } catch (err) {
      logDiag(`Direct navigation error for ${caseUrl}: ${err.message}. Falling back to global search.`);
    }
  } else if (caseUrl && isStubUrl(caseUrl)) {
    logDiag(`Cached URL ${caseUrl} is generic stub. Falling back directly to global search.`);
  } else {
    logDiag(`No cached URL available for case ${code}. Proceeding with global search.`);
  }

  // 2. Fallback Path / Search for New Case
  const searchUrl = `${baseUrl}/s/global-search/${code}`;
  logDiag(`Navigating to global search: ${searchUrl}`);
  try {
    await cdp.navigate(searchUrl, { waitUntil: 'load', timeout: Math.min(timeout, 25000) });

    const searchProbe = await cdp.eval(
      IN_PAGE_SEARCH_SCRIPT,
      { __CODE: code, __TIMEOUT: Math.min(timeout, 25000) },
      { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
    );

    const durationMs = Math.round(performance.now() - start);

    if (searchProbe?.state === 'AUTH') {
      logDiag(`Global search redirected to AUTH: ${searchProbe.url}`);
      return {
        state: 'AUTH',
        href: '',
        fields: {},
        fastPathUsed: false,
        durationMs,
        url: searchProbe.url || '',
        diagnostics,
      };
    }

    if (searchProbe?.state === 'ON_CASE' && !isStubUrl(searchProbe.href)) {
      logDiag(`Search URL immediately landed ON_CASE: ${searchProbe.href}`);
      return {
        state: 'OK',
        href: searchProbe.href,
        fields: searchProbe.fields || {},
        fastPathUsed: false,
        durationMs,
        diagnostics,
      };
    }

    if (searchProbe?.state === 'FOUND') {
      const fields = searchProbe.fields || {};
      logDiag(`Search found candidate case link: ${searchProbe.href} (exact=${searchProbe.exact}, rows=${searchProbe.rows})`);

      // Case A: href is resolved to a real SFID URL
      if (searchProbe.href && !isStubUrl(searchProbe.href)) {
        try {
          logDiag(`Navigating directly to resolved case URL from search: ${searchProbe.href}`);
          await cdp.navigate(searchProbe.href, { waitUntil: 'load', timeout: Math.min(timeout, 15000) });
          const navProbe = await cdp.eval(
            IN_PAGE_OBSERVE_SCRIPT,
            { __CODE: code, __TIMEOUT: Math.min(timeout, 5000) },
            { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
          );

          if (navProbe?.state === 'AUTH') {
            logDiag(`Navigation to resolved search URL redirected to AUTH: ${navProbe.url}`);
            return {
              state: 'AUTH',
              href: '',
              fields,
              fastPathUsed: false,
              durationMs: Math.round(performance.now() - start),
              url: navProbe.url || '',
              diagnostics,
            };
          }

          if (navProbe?.state === 'ON_CASE' && !isStubUrl(navProbe.href || searchProbe.href)) {
            const finalHref = navProbe.href || searchProbe.href;
            logDiag(`Landed ON_CASE via search link direct navigation: ${finalHref}`);
            return {
              state: 'OK',
              href: finalHref,
              fields,
              fastPathUsed: false,
              durationMs: Math.round(performance.now() - start),
              diagnostics,
            };
          }
          logDiag(`Navigation to ${searchProbe.href} did not settle ON_CASE (state=${navProbe?.state}). Attempting in-page click fallback.`);
        } catch (err) {
          logDiag(`Navigation to ${searchProbe.href} threw error (${err.message}). Attempting in-page click fallback.`);
        }
      }

      // Case B: href is stub or direct nav didn't route past stub -> trusted click
      try {
        logDiag(`Dispatching trusted click on search result element [data-cq-hit='1']`);
        await cdp.click("[data-cq-hit='1']");
        const clickProbe = await cdp.eval(
          IN_PAGE_OBSERVE_SCRIPT,
          { __CODE: code, __TIMEOUT: Math.min(timeout, 5000) },
          { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
        );

        if (clickProbe?.state === 'AUTH') {
          logDiag(`Trusted click redirected to AUTH: ${clickProbe.url}`);
          return {
            state: 'AUTH',
            href: '',
            fields,
            fastPathUsed: false,
            durationMs: Math.round(performance.now() - start),
            url: clickProbe.url || '',
            diagnostics,
          };
        }

        if (clickProbe?.state === 'ON_CASE' && !isStubUrl(clickProbe.href)) {
          logDiag(`Landed ON_CASE via trusted click: ${clickProbe.href}`);
          return {
            state: 'OK',
            href: clickProbe.href,
            fields,
            fastPathUsed: false,
            durationMs: Math.round(performance.now() - start),
            diagnostics,
          };
        }
        logDiag(`Trusted click completed but page did not reach ON_CASE (state=${clickProbe?.state})`);
      } catch (err) {
        logDiag(`Trusted click attempt failed: ${err.message}`);
      }

      return {
        state: 'STUB',
        href: '',
        fields,
        fastPathUsed: false,
        durationMs: Math.round(performance.now() - start),
        reason: 'Navigation never routed past Lightning stub after search',
        diagnostics,
      };
    }

    if (searchProbe?.state === 'NO_LINK') {
      const reason = searchProbe.reason || `Search returned no case links for ${code}`;
      logDiag(`Global search returned NO_LINK (${reason})`);
      return {
        state: 'NOT_FOUND',
        href: '',
        fields: {},
        fastPathUsed: false,
        durationMs,
        reason,
        diagnostics,
      };
    }
  } catch (err) {
    logDiag(`Search navigation/evaluation failed: ${err.message}`);
  }

  const finalDurationMs = Math.round(performance.now() - start);
  return {
    state: 'NOT_FOUND',
    href: '',
    fields: {},
    fastPathUsed: false,
    durationMs: finalDurationMs,
    reason: `Search returned no case links for code ${code}`,
    diagnostics,
  };
}

