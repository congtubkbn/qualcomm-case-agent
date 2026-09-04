// log_query client: the sole call site for the external log_query.py tool (lives outside this
// repo, in the workspace where the team's separate RCA-framework tooling runs — see
// temps/rca-framework.md and issue #181). PLACEHOLDER MODULE: the real log_query.py invocation
// contract has not been supplied yet, so queryLogSignature() below never shells out — it always
// returns an `unavailable` result once its arguments check out. Every other module in this skill
// depends only on queryLogSignature()'s exported shape, never on log_query.py directly, so only
// this file needs rewriting once the real contract lands.

const TABLES = new Set(['signalling', 'trace']);

/**
 * Checks whether `signature` appears in one table of the new issue's decoded log.
 *
 * PLACEHOLDER: argument validation below is real, but the check itself always resolves as
 * `unavailable` — the real log_query.py contract is pending (see issue #181's "Further Notes").
 * @param {'signalling'|'trace'} table
 * @param {string} signature - verbatim signature string to test
 * @param {*} session - reference to the new issue's decoded log/session, opaque to this module
 * @returns {Promise<{matched: boolean, evidence: string[]}|{unavailable: true, reason: string}|{error: true, reason: string}>}
 */
export async function queryLogSignature(table, signature, session) {
  if (!TABLES.has(table)) {
    return { error: true, reason: `invalid table "${table}": expected "signalling" or "trace"` };
  }
  if (typeof signature !== 'string' || !signature.trim()) {
    return { error: true, reason: 'signature must be a non-empty string' };
  }
  if (session === undefined || session === null || session === '') {
    return { error: true, reason: 'session reference is required' };
  }

  return { unavailable: true, reason: 'log_query.py contract not yet available (see issue #181)' };
}
