// Tests for browser.mjs's CDP-port identity check (issue #104).
//
// Root cause being guarded against: an unrelated external tool scans CDP debug
// ports and attaches to whichever Chrome answers first. Our persistent-profile
// Chrome sat on the well-known 9222 (now 9773, still a fixed, discoverable
// port), stays running for long stretches between captures, and previously
// ensureChrome() trusted ANY /json/version response on that port unconditionally.
// These tests pin the fix: before reusing a CDP connection, verify the owning
// process's command line actually launched Chrome with THIS project's
// --user-data-dir, and fail loud (PortConflictError) otherwise.
//
//     node --experimental-test-module-mocks --test tests/qcomm_ensure_chrome_port_identity.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-ensure-chrome-'));
process.env.QUALCOMM_ROOT = QUALCOMM_ROOT;
const PROFILE_DIR = join(QUALCOMM_ROOT, 'data', 'chrome-profile');

const SCRIPTS = new URL('../.claude/skills/qcomm/scripts/', import.meta.url);

let seq = 0;
const importBrowser = () => import(new URL(`browser.mjs?t=${++seq}`, SCRIPTS));

function mockSpawnSync(t, { ownerCommandLine } = {}) {
  const calls = [];
  t.mock.module('node:child_process', {
    exports: {
      spawnSync: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (cmd === 'powershell') {
          return { stdout: ownerCommandLine || '', stderr: '', status: 0, error: null };
        }
        // cmd.exe (the `agent-browser connect ws://...` line) — not exercised
        // by these tests (they throw before reaching it, or don't care).
        return { stdout: '', stderr: '', status: 0, error: null };
      },
    },
  });
  return calls;
}

function mockCdpVersion(t, wsUrl = 'ws://127.0.0.1:9773/devtools/browser/fake') {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ webSocketDebuggerUrl: wsUrl }),
  }));
}

describe('ownsProfile', () => {
  it('is true when the command line launched Chrome on this project profile dir', async () => {
    const { ownsProfile } = await importBrowser();
    const cmd = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9773 --user-data-dir="${PROFILE_DIR}"`;
    assert.equal(ownsProfile(cmd, PROFILE_DIR), true);
  });

  it('is false for a command line pointed at a different profile dir', async () => {
    const { ownsProfile } = await importBrowser();
    const cmd = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\some\\other\\tool\\profile"';
    assert.equal(ownsProfile(cmd, PROFILE_DIR), false);
  });

  it('is false for null/empty command lines (owner unknown or query failed)', async () => {
    const { ownsProfile } = await importBrowser();
    assert.equal(ownsProfile(null, PROFILE_DIR), false);
    assert.equal(ownsProfile('', PROFILE_DIR), false);
  });
});

describe('ensureChrome — CDP port identity check', () => {
  it('proceeds normally when the port owner is this project\'s Chrome', async (t) => {
    mockCdpVersion(t);
    mockSpawnSync(t, {
      ownerCommandLine: `chrome.exe --remote-debugging-port=9773 --user-data-dir="${PROFILE_DIR}"`,
    });
    const { ensureChrome } = await importBrowser();
    const result = await ensureChrome({ launch: false });
    assert.equal(result.launched, false);
    assert.equal(result.wsUrl, 'ws://127.0.0.1:9773/devtools/browser/fake');
  });

  it('throws PortConflictError when the port is held by an unrelated process, without connecting', async (t) => {
    mockCdpVersion(t);
    const calls = mockSpawnSync(t, {
      ownerCommandLine: 'chrome.exe --user-data-dir="C:\\some\\other\\tool\\profile"',
    });
    const { ensureChrome, PortConflictError } = await importBrowser();

    await assert.rejects(
      () => ensureChrome({ launch: false }),
      (err) => {
        assert.ok(err instanceof PortConflictError);
        assert.match(err.message, /not this project's Chrome/i);
        assert.equal(err.detail.commandLine, 'chrome.exe --user-data-dir="C:\\some\\other\\tool\\profile"');
        return true;
      },
    );

    // Only the identity-check query ran (powershell) — the connect step
    // (a cmd.exe call) must never be attempted once mismatch is detected.
    assert.equal(calls.filter(c => c.cmd !== 'powershell').length, 0);
  });

  it('throws PortConflictError when nothing answers the identity query (owner unknown)', async (t) => {
    mockCdpVersion(t);
    mockSpawnSync(t, { ownerCommandLine: '' });
    const { ensureChrome, PortConflictError } = await importBrowser();

    await assert.rejects(() => ensureChrome({ launch: false }), PortConflictError);
  });
});
