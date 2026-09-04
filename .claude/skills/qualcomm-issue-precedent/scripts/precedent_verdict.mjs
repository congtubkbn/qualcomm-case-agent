// Verdict-synthesis logic: given a Reference Case candidate (precedent_store.mjs's output,
// including its verbatim extracted signatures) and the subset of those signatures selected for
// testing, checks each one against the new issue's decoded log via the log_query client module
// and synthesizes one overall verdict. Enforces, rather than trusts the caller on, the rule that
// a selected signature must already appear verbatim in the candidate's own extracted-signature
// list — nothing tested here is guessed.
import { queryLogSignature } from './log_query_client.mjs';

export const VERDICT_MATCHED = 'matched known cause';
export const VERDICT_NO_MATCH = 'does not match';
export const VERDICT_INSUFFICIENT = 'insufficient technical data to check';

/**
 * Classifies one log_query_client result as 'matched'/'unmatched', or 'indeterminate' when the
 * tool couldn't confirm either way (unavailable/error).
 * @param {object} result
 * @returns {'matched'|'unmatched'|'indeterminate'}
 */
function classifyResult(result) {
  if (result && typeof result === 'object' && 'matched' in result) {
    return result.matched ? 'matched' : 'unmatched';
  }
  return 'indeterminate';
}

/**
 * Synthesizes a verdict for one candidate by checking each selected signature against the new
 * issue's log. Throws if a selection names a signature that isn't present verbatim in the
 * candidate's own extracted-signature list (a caller precondition, checked before any query
 * runs) — this function is the one place that invariant is enforced, not left to callers.
 * @param {{signatures: Array<{signature: string, source: string}>}} candidate - a #182 candidate
 * @param {Array<{signature: string, table: 'signalling'|'trace'}>} selections - signatures selected for testing, each naming which log table to check
 * @param {*} session - reference to the new issue's decoded log/session, passed through to the log_query client verbatim
 * @returns {Promise<{verdict: string, checks: Array<{signature: string, table: string, source: string, result: object}>}>}
 */
export async function synthesizeVerdict(candidate, selections, session) {
  const knownSignatures = candidate.signatures || [];

  if (knownSignatures.length === 0 || !selections || selections.length === 0) {
    return { verdict: VERDICT_INSUFFICIENT, checks: [] };
  }

  for (const { signature } of selections) {
    if (!knownSignatures.some((s) => s.signature === signature)) {
      throw new Error(
        `synthesizeVerdict: signature "${signature}" is not in this candidate's extracted-signature list`
      );
    }
  }

  const checks = [];
  for (const { signature, table } of selections) {
    const source = knownSignatures.find((s) => s.signature === signature).source;
    const result = await queryLogSignature(table, signature, session);
    checks.push({ signature, table, source, result });
  }

  const classifications = checks.map((c) => classifyResult(c.result));
  let verdict;
  if (classifications.includes('matched')) {
    verdict = VERDICT_MATCHED;
  } else if (classifications.every((c) => c === 'unmatched')) {
    verdict = VERDICT_NO_MATCH;
  } else {
    verdict = VERDICT_INSUFFICIENT;
  }

  return { verdict, checks };
}
