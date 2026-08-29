// QA coverage for intake.mjs — the skill's INPUT CONTRACT gate.
// SKILL.md: "One Qualcomm case code = exactly 8 digits (e.g. 08460319). A
// leading CASE- prefix is accepted and stripped. Anything else -> intake
// fails, ask user, STOP." This is the first thing every run does, so a gap
// here means a bad code either crashes deeper in the pipeline with a worse
// error, or (worst case) reaches a path/shell boundary unsanitized.
//
// Run as a child process (like finalize_case.test.mjs's finalize tests) so
// each case gets an isolated QUALCOMM_ROOT and there is no ESM module-cache
// interaction with _paths.mjs (which reads the env var once, at import time).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/intake.mjs', import.meta.url));

function run(code, root = mkdtempSync(join(tmpdir(), 'qc-intake-'))) {
  const r = spawnSync(process.execPath, [SCRIPT, ...(code === undefined ? [] : [code])], {
    encoding: 'utf8', env: { ...process.env, QUALCOMM_ROOT: root },
  });
  return { root, exit: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

const caseDir = (root, code) => join(root, 'data', 'cases', code);

describe('intake: accepted inputs', () => {
  it('accepts a bare 8-digit code and creates its cache dir', () => {
    const { exit, stdout, root } = run('08460319');
    assert.equal(exit, 0);
    assert.equal(stdout, 'intake OK 08460319');
    assert.ok(existsSync(caseDir(root, '08460319')));
    assert.ok(existsSync(join(root, 'data', 'cases', '_index.json')));
  });

  it('strips a CASE- prefix, case-insensitively', () => {
    assert.equal(run('CASE-08460319').stdout, 'intake OK 08460319');
    assert.equal(run('case-08460319').stdout, 'intake OK 08460319');
    assert.equal(run('Case-08460319').stdout, 'intake OK 08460319');
  });

  it('trims surrounding whitespace before validating', () => {
    const { exit, stdout } = run('  08460319  ');
    assert.equal(exit, 0);
    assert.equal(stdout, 'intake OK 08460319');
  });

  it('accepts an all-zero / leading-zero code (still exactly 8 digits)', () => {
    assert.equal(run('00000001').stdout, 'intake OK 00000001');
  });

  it('creates a fresh _index.json as {} when none exists yet', () => {
    const { root } = run('08460319');
    assert.equal(readFileSync(join(root, 'data', 'cases', '_index.json'), 'utf8'), '{}');
  });

  it('is idempotent — running twice on the same code does not fail', () => {
    const root = mkdtempSync(join(tmpdir(), 'qc-intake-'));
    assert.equal(run('08460319', root).exit, 0);
    assert.equal(run('08460319', root).exit, 0);
  });
});

describe('intake: rejected inputs (must STOP, not guess)', () => {
  const rejects = [
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['1234567', '7 digits'],
    ['123456789', '9 digits'],
    ['0846031X', 'non-digit character'],
    ['0846-0319', 'digits with an internal dash'],
    ['CASE-1234', 'CASE- prefix but wrong digit count'],
    ['CASE-', 'CASE- prefix with nothing after it'],
    [' 08460319a', 'trailing garbage after valid digits'],
    ['../../etc/passwd', 'path traversal attempt'],
    ['08460319; rm -rf /', 'shell metacharacters appended'],
  ];

  for (const [input, label] of rejects) {
    it(`rejects: ${label} (${JSON.stringify(input)})`, () => {
      const { exit, stderr, root } = run(input);
      assert.equal(exit, 1, `expected non-zero exit for ${JSON.stringify(input)}`);
      assert.match(stderr, /^ERROR: /);
      // No side effect: an invalid code must never create a cache directory —
      // that would be a path-traversal / injection surface if the regex gate
      // were ever bypassed.
      assert.ok(!existsSync(join(root, 'data', 'cases')) || readdirIsEmpty(join(root, 'data', 'cases')),
        'a rejected code must not create any cache dir');
    });
  }

  it('rejects a missing argv (no code passed at all)', () => {
    // process.argv[2] is undefined -> `undefined ?? ''` -> empty string,
    // same path as an explicit "" (see the "empty string" case above).
    const { exit, stderr } = run(undefined);
    assert.equal(exit, 1);
    assert.match(stderr, /empty case code/);
  });

  function readdirIsEmpty(dir) {
    try { return readdirSync(dir).length === 0; } catch { return true; }
  }
});

describe('intake: corrupt on-disk state', () => {
  it('fails loudly on a corrupt _index.json instead of silently overwriting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'qc-intake-'));
    mkdirSync(join(root, 'data', 'cases'), { recursive: true });
    writeFileSync(join(root, 'data', 'cases', '_index.json'), '{ not valid json');
    const { exit, stderr } = run('08460319', root);
    assert.equal(exit, 1);
    assert.match(stderr, /corrupt _index\.json/);
    // The corrupt file must be left as-is for a human to inspect, not clobbered.
    assert.equal(readFileSync(join(root, 'data', 'cases', '_index.json'), 'utf8'), '{ not valid json');
  });
});
