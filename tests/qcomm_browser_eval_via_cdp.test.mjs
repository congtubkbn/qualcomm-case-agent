// Tests for browser.mjs's evalFileViaCdp — sends a page script over an
// already-open CDP WebSocket instead of shelling out through cmd.exe, so it
// has no exposure to cmd.exe's base64 line-length guard (see evalFile's
// 7000-char check). No real Chrome/CDP involved: the CDP client is a fake.
//     node --experimental-test-module-mocks --test tests/qcomm_browser_eval_via_cdp.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { evalFileViaCdp } from '../.claude/skills/qcomm/scripts/browser.mjs';

describe('evalFileViaCdp', () => {
  it('strips comments, wraps the script in the standard payload IIFE, and returns the CDP eval result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-evalcdp-'));
    const scriptPath = join(dir, 'script.js');
    writeFileSync(scriptPath, [
      '// a leading comment line',
      '(function(){ return { ok: true, n: __N }; })()',
    ].join('\n'), 'utf8');

    const seenCalls = [];
    const fakeCdp = {
      eval: async (payload, vars) => {
        seenCalls.push({ payload, vars });
        return { ok: true, n: 7 };
      },
    };

    const result = await evalFileViaCdp(fakeCdp, scriptPath, { __N: 7 });

    assert.deepEqual(result, { ok: true, n: 7 });
    assert.equal(seenCalls.length, 1);
    assert.ok(!seenCalls[0].payload.includes('a leading comment line'), 'comments should be stripped before sending');
    assert.ok(seenCalls[0].payload.trim().startsWith('(function'), 'payload should be wrapped in the standard IIFE preamble');
    assert.match(seenCalls[0].payload, /var __N = 7;/);
  });

  it('never throws on scripts far larger than the cmd.exe base64 guard (7000 chars)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-evalcdp-big-'));
    const scriptPath = join(dir, 'big.js');
    const big = `(function(){ return "${'x'.repeat(20000)}"; })()`;
    writeFileSync(scriptPath, big, 'utf8');

    const fakeCdp = { eval: async () => 'ok' };
    const result = await evalFileViaCdp(fakeCdp, scriptPath, {});
    assert.equal(result, 'ok');
  });
});
