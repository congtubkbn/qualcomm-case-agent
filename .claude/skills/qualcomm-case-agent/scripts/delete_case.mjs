// delete_case.mjs — permanent, agent-confirmed removal of one case's local cache.
//
//     node delete_case.mjs <CODE> --yes
//
// Deletion is always mediated by the Claude Code agent in chat (ADR 0003):
// the agent confirms with the user, then constructs this exact command. There
// is no interactive prompt here, and no direct-delete affordance anywhere else
// — `--yes` is defense-in-depth, not the primary confirmation gate.
//
// stdout is exactly ONE JSON line (the verdict). Everything else goes to stderr.
//
// Verdict `status`:
//   deleted     -> exit 0
//   not-found   -> exit 4  (matches run_case.mjs's not-found code)
//   busy        -> exit 6  (another capture holds the lock — retry later)
//   error       -> exit 1

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { updateCaseOverview } from '../../qualcomm-case-overview/scripts/cases_overview.mjs';

export const STATUS_EXIT = {
  deleted: 0, 'not-found': 4, busy: 6, error: 1,
};

/**
 * Delete one case's entire local cache: its directory, its _index.json entry,
 * then resync the qualcomm-case-overview aggregation/dashboard. Pure fs
 * operations against an injectable dataDir — no browser, no lock, no CLI
 * parsing (that's the thin wrapper below).
 * @returns {{status: 'deleted'|'not-found'|'error', code?: string, reason?: string}}
 */
export function deleteCase(rawCode, dataDir = DATA_DIR) {
  const code = String(rawCode ?? '').trim().replace(/^CASE-/i, '');
  if (!/^\d{8}$/.test(code)) {
    return { status: 'error', reason: `case code must be 8 digits (got: ${rawCode})` };
  }

  const caseDir = join(dataDir, code);
  if (!existsSync(caseDir)) {
    return { status: 'not-found', code, reason: `no local cache for case ${code}` };
  }

  rmSync(caseDir, { recursive: true, force: true });

  const indexPath = join(dataDir, '_index.json');
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (Object.prototype.hasOwnProperty.call(index, code)) {
        delete index[code];
        writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
      }
    } catch {
      // Corrupt _index.json is not this function's problem to fix; the
      // directory delete (the primary effect) already succeeded.
    }
  }

  updateCaseOverview(code, dataDir);

  return { status: 'deleted', code };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rawCode = process.argv[2];
  const yes = process.argv.slice(3).includes('--yes');

  if (!yes) {
    const verdict = { status: 'error', code: rawCode, reason: 'refused: --yes flag required to delete a case' };
    process.stdout.write(JSON.stringify(verdict) + '\n');
    process.exit(STATUS_EXIT.error);
  }

  const lock = acquireLock(undefined, Date.now(), rawCode);
  if (!lock.ok) {
    const verdict = {
      status: 'busy',
      code: rawCode,
      reason: `another capture is running (pid ${lock.holder.pid} since ${lock.holder.at})`,
    };
    process.stdout.write(JSON.stringify(verdict) + '\n');
    process.exit(STATUS_EXIT.busy);
  }

  let verdict;
  try {
    verdict = deleteCase(rawCode);
  } catch (e) {
    verdict = { status: 'error', code: rawCode, reason: e.message };
  } finally {
    releaseLock();
  }
  process.stdout.write(JSON.stringify(verdict) + '\n');
  process.exit(STATUS_EXIT[verdict.status] ?? 1);
}
