// Process lock module guarding _overview.json atomic read-modify-write-rename operations.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OVERVIEW_LOCK_STALE_MS = 10000; // age after which lock is presumed abandoned
const OVERVIEW_LOCK_RETRY_MS = 20;
const OVERVIEW_LOCK_TIMEOUT_MS = 5000;

function blockingSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function randomToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Acquires exclusive lock guarding _overview.json's read-modify-write-rename.
 * Returns a { path, token } handle to pass to releaseOverviewLock.
 *
 * @param {string} casesDir
 * @param {object} [opts={}]
 * @param {number} [opts.staleMs=OVERVIEW_LOCK_STALE_MS] Age after which a held lock is presumed abandoned
 * @param {number} [opts.retryMs=OVERVIEW_LOCK_RETRY_MS] Poll interval while waiting
 * @param {number} [opts.timeoutMs=OVERVIEW_LOCK_TIMEOUT_MS] Total time to wait before giving up
 * @returns {{ path: string, token: string }} lock handle
 */
export function acquireOverviewLock(casesDir, opts = {}) {
  const staleMs = opts.staleMs ?? OVERVIEW_LOCK_STALE_MS;
  const retryMs = opts.retryMs ?? OVERVIEW_LOCK_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? OVERVIEW_LOCK_TIMEOUT_MS;
  const path = join(casesDir, '.overview.lock');
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(path);
      const token = randomToken();
      writeFileSync(join(path, 'owner'), token, 'utf8');
      return { path, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(path).mtimeMs > staleMs;
      } catch {
        stale = true; // lock dir vanished between failed mkdir and stat
      }
      if (stale) {
        try { rmSync(path, { recursive: true, force: true }); continue; } catch { /* another process cleared it, retry */ }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`overview lock timeout: ${path}`);
      }
      blockingSleep(retryMs);
    }
  }
}

/**
 * Releases a lock acquired by acquireOverviewLock.
 * Safe no-op if lock was already reclaimed or taken over by another process token.
 * @param {{ path: string, token: string }} lock
 */
export function releaseOverviewLock(lock) {
  if (!lock) return;
  const { path, token } = lock;
  let owner;
  try {
    owner = readFileSync(join(path, 'owner'), 'utf8');
  } catch {
    return; // owner file gone
  }
  if (owner !== token) return; // taken over by another holder
  try { rmSync(path, { recursive: true, force: true }); } catch { /* already gone */ }
}

/**
 * High-level helper executing fn within an acquired overview lock.
 * Ensures releaseOverviewLock is always called in a finally block.
 * @template T
 * @param {string} casesDir
 * @param {function(): T} fn
 * @param {object} [opts={}] Lock options
 * @returns {T} Return value of fn
 */
export function withOverviewLock(casesDir, fn, opts = {}) {
  const lock = acquireOverviewLock(casesDir, opts);
  try {
    return fn(lock);
  } finally {
    releaseOverviewLock(lock);
  }
}
