// Offline CLI contract suite (#241): exercises all 4 qcomm CLI entry points —
// run_case, run_summary, delete_case, cases_overview — as real child
// processes (real stdout, real exit code), each against an isolated
// QUALCOMM_ROOT and FixturePortalDriver (via QCOMM_FIXTURE_DIR, wired in
// run_case.mjs for #241). No live Chrome, no network: this is what proves
// AC4 of #241 ("all tests run 100% offline") at the actual process boundary,
// not just via an in-process opts.driver import (see
// qcomm_fixture_portal_driver.test.mjs for that narrower proof).
//     node --test tests/qcomm_offline_cli_contract.test.mjs

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = fileURLToPath(new URL('../.claude/skills/qcomm/scripts/', import.meta.url));
const FIXTURE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'qcomm-cases');
const CODE = '08000099';

function scriptPath(name) {
  return join(SCRIPTS_DIR, name);
}

// Runs a qcomm CLI script as a real child process and returns its single
// stdout verdict line, parsed — whether the process exited 0 or not (a
// non-zero exit still prints exactly one JSON verdict line, per every
// script's own contract).
async function runCli(script, args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath(script), ...args], { env });
    return { stdout, verdict: JSON.parse(stdout.trim().split('\n').pop()), exitCode: 0 };
  } catch (e) {
    const stdout = typeof e.stdout === 'string' ? e.stdout : '';
    const line = stdout.trim().split('\n').pop();
    return { stdout, verdict: line ? JSON.parse(line) : null, exitCode: e.code };
  }
}

// Fresh QUALCOMM_ROOT (case cache) and a fresh copy of the fixture case dir
// (so a scenario that mutates raw.json between CLI calls never touches the
// committed fixture) — every test gets its own of both.
function makeIsolatedEnv() {
  const root = mkdtempSync(join(tmpdir(), 'qc-cli-contract-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'qc-cli-fixture-'));
  cpSync(join(FIXTURE_SOURCE, CODE), join(fixtureDir, CODE), { recursive: true });
  return {
    root,
    fixtureDir,
    env: {
      ...process.env,
      QUALCOMM_ROOT: root,
      QCOMM_FIXTURE_DIR: fixtureDir,
      QUALCOMM_NO_BROWSER: '1',
      NODE_ENV: 'test',
    },
  };
}

describe('offline CLI contract (#241)', () => {
  it('run_case: created -> updated -> no-update, one JSON verdict line each time, case.json/case.md written', async () => {
    const { root, fixtureDir, env } = makeIsolatedEnv();
    const caseDir = join(root, 'data', 'cases', CODE);
    const rawJsonPath = join(fixtureDir, CODE, 'raw.json');

    const created = await runCli('run_case.mjs', [CODE], env);
    assert.equal(created.exitCode, 0);
    assert.equal(created.stdout.trim().split('\n').length, 1);
    assert.equal(created.verdict.status, 'created');
    assert.ok(existsSync(join(caseDir, 'case.json')), 'case.json should be written');
    assert.ok(existsSync(join(caseDir, 'case.md')), 'case.md should be rendered');

    const raw = JSON.parse(readFileSync(rawJsonPath, 'utf8'));
    raw.comments.push({
      author: 'Qualcomm Engineer',
      body: 'Second synthetic fixture comment, added for the updated-verdict path.',
      timestamp: '2026-01-03T10:00:00.000Z',
    });
    writeFileSync(rawJsonPath, JSON.stringify(raw, null, 2));

    const updated = await runCli('run_case.mjs', [CODE], env);
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.verdict.status, 'updated');

    const noUpdate = await runCli('run_case.mjs', [CODE], env);
    assert.equal(noUpdate.exitCode, 0);
    assert.equal(noUpdate.verdict.status, 'no-update');
  });

  it('run_summary: prepare -> finalize against a freshly captured case, summary.json/summary.md written', async () => {
    const { root, env } = makeIsolatedEnv();
    const caseDir = join(root, 'data', 'cases', CODE);

    const captured = await runCli('run_case.mjs', [CODE], env);
    assert.equal(captured.verdict.status, 'created');

    const prepared = await runCli('run_summary.mjs', ['prepare', CODE], env);
    assert.equal(prepared.exitCode, 0);
    assert.equal(prepared.stdout.trim().split('\n').length, 1);
    assert.equal(prepared.verdict.status, 'needs-summary');
    assert.ok(prepared.verdict.deltaComments.length > 0);

    const inputPath = join(root, 'summary-input.json');
    writeFileSync(inputPath, JSON.stringify({
      comments: prepared.verdict.deltaComments.map((c) => ({ ...c, kind: 'note', summary: 'Fixture summary.' })),
      flow: 'Fixture case flow narrative.',
    }));

    const finalized = await runCli('run_summary.mjs', ['finalize', CODE, '--input', inputPath], env);
    assert.equal(finalized.exitCode, 0);
    assert.equal(finalized.stdout.trim().split('\n').length, 1);
    assert.equal(finalized.verdict.status, 'summarized');
    assert.ok(existsSync(join(caseDir, 'summary.json')), 'summary.json should be written');
    assert.ok(existsSync(join(caseDir, 'summary.md')), 'summary.md should be rendered');
  });

  it('cases_overview: --rebuild --json writes _overview.json and dashboard.html', async () => {
    const { root, env } = makeIsolatedEnv();
    const casesDir = join(root, 'data', 'cases');

    const captured = await runCli('run_case.mjs', [CODE], env);
    assert.equal(captured.verdict.status, 'created');

    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath('cases_overview.mjs'), '--rebuild', '--json', '--no-open'],
      { env },
    );
    const overview = JSON.parse(stdout);
    assert.ok(Array.isArray(overview.cases));
    assert.ok(overview.cases.some((c) => c.caseNumber === CODE));
    assert.ok(existsSync(join(casesDir, '_overview.json')), '_overview.json should be written');
    assert.ok(existsSync(join(casesDir, 'dashboard.html')), 'dashboard.html should be rendered');
  });

  it('delete_case: deleted verdict, one JSON line, cache and overview entry removed', async () => {
    const { root, env } = makeIsolatedEnv();
    const caseDir = join(root, 'data', 'cases', CODE);

    const captured = await runCli('run_case.mjs', [CODE], env);
    assert.equal(captured.verdict.status, 'created');

    const deleted = await runCli('delete_case.mjs', [CODE, '--yes'], env);
    assert.equal(deleted.exitCode, 0);
    assert.equal(deleted.stdout.trim().split('\n').length, 1);
    assert.equal(deleted.verdict.status, 'deleted');
    assert.ok(!existsSync(caseDir), 'case directory should be removed');

    const overview = JSON.parse(readFileSync(join(root, 'data', 'cases', '_overview.json'), 'utf8'));
    assert.ok(!overview.cases.some((c) => c.caseNumber === CODE), 'deleted case should be gone from the overview');
  });
});
