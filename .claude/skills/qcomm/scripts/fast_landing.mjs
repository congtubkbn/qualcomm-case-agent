import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPassword, clearSecret } from './secret_store.mjs';

export const STUB_PATH_RE = /\/s\/case\/Case\/Default(?:$|[/?#])/i;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DOM_EXTRACTOR_SCRIPT = readFileSync(join(scriptDir, 'dom_extractor.js'), 'utf8');

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fast-path direct navigation and event-driven landing engine.
 * @param {string} code 8-digit Qualcomm case code (e.g. "08603854")
 * @param {Object} options
 * @param {import('./cdp_client.mjs').CdpClient} options.cdp Active CDP client
 * @param {Object} [options.cached] Cached case metadata (caseUrl, url, title, fields)
 * @param {string} [options.portalUrl='https://support.qualcomm.com']
 * @param {number} [options.timeout=25000]
 * @param {number} [options.fillRetryLimit=3]
 * @param {string} [options.secretPath]
 * @param {string} [options.username]
 * @param {number} [options.otpTimeoutMs=300000]
 * @param {number} [options.otpPollIntervalMs=2000]
 * @returns {Promise<{
 *   state: 'OK' | 'AUTH' | 'NOT_FOUND' | 'BLOCKED' | 'STUB' | 'OTP_TIMEOUT',
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
    fillRetryLimit = 3,
    secretPath,
    username,
    otpTimeoutMs = 300000,
    otpPollIntervalMs = 2000,
  } = options;

  const start = performance.now();
  const caseUrl = cached?.caseUrl || cached?.url;
  const baseUrl = portalUrl.replace(/\/+$/, '');
  const diagnostics = [];
  let authFillAttempted = false;

  const logDiag = (msg) => {
    diagnostics.push(msg);
    process.stderr.write(`[fast_landing] ${msg}\n`);
  };

  async function handleAuth(authUrl, fastPathUsed) {
    if (authFillAttempted) {
      logDiag(`AUTH state re-encountered after fill already attempted. Returning manual AUTH.`);
      return {
        state: 'AUTH',
        href: '',
        fields: {},
        fastPathUsed,
        durationMs: Math.round(performance.now() - start),
        url: authUrl || '',
        diagnostics,
      };
    }

    authFillAttempted = true;
    const pw = readPassword(secretPath);
    if (!pw) {
      logDiag(`Direct navigation redirected to AUTH: ${authUrl} (no stored secret found)`);
      return {
        state: 'AUTH',
        href: '',
        fields: {},
        fastPathUsed,
        durationMs: Math.round(performance.now() - start),
        url: authUrl || '',
        diagnostics,
      };
    }

    logDiag(`AUTH state detected; attempting password autofill (retry limit: ${fillRetryLimit})...`);
    let lastOutcome = 'UNKNOWN';
    for (let attempt = 1; attempt <= fillRetryLimit; attempt++) {
      let fillRes = null;
      try {
        fillRes = await cdp.eval(
          DOM_EXTRACTOR_SCRIPT,
          {
            __ACTION: 'loginFill',
            __PASSWORD: pw,
            __USERNAME: username || null,
            __TIMEOUT: Math.min(timeout, 10000),
          },
          { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
        );
      } catch (err) {
        fillRes = { outcome: 'UNKNOWN', reason: err.message };
      }

      lastOutcome = fillRes?.outcome || 'UNKNOWN';
      logDiag(`Autofill attempt ${attempt}/${fillRetryLimit} outcome: ${lastOutcome}`);

      if (lastOutcome === 'AUTHENTICATED') {
        logDiag(`Password autofill succeeded on attempt ${attempt}. Proceeding.`);
        return { handled: true };
      }

      if (lastOutcome === 'REJECTED') {
        logDiag(`Password rejected by Okta. Clearing stored secret.`);
        clearSecret(secretPath);
        return {
          state: 'AUTH',
          reason: 'password-rejected',
          href: '',
          fields: {},
          fastPathUsed,
          durationMs: Math.round(performance.now() - start),
          url: authUrl || '',
          diagnostics,
        };
      }

      if (lastOutcome === 'OTP_REQUIRED') {
        logDiag(`Password accepted; OTP is required. Waiting for human to enter OTP (timeout: ${otpTimeoutMs}ms, interval: ${otpPollIntervalMs}ms)...`);
        const otpDeadline = Date.now() + otpTimeoutMs;
        while (Date.now() < otpDeadline) {
          await sleep(otpPollIntervalMs);
          let pollRes = null;
          try {
            pollRes = await cdp.eval(
              DOM_EXTRACTOR_SCRIPT,
              { __ACTION: 'loginFill', __PASSWORD: '', __TIMEOUT: 0 },
              { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
            );
          } catch (err) {
            pollRes = { outcome: 'UNKNOWN', reason: err.message };
          }

          const pollOutcome = pollRes?.outcome || (pollRes?.state === 'ON_CASE' || pollRes?.state === 'OK' ? 'AUTHENTICATED' : 'UNKNOWN');
          if (pollOutcome === 'AUTHENTICATED') {
            logDiag(`OTP verification completed. Resuming capture flow.`);
            return { handled: true };
          }

          if (pollOutcome === 'REJECTED') {
            logDiag(`OTP verification rejected: ${pollRes?.reason}`);
            return {
              state: 'AUTH',
              reason: pollRes?.reason || 'otp-rejected',
              href: '',
              fields: {},
              fastPathUsed,
              durationMs: Math.round(performance.now() - start),
              url: authUrl || '',
              diagnostics,
            };
          }

          const remainingSec = Math.max(0, Math.round((otpDeadline - Date.now()) / 1000));
          logDiag(`Waiting for OTP completion (${remainingSec}s remaining)...`);
        }

        logDiag(`OTP verification timed out after ${otpTimeoutMs}ms.`);
        return {
          state: 'OTP_TIMEOUT',
          reason: 'Password accepted, but OTP verification was not completed within the timeout window',
          href: '',
          fields: {},
          fastPathUsed,
          durationMs: Math.round(performance.now() - start),
          url: authUrl || '',
          diagnostics,
        };
      }
    }

    logDiag(`Autofill exceeded retry limit (${fillRetryLimit}). Falling back to manual AUTH.`);
    return {
      state: 'AUTH',
      href: '',
      fields: {},
      fastPathUsed,
      durationMs: Math.round(performance.now() - start),
      url: authUrl || '',
      diagnostics,
    };
  }

  // Navigate/click, probe page state, and transparently run the auth-retry cycle
  // if the probe lands on AUTH. Returns the raw probe so each call site can still
  // apply its own success criteria and build its own return shape (they differ:
  // direct-nav merges cached fields, search-based paths use the probe's fields).
  async function probeAndHandleAuth(action, probeScript, probeVars, fastPathUsed, { label, retryAction = action } = {}) {
    await action();
    let probe = await cdp.eval(
      probeScript,
      probeVars,
      { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
    );

    if (probe?.state === 'AUTH') {
      const authRes = await handleAuth(probe.url, fastPathUsed);
      if (!authRes.handled) {
        return { probe, authFailure: authRes };
      }
      logDiag(`Re-attempting ${label} after authentication`);
      await retryAction();
      probe = await cdp.eval(
        probeScript,
        probeVars,
        { awaitPromise: true, maxRetries: 3, retryDelay: 200 }
      );
    }

    return { probe, authFailure: null };
  }

  // 1. Fast Path: Direct Navigation if cached case URL is known and valid
  if (caseUrl && !isStubUrl(caseUrl)) {
    logDiag(`Attempting direct navigation to cached URL: ${caseUrl}`);
    try {
      const { probe: probeResult, authFailure } = await probeAndHandleAuth(
        () => cdp.navigate(caseUrl, { waitUntil: 'load', timeout: Math.min(timeout, 25000) }),
        DOM_EXTRACTOR_SCRIPT,
        { __ACTION: 'observeCaseState', __CODE: code, __TIMEOUT: Math.min(timeout, 15000) },
        true,
        { label: `direct navigation: ${caseUrl}` }
      );
      if (authFailure) return authFailure;
      let probe = probeResult;

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
        const authRes = await handleAuth(probe.url, true);
        if (!authRes.handled) return authRes;
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
    const { probe: searchProbeResult, authFailure } = await probeAndHandleAuth(
      () => cdp.navigate(searchUrl, { waitUntil: 'load', timeout: Math.min(timeout, 25000) }),
      DOM_EXTRACTOR_SCRIPT,
      { __ACTION: 'searchCaseResults', __CODE: code, __TIMEOUT: Math.min(timeout, 25000) },
      false,
      { label: `global search: ${searchUrl}` }
    );
    if (authFailure) return authFailure;
    let searchProbe = searchProbeResult;

    const durationMs = Math.round(performance.now() - start);

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
          const { probe: navProbe, authFailure: navAuthFailure } = await probeAndHandleAuth(
            () => cdp.navigate(searchProbe.href, { waitUntil: 'load', timeout: Math.min(timeout, 15000) }),
            DOM_EXTRACTOR_SCRIPT,
            { __ACTION: 'observeCaseState', __CODE: code, __TIMEOUT: Math.min(timeout, 5000) },
            false,
            { label: `search link navigation: ${searchProbe.href}` }
          );
          if (navAuthFailure) return navAuthFailure;

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
        const { probe: clickProbe, authFailure: clickAuthFailure } = await probeAndHandleAuth(
          () => cdp.click("[data-cq-hit='1']"),
          DOM_EXTRACTOR_SCRIPT,
          { __ACTION: 'observeCaseState', __CODE: code, __TIMEOUT: Math.min(timeout, 5000) },
          false,
          { label: 'observation following trusted click', retryAction: async () => {} }
        );
        if (clickAuthFailure) return clickAuthFailure;

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

