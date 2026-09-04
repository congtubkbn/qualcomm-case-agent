// Unit tests for precedent_store's Reference Case filtering, scoring, and signature extraction.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildReferenceCase,
  buildReferenceCaseCorpus,
  collectSignatures,
  extractSignaturesFromText,
  overlapCount,
  scoreCandidate,
  searchPrecedents,
  tokenize,
} from '../.claude/skills/qualcomm-issue-precedent/scripts/precedent_store.mjs';

function createTempCasesDir() {
  return mkdtempSync(join(tmpdir(), 'qc-precedent-test-'));
}

function writeCase(casesDir, caseNumber, caseJson, summaryJson) {
  const caseDir = join(casesDir, caseNumber);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'case.json'), JSON.stringify({ caseNumber, ...caseJson }, null, 2), 'utf8');
  if (summaryJson !== undefined) {
    writeFileSync(join(caseDir, 'summary.json'), JSON.stringify({ caseNumber, ...summaryJson }, null, 2), 'utf8');
  }
}

describe('precedent_store: tokenize / overlapCount', () => {
  it('lowercases, strips punctuation, and drops stopwords/short tokens', () => {
    const tokens = tokenize('VoLTE call drop during the driving test!');
    assert.ok(tokens.has('volte'));
    assert.ok(tokens.has('call'));
    assert.ok(tokens.has('drop'));
    assert.ok(tokens.has('driving'));
    assert.ok(tokens.has('during'));
    assert.ok(!tokens.has('the'));
  });

  it('handles null/empty text', () => {
    assert.deepEqual(tokenize(null), new Set());
    assert.deepEqual(tokenize(''), new Set());
  });

  it('counts shared tokens between two sets', () => {
    assert.equal(overlapCount(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd'])), 2);
    assert.equal(overlapCount(new Set(), new Set(['a'])), 0);
  });
});

describe('precedent_store: extractSignaturesFromText', () => {
  it('extracts ALL_CAPS_WITH_UNDERSCORES identifiers verbatim', () => {
    const sigs = extractSignaturesFromText('Root cause: RRC_CONN_RELEASE sent before EMM_CAUSE_ILLEGAL_UE.');
    assert.deepEqual(sigs, ['RRC_CONN_RELEASE', 'EMM_CAUSE_ILLEGAL_UE']);
  });

  it('extracts cause codes verbatim', () => {
    const sigs = extractSignaturesFromText('Network rejects registration with cause #58 during attach.');
    assert.deepEqual(sigs, ['cause #58']);
  });

  it('extracts hex literals verbatim', () => {
    const sigs = extractSignaturesFromText('Failure reason encoded as 0x1A2B in the trace.');
    assert.deepEqual(sigs, ['0x1A2B']);
  });

  it('returns an empty list when there is no matching token, never a guess', () => {
    assert.deepEqual(extractSignaturesFromText('Investigation still ongoing, nothing conclusive yet.'), []);
    assert.deepEqual(extractSignaturesFromText(''), []);
    assert.deepEqual(extractSignaturesFromText(null), []);
  });

  it('deduplicates repeated signatures in first-seen order', () => {
    const sigs = extractSignaturesFromText('NAS_MSG_TYPE seen twice: NAS_MSG_TYPE mismatch.');
    assert.deepEqual(sigs, ['NAS_MSG_TYPE']);
  });
});

describe('precedent_store: collectSignatures', () => {
  it('tags each signature with its source field or comment id, verbatim only', () => {
    const executive = {
      rootCause: 'nr5g_full_voice_support forced EPSFB via RRC_CONN_RELEASE',
      resolution: 'Fixed by disabling cause #58 handling in modem firmware',
    };
    const comments = [
      { id: 'c1', body: 'Saw NAS_MSG_TYPE mismatch in the log' },
      { id: 'c2', body: 'No new information here.' },
    ];

    const sigs = collectSignatures(executive, comments);
    assert.deepEqual(sigs, [
      { signature: 'RRC_CONN_RELEASE', source: 'rootCause' },
      { signature: 'cause #58', source: 'resolution' },
      { signature: 'NAS_MSG_TYPE', source: 'comment:c1' },
    ]);
  });

  it('does not repeat a signature already attributed to an earlier source', () => {
    const executive = { rootCause: 'RRC_CONN_RELEASE observed', resolution: '' };
    const comments = [{ id: 'c1', body: 'Confirmed RRC_CONN_RELEASE again in the log' }];
    const sigs = collectSignatures(executive, comments);
    assert.deepEqual(sigs, [{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }]);
  });

  it('returns an empty list for a case with no comments and no matching tokens', () => {
    assert.deepEqual(collectSignatures({ rootCause: 'Unclear at this time', resolution: '' }, []), []);
  });
});

describe('precedent_store: buildReferenceCase', () => {
  it('builds a Reference Case when executive.rootCause is a non-empty string', () => {
    const casesDir = createTempCasesDir();
    writeCase(
      casesDir,
      '08111111',
      {
        title: '[SM7635] VoLTE call drop during driving test',
        product: 'SM7635',
        url: 'https://support.qualcomm.com/s/case/1',
        comments: [{ id: 'c1', body: 'RRC_CONN_RELEASE seen right before drop.' }],
      },
      {
        executive: { rootCause: 'RRC_CONN_RELEASE sent prematurely by network', resolution: 'CR1234 fix delivered' },
        flow: 'Investigated modem logs, found premature release.',
      }
    );

    const record = buildReferenceCase(join(casesDir, '08111111'), '08111111');
    assert.ok(record);
    assert.equal(record.caseNumber, '08111111');
    assert.equal(record.title, '[SM7635] VoLTE call drop during driving test');
    assert.equal(record.rootCause, 'RRC_CONN_RELEASE sent prematurely by network');
    assert.equal(record.resolution, 'CR1234 fix delivered');
    assert.equal(record.flow, 'Investigated modem logs, found premature release.');
    assert.equal(record.product, 'SM7635');
    assert.ok(record.signatures.some((s) => s.signature === 'RRC_CONN_RELEASE' && s.source === 'rootCause'));

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('excludes a Case entirely (not just ranks low) when rootCause is missing or empty', () => {
    const casesDir = createTempCasesDir();
    writeCase(casesDir, '08222222', { title: 'No summary at all', comments: [] }, undefined);
    writeCase(casesDir, '08333333', { title: 'Empty rootCause', comments: [] }, { executive: { rootCause: '' } });
    writeCase(casesDir, '08444444', { title: 'Whitespace rootCause', comments: [] }, { executive: { rootCause: '   ' } });
    writeCase(casesDir, '08555555', { title: 'No executive block', comments: [] }, { flow: 'Some flow' });

    assert.equal(buildReferenceCase(join(casesDir, '08222222'), '08222222'), null);
    assert.equal(buildReferenceCase(join(casesDir, '08333333'), '08333333'), null);
    assert.equal(buildReferenceCase(join(casesDir, '08444444'), '08444444'), null);
    assert.equal(buildReferenceCase(join(casesDir, '08555555'), '08555555'), null);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('returns null for a missing directory or corrupt case.json', () => {
    const casesDir = createTempCasesDir();
    assert.equal(buildReferenceCase(join(casesDir, 'nope'), 'nope'), null);

    const corruptDir = join(casesDir, 'corrupt');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'case.json'), '{not-json', 'utf8');
    writeFileSync(join(corruptDir, 'summary.json'), JSON.stringify({ executive: { rootCause: 'x' } }), 'utf8');
    assert.equal(buildReferenceCase(corruptDir, 'corrupt'), null);

    rmSync(casesDir, { recursive: true, force: true });
  });
});

describe('precedent_store: buildReferenceCaseCorpus', () => {
  it('scans case directories and keeps only qualifying Reference Cases', () => {
    const casesDir = createTempCasesDir();
    writeCase(casesDir, '08111111', { title: 'Case A' }, { executive: { rootCause: 'Cause A' } });
    writeCase(casesDir, '08222222', { title: 'Case B, no rootCause' }, { executive: { rootCause: '' } });
    writeFileSync(join(casesDir, '_index.json'), JSON.stringify({}), 'utf8');

    const corpus = buildReferenceCaseCorpus(casesDir);
    assert.equal(corpus.length, 1);
    assert.equal(corpus[0].caseNumber, '08111111');

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('returns an empty array for a missing cases directory', () => {
    assert.deepEqual(buildReferenceCaseCorpus('/nonexistent/path/for/test'), []);
  });
});

describe('precedent_store: scoreCandidate / searchPrecedents', () => {
  it('weights title/rootCause overlap higher than flow overlap', () => {
    const queryTokens = tokenize('handover failure');
    const titleMatch = scoreCandidate(queryTokens, { title: 'handover failure', rootCause: '', flow: '', product: '' });
    const flowMatch = scoreCandidate(queryTokens, { title: '', rootCause: '', flow: 'handover failure', product: '' });
    assert.ok(titleMatch > flowMatch);
  });

  it('boosts score on shared product token without excluding non-matching product cases', () => {
    const queryTokens = tokenize('registration reject SDX75');
    const withProduct = scoreCandidate(queryTokens, { title: '', rootCause: '', flow: '', product: 'SDX75' });
    const withoutProduct = scoreCandidate(queryTokens, { title: '', rootCause: '', flow: '', product: 'SM7635' });
    assert.ok(withProduct > withoutProduct);
    assert.equal(withoutProduct, 0);
  });

  it('ranks candidates by deterministic keyword overlap, highest score first', () => {
    const casesDir = createTempCasesDir();
    writeCase(
      casesDir,
      '08100001',
      { title: 'VoLTE call drop during driving test', product: 'SM7635' },
      { executive: { rootCause: 'RRC_CONN_RELEASE sent prematurely' }, flow: 'Not related to VoLTE' }
    );
    writeCase(
      casesDir,
      '08100002',
      { title: 'eCall fail in limited network', product: 'SDX75' },
      { executive: { rootCause: 'Registration reject cause #58' }, flow: 'No VoLTE involvement' }
    );

    const results = searchPrecedents('VoLTE call drop during driving test', casesDir, 10);
    assert.equal(results.length, 2);
    assert.equal(results[0].caseNumber, '08100001');
    assert.ok(results[0].score > results[1].score);

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('breaks score ties by ascending case number', () => {
    const casesDir = createTempCasesDir();
    writeCase(casesDir, '08200002', { title: 'Unrelated' }, { executive: { rootCause: 'Unrelated cause' } });
    writeCase(casesDir, '08200001', { title: 'Also unrelated' }, { executive: { rootCause: 'Also unrelated cause' } });

    const results = searchPrecedents('completely different query text', casesDir, 10);
    assert.equal(results[0].score, 0);
    assert.equal(results[1].score, 0);
    assert.equal(results[0].caseNumber, '08200001');
    assert.equal(results[1].caseNumber, '08200002');

    rmSync(casesDir, { recursive: true, force: true });
  });

  it('respects the limit parameter', () => {
    const casesDir = createTempCasesDir();
    for (let i = 0; i < 5; i++) {
      writeCase(casesDir, `0810000${i}`, { title: `Case ${i}` }, { executive: { rootCause: `Cause ${i}` } });
    }
    const results = searchPrecedents('case', casesDir, 2);
    assert.equal(results.length, 2);

    rmSync(casesDir, { recursive: true, force: true });
  });
});
