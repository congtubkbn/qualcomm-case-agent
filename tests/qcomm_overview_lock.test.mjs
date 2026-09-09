// Tests for overview_store.mjs's write lock around _overview.json (issue #202):
// concurrent syncCaseOverview calls for different cases must not last-write-wins
// clobber each other, and the lock itself must take over a stale holder and give
// up after a bounded wait instead of hanging forever.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acquireOverviewLock, releaseOverviewLock } from '../.claude/skills/qcomm/scripts/overview_store.mjs';
import { withOverviewLock } from '../.claude/skills/qcomm/scripts/overview_lock.mjs';

const STORE_URL = new URL('../.claude/skills/qcomm/scripts/overview_store.mjs', import.meta.url).href;

function createTempCasesDir() {
  return mkdtempSync(join(tmpdir(), 'qc-overview-lock-test-'));
}

function seedCase(dataDir, code) {
  const caseDir = join(dataDir, code);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'case.json'), JSON.stringify({
    caseNumber: code,
    title: `Case ${code}`,
    status: 'Open',
    comments: [],
  }, null, 2), 'utf8');
}

// Spawns a child process that calls syncCaseOverview(code, { casesDir, render: false })
// for one case. A real child process (not just an async callback in this process) is
// what makes the two upserts genuinely race on the filesystem instead of interleaving
// cooperatively on one event loop.
function spawnUpsert(casesDir, code) {
  const script = `
    import { syncCaseOverview } from ${JSON.stringify(STORE_URL)};
    syncCaseOverview(${JSON.stringify(code)}, { casesDir: ${JSON.stringify(casesDir)}, render: false });
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code2) => {
      if (code2 !== 0) reject(new Error(`worker exited ${code2}: ${stderr}`));
      else resolvePromise();
    });
    child.on('error', reject);
  });
}

describe('overview_store: concurrent-write lock', () => {
  it('preserves every case when several processes upsert different cases at once', async () => {
    const casesDir = createTempCasesDir();
    const codes = ['11111111', '22222222', '33333333', '44444444', '55555555', '66666666'];
    for (const code of codes) seedCase(casesDir, code);

    // Seed _overview.json with none of these cases present yet, so each upsert
    // below must read-modify-write the SAME existing file (not build fresh from
    // the case dirs on disk, which would already contain everybody and mask the
    // race this test exists to catch).
    writeFileSync(join(casesDir, '_overview.json'), JSON.stringify({
      cases: [],
      stats: { total: 0, byStatus: {}, lastUpdated: new Date().toISOString() },
    }, null, 2), 'utf8');

    await Promise.all(codes.map((code) => spawnUpsert(casesDir, code)));

    const overview = JSON.parse(readFileSync(join(casesDir, '_overview.json'), 'utf8'));
    const seen = overview.cases.map((c) => c.caseNumber).sort();
    assert.deepEqual(seen, [...codes].sort());
  });
});

describe('overview_store: lock primitives', () => {
  it('takes over a lock directory whose mtime is older than staleMs', () => {
    const casesDir = createTempCasesDir();
    const staleLockPath = join(casesDir, '.overview.lock');
    mkdirSync(staleLockPath);
    const oldTime = new Date(Date.now() - 60000);
    utimesSync(staleLockPath, oldTime, oldTime);

    const lock = acquireOverviewLock(casesDir, { staleMs: 50, timeoutMs: 1000 });
    assert.equal(lock.path, staleLockPath);
    assert.ok(statSync(lock.path).isDirectory());
    releaseOverviewLock(lock);
  });

  it('throws a timeout error when a fresh lock is held past timeoutMs', () => {
    const casesDir = createTempCasesDir();
    const lockPath = join(casesDir, '.overview.lock');
    mkdirSync(lockPath); // fresh — mtime is "now", never counts as stale

    assert.throws(
      () => acquireOverviewLock(casesDir, { staleMs: 60000, retryMs: 10, timeoutMs: 100 }),
      /overview lock timeout/
    );

    rmdirSync(lockPath);
  });

  it('releaseOverviewLock is a no-op when the lock is already gone', () => {
    const casesDir = createTempCasesDir();
    assert.doesNotThrow(() => releaseOverviewLock({ path: join(casesDir, '.overview.lock'), token: 'nope' }));
  });

  it('does not release a lock that a stale-timeout takeover has since handed to someone else', () => {
    // Regression for the double-release bug: a legitimate holder that runs past
    // staleMs (e.g. a slow cold-start buildOverviewData scan) must not be able to
    // delete a DIFFERENT process's lock out from under it just because it finally
    // calls release on its own (now-stale) handle.
    const casesDir = createTempCasesDir();
    const original = acquireOverviewLock(casesDir);

    const oldTime = new Date(Date.now() - 60000);
    utimesSync(original.path, oldTime, oldTime);
    const stolen = acquireOverviewLock(casesDir, { staleMs: 50, timeoutMs: 1000 });
    assert.notEqual(stolen.token, original.token);

    releaseOverviewLock(original); // the slow original holder finally "finishes"

    assert.ok(statSync(stolen.path).isDirectory(), 'new holder\'s lock must survive');
    assert.equal(readFileSync(join(stolen.path, 'owner'), 'utf8'), stolen.token);

    releaseOverviewLock(stolen);
  });

  it('withOverviewLock executes fn with lock acquired and returns its result', () => {
    const casesDir = createTempCasesDir();
    let lockInside = null;

    const result = withOverviewLock(casesDir, (lock) => {
      lockInside = lock;
      assert.ok(statSync(lock.path).isDirectory(), 'lock dir must exist while inside fn');
      assert.equal(readFileSync(join(lock.path, 'owner'), 'utf8'), lock.token);
      return { success: true, count: 42 };
    });

    assert.deepEqual(result, { success: true, count: 42 });
    assert.throws(() => statSync(lockInside.path), { code: 'ENOENT' }, 'lock dir must be released after fn completes');
  });

  it('withOverviewLock releases lock even when fn throws an error', () => {
    const casesDir = createTempCasesDir();
    let lockInside = null;

    assert.throws(
      () => {
        withOverviewLock(casesDir, (lock) => {
          lockInside = lock;
          assert.ok(statSync(lock.path).isDirectory());
          throw new Error('deliberate failure inside locked section');
        });
      },
      /deliberate failure inside locked section/
    );

    assert.throws(() => statSync(lockInside.path), { code: 'ENOENT' }, 'lock dir must be released even after fn throws');
  });
});

