// lock.mjs — one capture at a time, machine-wide.
//
// Every capture path funnels through run_case.mjs (interactive run, resident
// sweep, dashboard "Sync now"), and they all drive the SAME Chrome on CDP 9773
// — two at once interleave navigation and corrupt each other's extraction.
// This lock makes the second one report `busy` instead.
//
// Atomic write lock: uses `flag: 'wx'` (O_CREAT | O_EXCL) to close the
// exists→write race window. Contenders fail atomically if the lock file already
// exists; stale or dead holders are cleared and retried.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from './_paths.mjs';

export const LOCK_PATH = join(PROJECT_ROOT, 'data', '.capture.lock');

// A capture that outlives this is hung or dead — its lock may be taken over.
const STALE_MS = 30 * 60000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = alive, other owner
}

/** Try to take the capture lock. Returns { ok: true } or { ok: false, holder }. */
export function acquireLock(path = LOCK_PATH, now = Date.now(), code) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), code });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, payload, { flag: 'wx' });
      return { ok: true };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* corrupt = stale */ }
      const fresh = holder
        && now - Date.parse(holder.at) < STALE_MS
        && pidAlive(holder.pid);
      if (fresh) return { ok: false, holder };
      try { rmSync(path, { force: true }); } catch { /* already gone */ }
    }
  }
  let holder = null;
  try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* corrupt */ }
  return { ok: false, holder };
}

export function releaseLock(path = LOCK_PATH) {
  try { rmSync(path, { force: true }); } catch { /* already gone */ }
}

const DEFAULT_POLL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 60000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Same as acquireLock, but a refusal by a holder capturing the SAME code polls
 * (bounded by timeoutMs) instead of refusing immediately — a same-case collision
 * is usually about to resolve itself once the other run finishes. A refusal by a
 * holder on a DIFFERENT code still returns instantly, exactly like acquireLock,
 * so an unrelated caller is never made to wait.
 *
 * Returns { ok: true, waited, waitedMs } once acquired, or the same
 * { ok: false, holder } refusal shape as acquireLock (plus waited/waitedMs) once
 * the wait budget is exhausted.
 */
export async function acquireLockOrWaitForSameCode(path = LOCK_PATH, code, opts = {}) {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  let attempt = acquireLock(path, Date.now(), code);
  if (attempt.ok) return { ok: true, waited: false, waitedMs: 0 };
  if (attempt.holder?.code !== code) return { ...attempt, waited: false, waitedMs: 0 };

  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    attempt = acquireLock(path, Date.now(), code);
    if (attempt.ok) return { ok: true, waited: true, waitedMs: Date.now() - start };
    if (attempt.holder?.code !== code) return { ...attempt, waited: true, waitedMs: Date.now() - start };
  }
  return { ...attempt, waited: true, waitedMs: Date.now() - start };
}
