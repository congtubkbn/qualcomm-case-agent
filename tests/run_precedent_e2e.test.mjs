// End-to-end tests for run_precedent.mjs's CLI (verdict + finalize subcommands) via spawnSync —
// prior art: tests/precedent_search_e2e.test.mjs. The log_query client is a real placeholder here
// (not mocked), so verdict runs land on "insufficient technical data to check" via its
// unavailable-result path — that path is itself real, contract-independent behavior worth
// covering end to end; precedent_verdict.mjs's own matched/unmatched paths are already covered by
// tests/precedent_verdict.test.mjs with the client mocked at the module level.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../.claude/skills/qualcomm-issue-precedent/scripts/run_precedent.mjs', import.meta.url)
);

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeInput(dir, data) {
  const p = join(dir, 'input.json');
  writeFileSync(p, JSON.stringify(data), 'utf8');
  return p;
}

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('run_precedent CLI: verdict', () => {
  it('prints {status, caseNumber, verdict, checks}, landing on "insufficient" via the real placeholder client', () => {
    const dir = tempDir('qc-precedent-verdict-');
    const inputPath = writeInput(dir, {
      candidate: { caseNumber: '08603854', signatures: [{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }] },
      selections: [{ signature: 'RRC_CONN_RELEASE', table: 'signalling' }],
      session: 'session-1',
    });

    const r = runCli(['verdict', '--input', inputPath]);
    assert.equal(r.exit, 0, `CLI failed: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'ok');
    assert.equal(output.caseNumber, '08603854');
    assert.equal(output.verdict, 'insufficient technical data to check');
    assert.equal(output.checks[0].result.unavailable, true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('errors when a selection is not verbatim in the candidate\'s signature list', () => {
    const dir = tempDir('qc-precedent-verdict-');
    const inputPath = writeInput(dir, {
      candidate: { caseNumber: '08603854', signatures: [{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }] },
      selections: [{ signature: 'MADE_UP', table: 'signalling' }],
      session: 'session-1',
    });

    const r = runCli(['verdict', '--input', inputPath]);
    assert.notEqual(r.exit, 0);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'error');
    assert.match(output.reason, /not in this candidate's extracted-signature list/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('errors when --input is missing', () => {
    const r = runCli(['verdict']);
    assert.notEqual(r.exit, 0);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'error');
  });
});

describe('run_precedent CLI: finalize', () => {
  it('persists the Markdown report and prints {status, reportPath}', () => {
    const dir = tempDir('qc-precedent-finalize-');
    const precedentDir = join(dir, '_precedent');
    const inputPath = writeInput(dir, {
      issueTitle: 'VoLTE call drop during driving test',
      issueRepro: 'Call drops mid-drive.',
      query: 'VoLTE call drop during driving test',
      candidates: [
        {
          caseNumber: '08603854',
          title: 'VoLTE call drop during driving test',
          rootCause: 'RRC_CONN_RELEASE sent prematurely',
          signatures: [{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }],
          selections: [{ signature: 'RRC_CONN_RELEASE', table: 'signalling' }],
          checks: [{ signature: 'RRC_CONN_RELEASE', table: 'signalling', source: 'rootCause', result: { unavailable: true, reason: 'n/a' } }],
          verdict: 'insufficient technical data to check',
        },
      ],
    });

    const r = runCli(['finalize', '--input', inputPath, `--precedent-dir=${precedentDir}`]);
    assert.equal(r.exit, 0, `CLI failed: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'ok');
    assert.ok(existsSync(output.reportPath));
    assert.ok(output.reportPath.startsWith(precedentDir));

    const content = readFileSync(output.reportPath, 'utf8');
    assert.match(content, /# Precedent Check — VoLTE call drop during driving test/);
    assert.match(content, /\[08603854\]/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('errors when issueTitle is missing', () => {
    const dir = tempDir('qc-precedent-finalize-');
    const inputPath = writeInput(dir, { candidates: [] });

    const r = runCli(['finalize', '--input', inputPath, `--precedent-dir=${join(dir, '_precedent')}`]);
    assert.notEqual(r.exit, 0);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'error');

    rmSync(dir, { recursive: true, force: true });
  });
});
