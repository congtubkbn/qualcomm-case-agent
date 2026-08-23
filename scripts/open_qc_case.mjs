#!/usr/bin/env node
// scripts/open_qc_case.mjs
// Deep Module: Core URI Parser & CDP / Chrome Dispatcher for qc:// custom protocol scheme.
// Zero external dependencies — runs directly in standard Node.js (>=22.3.0).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Robustly resolve project root directory across normal checkouts and git worktrees.
 */
function findProjectRoot(startDir = HERE) {
  if (process.env.QUALCOMM_ROOT) return process.env.QUALCOMM_ROOT;

  let current = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitPath = join(current, '.git');
    if (existsSync(gitPath)) {
      if (statSync(gitPath).isDirectory()) return current;
      // Handle git worktree pointer
      try {
        const content = readFileSync(gitPath, 'utf8');
        const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
        if (match) {
          const gitdir = match[1].replace(/\\/g, '/');
          const idx = gitdir.indexOf('/worktrees/');
          if (idx !== -1) return dirname(gitdir.slice(0, idx));
        }
      } catch {}
      return current;
    }
    if (existsSync(join(current, 'data', 'cases'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();
export const DEFAULT_CASES_DIR = join(PROJECT_ROOT, 'data', 'cases');
export const DEFAULT_PROFILE_DIR = join(PROJECT_ROOT, 'data', 'chrome-profile');
export const DEFAULT_CDP_PORT = Number(process.env.QUALCOMM_CDP_PORT || 9222);

/**
 * Validate that a URL domain belongs to Qualcomm support.
 * @param {string} urlString
 * @returns {boolean}
 */
export function isValidQualcommUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'support.qualcomm.com' || hostname.endsWith('.qualcomm.com');
  } catch {
    return false;
  }
}

/**
 * Parse an incoming qc:// custom protocol URI string into a structured target object.
 * Supported patterns:
 *   - qc://case/<caseNumber>
 *   - qc://<caseNumber>
 *   - qc:case/<caseNumber>
 *   - qc:<caseNumber>
 *   - qc://open?url=<encoded-url>
 *   - qc:open?url=<encoded-url>
 *
 * @param {string} uriString
 * @returns {{ type: 'case', caseNumber: string } | { type: 'url', url: string }}
 */
export function parseQcUri(uriString) {
  if (typeof uriString !== 'string') {
    throw new Error('Invalid qc URI: expected non-empty string');
  }

  const raw = uriString.trim();
  if (!raw || !raw.toLowerCase().startsWith('qc:')) {
    throw new Error(`Invalid qc URI: scheme must be "qc:", got "${raw}"`);
  }

  // Strip qc: and any leading slashes (e.g. qc:// or qc:)
  let rest = raw.replace(/^qc:\/*(?:\/)?/i, '').trim();
  // Strip trailing slashes
  rest = rest.replace(/\/+$/, '');

  if (!rest) {
    throw new Error(`Invalid qc URI: missing target or case number in "${raw}"`);
  }

  // Handle open?url=...
  if (/^open\?/i.test(rest) || /^open$/i.test(rest)) {
    const queryIdx = rest.indexOf('?');
    if (queryIdx === -1) {
      throw new Error('Invalid qc URI: missing url parameter in qc://open');
    }
    const queryStr = rest.slice(queryIdx + 1);
    const params = new URLSearchParams(queryStr);
    const targetUrl = params.get('url');
    if (!targetUrl) {
      throw new Error('Invalid qc URI: missing url parameter in qc://open');
    }

    if (!isValidQualcommUrl(targetUrl)) {
      throw new Error(`Invalid Qualcomm URL: "${targetUrl}" (Unauthorized domain or unsafe scheme)`);
    }

    return { type: 'url', url: targetUrl };
  }

  // Handle case/<caseNumber> or bare case or <caseNumber>
  let caseCode = rest;
  if (/^case(?:\/|$)/i.test(rest)) {
    caseCode = rest.replace(/^case(?:\/|$)/i, '').trim();
  }

  if (!caseCode || !/^[a-zA-Z0-9_-]+$/.test(caseCode)) {
    throw new Error(`Invalid case number: "${caseCode}" in "${raw}"`);
  }

  return { type: 'case', caseNumber: caseCode };
}

/**
 * Resolve destination URL for a parsed target object.
 * Reads data/cases/<caseNumber>/case.json if available; falls back to Qualcomm global search.
 *
 * @param {{ type: 'case', caseNumber: string } | { type: 'url', url: string }} parsed
 * @param {Object} [options]
 * @param {string} [options.casesDir]
 * @returns {string}
 */
export function resolveTargetUrl(parsed, options = {}) {
  if (parsed.type === 'url') {
    return parsed.url;
  }

  const casesDir = options.casesDir || DEFAULT_CASES_DIR;
  const caseJsonPath = join(casesDir, parsed.caseNumber, 'case.json');

  if (existsSync(caseJsonPath)) {
    try {
      const raw = readFileSync(caseJsonPath, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.url === 'string' && data.url.trim().length > 0) {
        return data.url.trim();
      }
    } catch {
      // Fall through to fallback search URL on read/parse error
    }
  }

  return `https://support.qualcomm.com/s/global-search/${encodeURIComponent(parsed.caseNumber)}`;
}

/**
 * Default launcher function to start Chrome via connect_chrome.ps1 on Windows.
 */
function defaultLaunchChrome({ url, port = DEFAULT_CDP_PORT, profileDir = DEFAULT_PROFILE_DIR }) {
  if (process.platform === 'win32') {
    const candidates = [
      join(PROJECT_ROOT, '.claude', 'skills', 'qualcomm-case-agent', 'scripts', 'connect_chrome.ps1'),
      join(PROJECT_ROOT, 'scripts', 'connect_chrome.ps1'),
      join(HERE, 'connect_chrome.ps1'),
    ];
    const scriptPath = candidates.find(existsSync) || candidates[0];

    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Port', String(port),
      '-Profile', profileDir,
    ];
    if (url) {
      args.push('-Url', url);
    }

    return spawnSync('powershell', args, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  // POSIX fallback for dev/CI
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (url) chromeArgs.push(url);

  return spawnSync(chrome, chromeArgs, {
    detached: true,
    stdio: 'ignore',
    timeout: 5000,
  });
}

/**
 * Check whether CDP port is responsive and listening on HTTP.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isCdpAlive(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Dispatch target URL to either an active Chrome instance via CDP or launch a new instance.
 *
 * @param {string} targetUrl
 * @param {Object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.profileDir]
 * @param {Function} [options.launchChromeFn]
 * @returns {Promise<{ success: boolean, method: 'cdp' | 'launch', targetUrl: string, targetId?: string }>}
 */
export async function dispatchQcTarget(targetUrl, options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || DEFAULT_CDP_PORT);
  const launchFn = options.launchChromeFn || defaultLaunchChrome;

  const cdpReady = await isCdpAlive(host, port);

  if (cdpReady) {
    try {
      // Chrome CDP supports PUT /json/new?<url> or GET /json/new?<url>
      let res;
      try {
        res = await fetch(`http://${host}:${port}/json/new?${encodeURIComponent(targetUrl)}`, {
          method: 'PUT',
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        res = await fetch(`http://${host}:${port}/json/new?${encodeURIComponent(targetUrl)}`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
      }

      if (res.ok) {
        const tabInfo = await res.json().catch(() => null);
        if (tabInfo?.id) {
          // Bring tab to front
          try {
            await fetch(`http://${host}:${port}/json/activate/${tabInfo.id}`, {
              signal: AbortSignal.timeout(2000),
            });
          } catch {}
        }
        return {
          success: true,
          method: 'cdp',
          targetUrl,
          targetId: tabInfo?.id,
        };
      }
    } catch {
      // If CDP /json/new throws, fall through to launch
    }
  }

  // Chrome is closed or CDP refused request — launch via launcher script
  launchFn({
    url: targetUrl,
    port,
    profileDir: options.profileDir || DEFAULT_PROFILE_DIR,
  });

  return {
    success: true,
    method: 'launch',
    targetUrl,
  };
}

/**
 * End-to-end entrypoint: parse URI, resolve URL, and dispatch navigation.
 *
 * @param {string} rawUri
 * @param {Object} [options]
 * @param {boolean} [options.throwOnError=true]
 * @param {number} [options.port]
 * @param {string} [options.casesDir]
 * @param {Function} [options.launchChromeFn]
 * @returns {Promise<{ success: boolean, method?: string, targetUrl?: string, error?: string }>}
 */
export async function openQcCase(rawUri, options = {}) {
  const throwOnError = options.throwOnError !== false;

  try {
    const parsed = parseQcUri(rawUri);
    const targetUrl = resolveTargetUrl(parsed, options);
    const result = await dispatchQcTarget(targetUrl, options);
    return result;
  } catch (err) {
    if (throwOnError) throw err;
    return {
      success: false,
      error: err.message,
      rawUri,
    };
  }
}

/**
 * CLI runner for Windows ShellExecute or terminal invocation.
 */
async function runCli() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: open_qc_case.mjs <qc-uri-or-case-number>');
    console.error('Examples:');
    console.error('  open_qc_case.mjs "qc://case/08603854"');
    console.error('  open_qc_case.mjs "qc://08603854"');
    console.error('  open_qc_case.mjs "qc://open?url=https://support.qualcomm.com/s/case/..."');
    process.exit(1);
  }

  try {
    const res = await openQcCase(arg, { throwOnError: true });
    console.log(`[QC Protocol] Dispatched ${arg} -> ${res.targetUrl} (via ${res.method})`);
    process.exit(0);
  } catch (err) {
    console.error(`[QC Protocol Error] ${err.message}`);
    process.exit(1);
  }
}

// Auto-run if executed as script
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}
