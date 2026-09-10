// tests/qcomm_screenshot_timeout.test.mjs — Regression test for bounded native CDP screenshot() timeout.
//
// screenshot() runs right before case.json/case.md get written
// (run_case.mjs shoot() -> raw.capture.screenshot, before finalize_case.mjs /
// render_case.mjs). It is best-effort evidence, never required for a correct
// capture, so a stuck CDP command must not be able to hold up the
// required output. It uses native CDP WebSocket (Page.captureScreenshot) and
// bounds the timeout to <= 15000ms without spawning agent-browser/cmd.exe.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPTS = new URL('../.claude/skills/qcomm/scripts/', import.meta.url);

let seq = 0;
const importBrowser = () => import(new URL(`browser.mjs?t=${++seq}`, SCRIPTS));

describe('screenshot() — bounded CDP timeout & native transport', () => {
  it('calls cdp.screenshot with timeout <= 15000ms and writes file without calling spawnSync', async (t) => {
    let spawnSyncCalled = false;
    t.mock.module('node:child_process', {
      exports: {
        spawnSync: () => {
          spawnSyncCalled = true;
          return { stdout: '', stderr: '', status: 0, error: null };
        },
      },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), 'qc-screenshot-test-'));
    const targetPath = join(tmpDir, 'test_capture.png');
    const fakePngBytes = Buffer.from('FAKE_PNG_BINARY_CONTENT');
    let capturedOptions = null;

    const fakeCdp = {
      isConnected: () => true,
      screenshot: async (opts) => {
        capturedOptions = opts;
        return fakePngBytes;
      },
    };

    try {
      const { screenshot } = await importBrowser();
      const res = await screenshot(targetPath, { cdp: fakeCdp });

      assert.equal(spawnSyncCalled, false, 'spawnSync should NOT be called — screenshot must use native CDP WebSocket');
      assert.ok(capturedOptions, 'cdp.screenshot should have been called');
      assert.ok(
        capturedOptions.timeout <= 15000,
        `screenshot() timeout should be capped low (<=15000ms), got ${capturedOptions.timeout}`,
      );
      assert.equal(capturedOptions.fullPage, true, 'screenshot should default to fullPage: true');
      assert.equal(res, targetPath);

      const written = readFileSync(targetPath);
      assert.deepEqual(written, fakePngBytes, 'screenshot content on disk should match buffer returned by CDP');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('delegates to getCdpClient when no cdp instance is passed explicitly', async (t) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'qc-screenshot-test2-'));
    const targetPath = join(tmpDir, 'test_capture2.png');
    const fakePngBytes = Buffer.from('FAKE_PNG_2');
    let capturedOptions = null;

    const fakeCdp = {
      isConnected: () => true,
      screenshot: async (opts) => {
        capturedOptions = opts;
        return fakePngBytes;
      },
    };

    t.mock.module(new URL('cdp_client.mjs', SCRIPTS), {
      exports: {
        CdpClient: {
          connect: async () => fakeCdp,
        },
      },
    });

    try {
      const { screenshot } = await importBrowser();
      const res = await screenshot(targetPath);

      assert.ok(capturedOptions, 'cdp.screenshot should have been called via getCdpClient');
      assert.ok(capturedOptions.timeout <= 15000);
      assert.equal(res, targetPath);

      const written = readFileSync(targetPath);
      assert.deepEqual(written, fakePngBytes);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
