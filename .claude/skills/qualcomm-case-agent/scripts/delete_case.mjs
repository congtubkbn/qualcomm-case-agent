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
import { normalizeCaseCode } from './intake.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { syncCaseOverview } from '../../qualcomm-case-overview/scripts/cases_overview.mjs';

export const STATUS_EXIT = {
  deleted: 0, 'not-found': 4, busy: 6, error: 1,
};

/**
 * Delete one case's entire local cache: its directory, its _index.json entry,
 * then resync the qualcomm-case-overview aggregation/dashboard. Pure fs
 * operations against an injectable dataDir — no browser, no lock, no CLI
 * parsing (that's the thin wrapper below).
 *
 * The directory may already be gone (deleted out-of-band, outside this
 * script) while `_index.json`/`_overview.json`/`dashboard.html` still list
 * it — in that case this still cleans up those stale entries and reports
 * "deleted", since the end state the caller wants (case gone everywhere,
 * including the dashboard) is reached either way.
 * @param {string} rawCode
 * @param {string} [dataDir=DATA_DIR]
 * @param {object} [options={}] Optional configuration (e.g. dependency-injected syncCaseOverview, renderDashboard, onError)
 * @returns {{status: 'deleted'|'not-found'|'error', code?: string, reason?: string}}
 */
export function deleteCase(rawCode, dataDir = DATA_DIR, options = {}) {
  let code;
  try {
    code = normalizeCaseCode(rawCode);
  } catch (e) {
    return { status: 'error', reason: e.message };
  }

  const caseDir = join(dataDir, code);
  const dirExisted = existsSync(caseDir);
  if (dirExisted) {
    rmSync(caseDir, { recursive: true, force: true });
  }

  const indexPath = join(dataDir, '_index.json');
  let hadIndexEntry = false;
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      hadIndexEntry = Object.prototype.hasOwnProperty.call(index, code);
      if (hadIndexEntry) {
        delete index[code];
        writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
      }
    } catch {
      // Corrupt _index.json is not this function's problem to fix; the
      // directory delete (the primary effect) already succeeded.
    }
  }

  const syncFn = options.syncCaseOverview || syncCaseOverview;
  const { hadEntry: hadOverviewEntry } = syncFn(code, {
    ...options,
    casesDir: dataDir,
    action: 'remove',
  });

  if (!dirExisted && !hadIndexEntry && !hadOverviewEntry) {
    return { status: 'not-found', code, reason: `no local cache for case ${code}` };
  }

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

  let code;
  try {
    code = normalizeCaseCode(rawCode);
  } catch (e) {
    const verdict = { status: 'error', code: rawCode, reason: e.message };
    process.stdout.write(JSON.stringify(verdict) + '\n');
    process.exit(STATUS_EXIT.error);
  }

  const lock = acquireLock(undefined, Date.now(), code);
  if (!lock.ok) {
    const verdict = {
      status: 'busy',
      code,
      reason: `another capture is running (pid ${lock.holder.pid} since ${lock.holder.at})`,
    };
    process.stdout.write(JSON.stringify(verdict) + '\n');
    process.exit(STATUS_EXIT.busy);
  }

  let verdict;
  try {
    verdict = deleteCase(code);
  } catch (e) {
    verdict = { status: 'error', code, reason: e.message };
  } finally {
    releaseLock();
  }
  process.stdout.write(JSON.stringify(verdict) + '\n');
  process.exit(STATUS_EXIT[verdict.status] ?? 1);
}
