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

  // 2. Fallback indicator (when not using fast-path or fast-path missed)
  const durationMs = Math.round(performance.now() - start);
  return {
    state: 'NOT_FOUND',
    href: '',
    fields: {},
    fastPathUsed: false,
    durationMs,
    reason: 'Fast path not applicable or failed to resolve ON_CASE',
  };
}
