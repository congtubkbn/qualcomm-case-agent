// tests/screenshot_timeout.test.mjs — Regression test for bounded screenshot() timeout.
//
// screenshot() runs synchronously right before case.json/case.md get written
// (run_case.mjs shoot() -> raw.capture.screenshot, before scrape_case.mjs /
// render_case.mjs). It is best-effort evidence, never required for a correct
// capture, so a stuck agent-browser daemon must not be able to hold up the
// required output for the full previous 120s spawnSync timeout.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SCRIPTS = new URL('../.claude/skills/qualcomm-case-agent/scripts/', import.meta.url);

let seq = 0;
const importBrowser = () => import(new URL(`browser.mjs?t=${++seq}`, SCRIPTS));

describe('screenshot() — bounded timeout', () => {
  it('passes a short timeout to spawnSync, not the 120s command default', async (t) => {
    let capturedOpts = null;
    t.mock.module('node:child_process', {
      exports: {
        spawnSync: (cmd, args, opts) => {
          capturedOpts = opts;
          return { stdout: 'ok', stderr: '', status: 0, error: null };
        },
      },
    });

    const { screenshot } = await importBrowser();
    screenshot('C:/tmp/capture.png');

    assert.ok(capturedOpts, 'spawnSync should have been called');
    assert.ok(
      capturedOpts.timeout <= 15000,
      `screenshot() timeout should be capped low (<=15000ms), got ${capturedOpts.timeout}`,
    );
  });
});
