// End-to-end tests for precedent_search.mjs CLI via spawnSync against fixture case
// directories in a temp dir (prior art: tests/cases_overview_e2e.test.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../.claude/skills/qualcomm-issue-precedent/scripts/precedent_search.mjs', import.meta.url)
);

function createTempCasesDir() {
  return mkdtempSync(join(tmpdir(), 'qc-precedent-e2e-'));
}

function writeCase(casesDir, caseNumber, caseJson, summaryJson) {
  const caseDir = join(casesDir, caseNumber);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'case.json'), JSON.stringify({ caseNumber, ...caseJson }, null, 2), 'utf8');
  if (summaryJson !== undefined) {
    writeFileSync(join(caseDir, 'summary.json'), JSON.stringify({ caseNumber, ...summaryJson }, null, 2), 'utf8');
  }
}

function runCli(args, casesDir) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, `--cases-dir=${casesDir}`], { encoding: 'utf8' });
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('precedent_search CLI', () => {
  it('prints {status, query, candidates} and only surfaces Reference Cases', () => {
    const casesDir = createTempCasesDir();
    writeCase(
      casesDir,
      '08603854',
      {
        title: '[SM7635] VoLTE call drop during driving test',
        product: 'SM7635',
        url: 'https://support.qualcomm.com/s/case/500dK00000Njp7aQAB',
        comments: [{ id: 'c1', author: 'Eng A', timestamp: 'July 1, 2026', body: 'RRC_CONN_RELEASE seen before drop.' }],
      },
      {
        executive: { rootCause: 'RRC_CONN_RELEASE sent prematurely by network', resolution: 'CR1234 fix delivered' },
        flow: 'Investigated modem logs, found premature release during driving test.',
      }
    );
    // No summary.json at all -> not a Reference Case, must never appear as a candidate.
    writeCase(casesDir, '08999999', {
      title: '[SM7635] Unrelated open case, no summary yet',
      product: 'SM7635',
      comments: [],
    });
    // summary.json present but rootCause empty -> excluded entirely, not merely ranked low.
    writeCase(
      casesDir,
      '08888888',
      { title: '[SM7635] Another open case', product: 'SM7635', comments: [] },
      { executive: { rootCause: '' }, flow: 'Still investigating.' }
    );

    const r = runCli(['VoLTE', 'call', 'drop', 'during', 'driving', 'test'], casesDir);
    assert.equal(r.exit, 0, `CLI failed: ${r.stderr}`);

    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'ok');
    assert.equal(output.query, 'VoLTE call drop during driving test');
    assert.equal(output.candidates.length, 1);

    const candidate = output.candidates[0];
    assert.equal(candidate.caseNumber, '08603854');
    assert.equal(candidate.rootCause, 'RRC_CONN_RELEASE sent prematurely by network');
    assert.equal(candidate.resolution, 'CR1234 fix delivered');
    assert.equal(candidate.flow, 'Investigated modem logs, found premature release during driving test.');
    assert.equal(candidate.product, 'SM7635');
    assert.equal(candidate.url, 'https://support.qualcomm.com/s/case/500dK00000Njp7aQAB');
    assert.ok(candidate.signatures.some((s) => s.signature === 'RRC_CONN_RELEASE' && s.source === 'rootCause'));

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('ranks candidates by keyword overlap and applies the product soft boost', () => {
    const casesDir = createTempCasesDir();
    writeCase(
      casesDir,
      '08100001',
      { title: '5G SA Registration Reject during attach', product: 'SDX75' },
      { executive: { rootCause: 'Registration reject cause #58 from network' }, flow: 'Not applicable' }
    );
    writeCase(
      casesDir,
      '08100002',
      { title: 'Unrelated audio glitch', product: 'SM7635' },
      { executive: { rootCause: 'Codec buffer underrun' }, flow: 'Unrelated to registration' }
    );

    const r = runCli(['5G', 'SA', 'Registration', 'Reject', 'SDX75'], casesDir);
    assert.equal(r.exit, 0, `CLI failed: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.candidates.length, 2);
    assert.equal(output.candidates[0].caseNumber, '08100001');
    assert.ok(output.candidates[0].score > output.candidates[1].score);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('supports --limit to cap the number of candidates', () => {
    const casesDir = createTempCasesDir();
    for (let i = 0; i < 4; i++) {
      writeCase(casesDir, `0820000${i}`, { title: `Case ${i}` }, { executive: { rootCause: `Cause ${i}` } });
    }
    const r = runCli(['case', '--limit=2'], casesDir);
    assert.equal(r.exit, 0, `CLI failed: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.candidates.length, 2);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('returns an empty candidates list when the corpus has no Reference Cases', () => {
    const casesDir = createTempCasesDir();
    writeCase(casesDir, '08700001', { title: 'Open case', comments: [] });

    const r = runCli(['anything'], casesDir);
    assert.equal(r.exit, 0, `CLI failed: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'ok');
    assert.deepEqual(output.candidates, []);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('errors when no query text is given', () => {
    const casesDir = createTempCasesDir();
    const r = runCli([], casesDir);
    assert.notEqual(r.exit, 0);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.status, 'error');

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('supports --help', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('Usage: node .claude/skills/qualcomm-issue-precedent/scripts/precedent_search.mjs'));
  });
});
