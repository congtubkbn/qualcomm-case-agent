// Tests for precedent_verdict.mjs's verdict-synthesis logic. log_query_client.mjs is mocked at
// the module level (node --experimental-test-module-mocks) so these assert on call arguments and
// verdict synthesis without any real log_query.py contract.
//     node --experimental-test-module-mocks --test tests/precedent_verdict.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SCRIPTS = new URL('../.claude/skills/qualcomm-issue-precedent/scripts/', import.meta.url);
const LOG_QUERY_CLIENT_URL = new URL('log_query_client.mjs', SCRIPTS);

function mockLogQueryClient(t, handler) {
  const calls = [];
  t.mock.module(LOG_QUERY_CLIENT_URL, {
    namedExports: {
      queryLogSignature: async (table, signature, session) => {
        calls.push({ table, signature, session });
        return handler(table, signature, session);
      },
    },
  });
  return calls;
}

let seq = 0;
const importVerdict = () => import(new URL(`precedent_verdict.mjs?t=${++seq}`, SCRIPTS));

const candidateWith = (signatures) => ({
  caseNumber: '08100001',
  title: 'VoLTE call drop',
  signatures,
});

describe('precedent_verdict: synthesizeVerdict', () => {
  it('returns insufficient data when the candidate has no extracted signatures', async (t) => {
    mockLogQueryClient(t, () => {
      throw new Error('must not be called');
    });
    const { synthesizeVerdict, VERDICT_INSUFFICIENT } = await importVerdict();

    const result = await synthesizeVerdict(candidateWith([]), [{ signature: 'X', table: 'signalling' }], 'session-1');
    assert.equal(result.verdict, VERDICT_INSUFFICIENT);
    assert.deepEqual(result.checks, []);
  });

  it('returns insufficient data when no signatures are selected, even if the candidate has some', async (t) => {
    mockLogQueryClient(t, () => {
      throw new Error('must not be called');
    });
    const { synthesizeVerdict, VERDICT_INSUFFICIENT } = await importVerdict();

    const candidate = candidateWith([{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }]);
    const result = await synthesizeVerdict(candidate, [], 'session-1');
    assert.equal(result.verdict, VERDICT_INSUFFICIENT);
    assert.deepEqual(result.checks, []);
  });

  it('throws when a selected signature is not verbatim in the candidate list, before querying anything', async (t) => {
    const calls = mockLogQueryClient(t, () => ({ matched: true, evidence: [] }));
    const { synthesizeVerdict } = await importVerdict();

    const candidate = candidateWith([{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }]);
    await assert.rejects(
      () => synthesizeVerdict(candidate, [{ signature: 'MADE_UP_SIGNATURE', table: 'signalling' }], 'session-1'),
      /not in this candidate's extracted-signature list/
    );
    assert.equal(calls.length, 0);
  });

  it('synthesizes "matched known cause" when any selected signature matches', async (t) => {
    mockLogQueryClient(t, (table, signature) =>
      signature === 'RRC_CONN_RELEASE' ? { matched: true, evidence: ['hit at t=12.3s'] } : { matched: false, evidence: [] }
    );
    const { synthesizeVerdict, VERDICT_MATCHED } = await importVerdict();

    const candidate = candidateWith([
      { signature: 'RRC_CONN_RELEASE', source: 'rootCause' },
      { signature: 'NAS_MSG_TYPE', source: 'comment:c1' },
    ]);
    const selections = [
      { signature: 'NAS_MSG_TYPE', table: 'trace' },
      { signature: 'RRC_CONN_RELEASE', table: 'signalling' },
    ];
    const result = await synthesizeVerdict(candidate, selections, 'session-1');

    assert.equal(result.verdict, VERDICT_MATCHED);
    assert.equal(result.checks.length, 2);
    assert.deepEqual(result.checks[1], {
      signature: 'RRC_CONN_RELEASE',
      table: 'signalling',
      source: 'rootCause',
      result: { matched: true, evidence: ['hit at t=12.3s'] },
    });
  });

  it('synthesizes "does not match" when every selected signature comes back unmatched', async (t) => {
    mockLogQueryClient(t, () => ({ matched: false, evidence: [] }));
    const { synthesizeVerdict, VERDICT_NO_MATCH } = await importVerdict();

    const candidate = candidateWith([{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }]);
    const result = await synthesizeVerdict(candidate, [{ signature: 'RRC_CONN_RELEASE', table: 'signalling' }], 'session-1');

    assert.equal(result.verdict, VERDICT_NO_MATCH);
  });

  it('synthesizes "insufficient technical data" when a check is unavailable and none matched', async (t) => {
    mockLogQueryClient(t, () => ({ unavailable: true, reason: 'log_query.py contract not yet available' }));
    const { synthesizeVerdict, VERDICT_INSUFFICIENT } = await importVerdict();

    const candidate = candidateWith([{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }]);
    const result = await synthesizeVerdict(candidate, [{ signature: 'RRC_CONN_RELEASE', table: 'signalling' }], 'session-1');

    assert.equal(result.verdict, VERDICT_INSUFFICIENT);
    assert.equal(result.checks[0].result.unavailable, true);
  });

  it('synthesizes "insufficient technical data" when a check errors and none matched', async (t) => {
    mockLogQueryClient(t, () => ({ error: true, reason: 'boom' }));
    const { synthesizeVerdict, VERDICT_INSUFFICIENT } = await importVerdict();

    const candidate = candidateWith([{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }]);
    const result = await synthesizeVerdict(candidate, [{ signature: 'RRC_CONN_RELEASE', table: 'signalling' }], 'session-1');

    assert.equal(result.verdict, VERDICT_INSUFFICIENT);
  });

  it('still reports "matched known cause" even if another selected signature is unavailable', async (t) => {
    mockLogQueryClient(t, (table, signature) =>
      signature === 'RRC_CONN_RELEASE' ? { matched: true, evidence: [] } : { unavailable: true, reason: 'n/a' }
    );
    const { synthesizeVerdict, VERDICT_MATCHED } = await importVerdict();

    const candidate = candidateWith([
      { signature: 'RRC_CONN_RELEASE', source: 'rootCause' },
      { signature: 'cause #58', source: 'resolution' },
    ]);
    const selections = [
      { signature: 'cause #58', table: 'signalling' },
      { signature: 'RRC_CONN_RELEASE', table: 'signalling' },
    ];
    const result = await synthesizeVerdict(candidate, selections, 'session-1');
    assert.equal(result.verdict, VERDICT_MATCHED);
  });

  it('passes table, signature, and session through to the log_query client verbatim', async (t) => {
    const calls = mockLogQueryClient(t, () => ({ matched: false, evidence: [] }));
    const { synthesizeVerdict } = await importVerdict();

    const candidate = candidateWith([{ signature: 'RRC_CONN_RELEASE', source: 'rootCause' }]);
    await synthesizeVerdict(candidate, [{ signature: 'RRC_CONN_RELEASE', table: 'trace' }], 'session-xyz');

    assert.deepEqual(calls, [{ table: 'trace', signature: 'RRC_CONN_RELEASE', session: 'session-xyz' }]);
  });
});
