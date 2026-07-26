// browser.mjs — thin Node wrapper around the `agent-browser` CLI.
//
// Why this exists: every shell-quoting bug this project has hit (see
// OPTIMIZATION_ANALYSIS.md §1/§3) came from a JS payload crossing a shell.
// Node spawns with an ARGV ARRAY, so on POSIX nothing is re-tokenized at all,
// and on Windows we build one cmd.exe line ourselves from metachar-free args.
// No `--stdin` (broken on Windows), no `<` redirect, no nested quoting.
//
// It also owns the two things every caller needs:
//   - evalFile(): base64 (`eval -b`) execution of a page script, with comment
//     lines stripped first so the command line stays far below cmd.exe's 8191.
//   - ensureChrome(): attach to the persistent-profile Chrome on CDP 9222,
//     using the ws:// URL from /json/version (bare `connect 9222` hits the
//     IPv6 ::1 mismatch → os error 10060).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ROOT, PROFILE_DIR } from './_paths.mjs';

const WIN = process.platform === 'win32';
const BIN = process.env.AGENT_BROWSER_BIN || 'agent-browser';
const CDP_PORT = Number(process.env.QUALCOMM_CDP_PORT || 9222);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

// cmd.exe re-reads these even inside double quotes (or breaks on them).
// Our args are URLs, file paths and base64 — none legitimately contain any of
// them — so treat a hit as a bug and fail loud instead of silently mangling.
const CMD_UNSAFE = /[&|<>^"%!]/;

export class BrowserError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'BrowserError';
    this.detail = detail;
  }
}

/** Run the agent-browser CLI. Returns trimmed stdout; throws on non-zero exit. */
function ab(args, { timeout = 120000, allowFail = false } = {}) {
  const r = WIN
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', winLine(args)], {
        encoding: 'utf8', timeout, windowsVerbatimArguments: true,
      })
    : spawnSync(BIN, args, { encoding: 'utf8', timeout });

  if (r.error && r.error.code === 'ENOENT') {
    throw new BrowserError('agent-browser not found on PATH (npm i -g agent-browser)');
  }
  if (r.error && !allowFail) throw new BrowserError(`agent-browser failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new BrowserError(
      `agent-browser ${args[0]} exited ${r.status}`,
      (r.stderr || r.stdout || '').trim().slice(0, 400),
    );
  }
  return (r.stdout || '').trim();
}

// cmd.exe line built the same way Node's own shell:true does it: quote args
// containing spaces, join, and let `/s` strip the outer pair.
function winLine(args) {
  const bad = [BIN, ...args].find(a => CMD_UNSAFE.test(a));
  if (bad) throw new BrowserError(`arg contains a cmd.exe metacharacter: ${String(bad).slice(0, 60)}`);
  const line = [BIN, ...args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return `"${line}"`;
}

/**
 * Evaluate a page script in the attached tab and return its parsed result.
 * `vars` are injected as `var NAME = <json>;` above the script, which is how a
 * page script gets parameters without any string interpolation into the source.
 */
export function evalFile(scriptPath, vars = {}, opts = {}) {
  const src = stripComments(readFileSync(scriptPath, 'utf8'));
  const preamble = Object.entries(vars)
    .map(([k, v]) => `var ${k} = ${JSON.stringify(v)};`)
    .join('\n');
  const b64 = Buffer.from(preamble ? `${preamble}\n${src}` : src, 'utf8').toString('base64');
  if (WIN && b64.length > 7000) {
    throw new BrowserError(`page script too large for cmd.exe (${b64.length} b64 chars): ${scriptPath}`);
  }
  return parseResult(ab(['eval', '-b', b64], opts));
}

/** Drop whole-line `//` comments and blank lines. A line whose first non-space
 *  chars are `//` is always a comment here (no multi-line template literals in
 *  the page scripts), so this is safe and keeps the base64 payload small. */
export function stripComments(src) {
  return src
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l) && l.trim() !== '')
    .join('\n');
}

/** agent-browser prints the serialized result; take the last JSON-ish line. */
export function parseResult(stdout) {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/^[[{"]|^-?\d|^(true|false|null)$/.test(l)) continue;
    try { return JSON.parse(l); } catch { /* keep scanning upward */ }
  }
  // Multi-line pretty-printed JSON: try the whole payload once.
  try { return JSON.parse(stdout); } catch { return stdout || null; }
}

export function open(url) { return ab(['open', url], { timeout: 180000 }); }
export function click(selector) { return ab(['click', selector], { timeout: 30000 }); }
export function pdf(path) { return ab(['pdf', path], { timeout: 180000 }); }

/** Ask the CDP endpoint directly — the one signal that says whether the
 *  persistent-profile Chrome is actually up, independent of the daemon. */
async function cdpVersion() {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * PHASE 0 as code: make sure agent-browser is driving the persistent-profile
 * Chrome. Launches it if the port is dead, then attaches to the ws:// URL.
 * Returns { launched, wsUrl }.
 */
export async function ensureChrome({ launch = true } = {}) {
  let info = await cdpVersion();
  let launched = false;

  if (!info && launch) {
    launchChrome();
    for (let i = 0; i < 15 && !info; i++) {
      await sleep(1000);
      info = await cdpVersion();
    }
    launched = true;
  }
  if (!info) {
    throw new BrowserError(
      `no Chrome on CDP ${CDP_PORT} (profile ${PROFILE_DIR}) — start it, then retry`,
    );
  }
  ab(['connect', info.webSocketDebuggerUrl], { timeout: 60000, allowFail: true });
  return { launched, wsUrl: info.webSocketDebuggerUrl };
}

function launchChrome() {
  if (WIN) {
    spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', join(SKILL_ROOT, 'scripts', 'connect_chrome.ps1'),
    ], { encoding: 'utf8', timeout: 120000 });
    return;
  }
  // POSIX (dev/CI): same contract — real Chrome, persistent profile, CDP 9222.
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  spawnSync(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore', timeout: 5000 });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
