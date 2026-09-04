// Tests for log_query_client.mjs's placeholder implementation: real argument validation, but the
// actual check always resolves as `unavailable` until the real log_query.py contract lands.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queryLogSignature } from '../.claude/skills/qualcomm-issue-precedent/scripts/log_query_client.mjs';

describe('log_query_client: queryLogSignature', () => {
  it('rejects a table other than signalling/trace', async () => {
    const result = await queryLogSignature('bogus', 'RRC_CONN_RELEASE', 'session-1');
    assert.equal(result.error, true);
    assert.match(result.reason, /invalid table/);
  });

  it('rejects an empty or non-string signature', async () => {
    assert.equal((await queryLogSignature('signalling', '', 'session-1')).error, true);
    assert.equal((await queryLogSignature('signalling', '   ', 'session-1')).error, true);
    assert.equal((await queryLogSignature('signalling', null, 'session-1')).error, true);
  });

  it('rejects a missing session reference', async () => {
    const result = await queryLogSignature('trace', 'RRC_CONN_RELEASE', '');
    assert.equal(result.error, true);
    assert.match(result.reason, /session/);
  });

  it('returns unavailable for valid arguments on both tables', async () => {
    const signalling = await queryLogSignature('signalling', 'RRC_CONN_RELEASE', 'session-1');
    assert.deepEqual(signalling, { unavailable: true, reason: signalling.reason });
    assert.match(signalling.reason, /log_query\.py/);

    const trace = await queryLogSignature('trace', 'cause #58', 'session-1');
    assert.equal(trace.unavailable, true);
  });
});
