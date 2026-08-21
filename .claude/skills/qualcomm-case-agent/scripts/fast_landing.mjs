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
  var timeout = typeof __TIMEOUT !== 'undefined' ? __TIMEOUT : 5000;
  var code = typeof __CODE !== 'undefined' ? String(__CODE) : '';

  function checkState() {
    if (location.hostname === 'account.qualcomm.com') {
      return { state: 'AUTH', url: location.href };
    }
    if (location.pathname.indexOf('/s/case/') >= 0 && !/\\/s\\/case\\/Case\\/Default/i.test(location.pathname)) {
      return { state: 'ON_CASE', href: location.href };
    }
    return null;
  }

  var immediate = checkState();
  if (immediate) return Promise.resolve(immediate);

  return new Promise(function(resolve) {
    var timer = null;
    var observer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (observer) observer.disconnect();
    }

    timer = setTimeout(function() {
      cleanup();
      var last = checkState();
      if (last) resolve(last);
      else resolve({ state: 'TIMEOUT', href: location.href });
    }, timeout);

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
  var timeout = typeof __TIMEOUT !== 'undefined' ? __TIMEOUT : 8000;
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
    if (location.pathname.indexOf('/s/case/') >= 0 && !/\\/s\\/case\\/Case\\/Default/i.test(location.pathname)) {
      return { state: 'ON_CASE', href: location.href, fields: {} };
    }

    var links = qsa('a[href*="/s/case/"]');
    if (!links.length) return null;

    var hit = null, row = null;
    for (var i = 0; i < links.length; i++) {
      var r = links[i].closest('tr, li, [role="row"]');
      if (txt(links[i]).indexOf(code) >= 0 || (r && txt(r).indexOf(code) >= 0)) {
        hit = links[i]; row = r; break;
      }
    }
    var exact = !!hit;
    if (!hit) { hit = links[0]; row = hit.closest('tr, li, [role="row"]'); }

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
        else if (/account|customer/.test(key)) { if (!fields.customer) fields.customer = val; }
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
      rows: links.length
    };
  }

  var immediate = checkSearch();
  if (immediate) return Promise.resolve(immediate);

  return new Promise(function(resolve) {
    var timer = null;
    var observer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (observer) observer.disconnect();
    }

    timer = setTimeout(function() {
      cleanup();
      var last = checkSearch();
      if (last) resolve(last);
      else resolve({ state: 'NO_LINK', href: '', fields: {}, rows: 0 });
    }, timeout);

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
 * @param {number} [options.timeout=10000]
 * @returns {Promise<{
 *   state: 'OK' | 'AUTH' | 'NOT_FOUND' | 'BLOCKED' | 'STUB',
 *   href: string,
 *   fields: Record<string, string>,
 *   fastPathUsed: boolean,
 *   durationMs: number,
 *   url?: string,
 *   reason?: string
 * }>}
 */
export async function fastLandOnCase(code, options = {}) {
  const {
    cdp,
    cached,
    portalUrl = 'https://support.qualcomm.com',
    timeout = 10000,
  } = options;

  const start = performance.now();
  const caseUrl = cached?.caseUrl || cached?.url;
  const baseUrl = portalUrl.replace(/\/+$/, '');

  // 1. Fast Path: Direct Navigation if cached case URL is known and valid
  if (caseUrl && !isStubUrl(caseUrl)) {
    try {
      await cdp.navigate(caseUrl);

      const probe = await cdp.eval(
        IN_PAGE_OBSERVE_SCRIPT,
        { __CODE: code, __TIMEOUT: Math.min(timeout, 5000) },
        true
      );

      const durationMs = Math.round(performance.now() - start);

      if (probe?.state === 'ON_CASE' && !isStubUrl(probe.href || caseUrl)) {
        return {
          state: 'OK',
          href: probe.href || caseUrl,
          fields: cached?.fields || (cached?.title ? { title: cached.title } : {}),
          fastPathUsed: true,
          durationMs,
        };
      }

      if (probe?.state === 'AUTH') {
        return {
          state: 'AUTH',
          href: '',
          fields: {},
          fastPathUsed: true,
          durationMs,
          url: probe.url || '',
        };
      }
    } catch {
      // Fall through if direct nav fails or errors out
    }
  }

  // 2. Fallback Path / Search for New Case
  const searchUrl = `${baseUrl}/s/global-search/${code}`;
  try {
    await cdp.navigate(searchUrl);

    const searchProbe = await cdp.eval(
      IN_PAGE_SEARCH_SCRIPT,
      { __CODE: code, __TIMEOUT: Math.min(timeout, 8000) },
      true
    );

    const durationMs = Math.round(performance.now() - start);

    if (searchProbe?.state === 'AUTH') {
      return {
        state: 'AUTH',
        href: '',
        fields: {},
        fastPathUsed: false,
        durationMs,
        url: searchProbe.url || '',
      };
    }

    if (searchProbe?.state === 'ON_CASE' && !isStubUrl(searchProbe.href)) {
      return {
        state: 'OK',
        href: searchProbe.href,
        fields: searchProbe.fields || {},
        fastPathUsed: false,
        durationMs,
      };
    }

    if (searchProbe?.state === 'FOUND') {
      const fields = searchProbe.fields || {};

      // Case A: href is resolved to a real SFID URL
      if (searchProbe.href && !isStubUrl(searchProbe.href)) {
        try {
          await cdp.navigate(searchProbe.href);
          const navProbe = await cdp.eval(
            IN_PAGE_OBSERVE_SCRIPT,
            { __CODE: code, __TIMEOUT: Math.min(timeout, 5000) },
            true
          );

          if (navProbe?.state === 'AUTH') {
            return {
              state: 'AUTH',
              href: '',
              fields,
              fastPathUsed: false,
              durationMs: Math.round(performance.now() - start),
              url: navProbe.url || '',
            };
          }

          if (navProbe?.state === 'ON_CASE' && !isStubUrl(navProbe.href || searchProbe.href)) {
            return {
              state: 'OK',
              href: navProbe.href || searchProbe.href,
              fields,
              fastPathUsed: false,
              durationMs: Math.round(performance.now() - start),
            };
          }
        } catch {
          // Fall through to click fallback
        }
      }

      // Case B: href is stub or direct nav didn't route past stub -> trusted click
      try {
        await cdp.click("[data-cq-hit='1']");
        const clickProbe = await cdp.eval(
          IN_PAGE_OBSERVE_SCRIPT,
          { __CODE: code, __TIMEOUT: Math.min(timeout, 5000) },
          true
        );

        if (clickProbe?.state === 'AUTH') {
          return {
            state: 'AUTH',
            href: '',
            fields,
            fastPathUsed: false,
            durationMs: Math.round(performance.now() - start),
            url: clickProbe.url || '',
          };
        }

        if (clickProbe?.state === 'ON_CASE' && !isStubUrl(clickProbe.href)) {
          return {
            state: 'OK',
            href: clickProbe.href,
            fields,
            fastPathUsed: false,
            durationMs: Math.round(performance.now() - start),
          };
        }
      } catch {
        // Fall through to STUB return
      }

      return {
        state: 'STUB',
        href: '',
        fields,
        fastPathUsed: false,
        durationMs: Math.round(performance.now() - start),
        reason: 'Navigation never routed past Lightning stub after search',
      };
    }
  } catch {
    // Search navigation or evaluation failed
  }

  const finalDurationMs = Math.round(performance.now() - start);
  return {
    state: 'NOT_FOUND',
    href: '',
    fields: {},
    fastPathUsed: false,
    durationMs: finalDurationMs,
    reason: 'Search returned no case links',
  };
}
