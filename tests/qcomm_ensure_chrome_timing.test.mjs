// tests/qcomm_ensure_chrome_timing.test.mjs — Regression test for fast non-blocking ensureChrome().
// Ensures ensureChrome() does not invoke blocking agent-browser connect CLI or hang.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-ensure-timing-'));
process.env.QUALCOMM_ROOT = QUALCOMM_ROOT;
const PROFILE_DIR = join(QUALCOMM_ROOT, 'data', 'chrome-profile');
const SCRIPTS = new URL('../.claude/skills/qcomm/scripts/', import.meta.url);

let seq = 0;
const importBrowser = () => import(new URL(`browser.mjs?t=${++seq}`, SCRIPTS));

function mockCdpVersion(t, wsUrl = 'ws://127.0.0.1:9773/devtools/browser/fake') {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ webSocketDebuggerUrl: wsUrl }),
  }));
}

describe('ensureChrome — non-blocking execution', () => {
  it('does not invoke blocking agent-browser connect command during ensureChrome', async (t) => {
    const spawnedCalls = [];
    t.mock.module('node:child_process', {
      exports: {
        spawnSync: (cmd, args, opts) => {
          spawnedCalls.push({ cmd, args, opts });
          if (cmd === 'powershell') {
            return {
              stdout: `chrome.exe --remote-debugging-port=9773 --user-data-dir="${PROFILE_DIR}"`,
              stderr: '',
              status: 0,
              error: null,
            };
          }
          // If agent-browser connect is invoked, record it
          return { stdout: '', stderr: '', status: 0, error: null };
        },
      },
    });

    mockCdpVersion(t);
    const { ensureChrome } = await importBrowser();
    const result = await ensureChrome({ launch: false });

    assert.equal(result.launched, false);
    assert.equal(result.wsUrl, 'ws://127.0.0.1:9773/devtools/browser/fake');

    // Regression check: ensureChrome should NOT spawn any cmd.exe / agent-browser connect
    const abConnectCalls = spawnedCalls.filter(c => 
      (c.args && c.args.some(a => String(a).includes('agent-browser connect'))) ||
      (c.cmd && String(c.cmd).includes('agent-browser'))
    );
    assert.equal(abConnectCalls.length, 0, 'ensureChrome should not invoke blocking agent-browser connect');
  });
});
