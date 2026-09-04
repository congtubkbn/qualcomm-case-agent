// run_precedent.mjs - CLI orchestrator for the two steps of qualcomm-issue-precedent that come
// after precedent_search.mjs (see SKILL.md):
//   node run_precedent.mjs verdict --input <file.json>
//     -> takes { candidate, selections, session }, calls precedent_verdict.mjs's
//        synthesizeVerdict, and prints { status, caseNumber, verdict, checks } as one JSON line.
//        The agent runs this once per candidate it chose to test.
//   node run_precedent.mjs finalize --input <file.json> [--precedent-dir=<dir>]
//     -> takes the agent-assembled { issueTitle, issueRepro, query, candidates } (each candidate
//        carrying its verdict step's output), renders and persists the Markdown report under
//        data/cases/_precedent/, and prints { status, reportPath }.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { synthesizeVerdict } from './precedent_verdict.mjs';
import { DEFAULT_PRECEDENT_DIR, persistPrecedentReport } from './precedent_report.mjs';

/**
 * Runs the verdict step for one candidate: validates the input shape, then delegates to
 * synthesizeVerdict (which itself enforces that every selection is verbatim in the candidate's
 * extracted-signature list).
 * @param {{candidate: object, selections: object[], session: *}} input
 * @returns {Promise<object>}
 */
export async function runVerdict(input) {
  const { candidate, selections, session } = input || {};
  if (!candidate || typeof candidate !== 'object') {
    return { status: 'error', reason: 'input requires a "candidate" object' };
  }
  try {
    const { verdict, checks } = await synthesizeVerdict(candidate, selections || [], session);
    return { status: 'ok', caseNumber: candidate.caseNumber, verdict, checks };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

/**
 * Runs the finalize step: renders and persists the full precedent-check report.
 * @param {{issueTitle: string, issueRepro?: string, query?: string, candidates?: object[]}} input
 * @param {string} [precedentDir]
 * @returns {object}
 */
export function runFinalize(input, precedentDir = DEFAULT_PRECEDENT_DIR) {
  if (!input || typeof input.issueTitle !== 'string' || !input.issueTitle.trim()) {
    return { status: 'error', reason: 'input requires a non-empty "issueTitle"' };
  }
  try {
    const { reportPath } = persistPrecedentReport(input, precedentDir);
    return { status: 'ok', reportPath };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}

function readInput(args) {
  const idx = args.indexOf('--input');
  const inputPath = idx !== -1 ? args[idx + 1] : null;
  if (!inputPath) throw new Error('requires --input <file.json>');
  return JSON.parse(readFileSync(inputPath, 'utf8'));
}

function readPrecedentDir(args) {
  const flag = args.find((a) => a.startsWith('--precedent-dir='));
  return flag ? flag.slice('--precedent-dir='.length) : DEFAULT_PRECEDENT_DIR;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [step, ...rest] = process.argv.slice(2);

  if (step === 'verdict') {
    try {
      const input = readInput(rest);
      runVerdict(input).then((r) => {
        process.stdout.write(JSON.stringify(r) + '\n');
        if (r.status !== 'ok') process.exit(1);
      });
    } catch (e) {
      process.stdout.write(JSON.stringify({ status: 'error', reason: e.message }) + '\n');
      process.exit(1);
    }
  } else if (step === 'finalize') {
    try {
      const input = readInput(rest);
      const r = runFinalize(input, readPrecedentDir(rest));
      process.stdout.write(JSON.stringify(r) + '\n');
      if (r.status !== 'ok') process.exit(1);
    } catch (e) {
      process.stdout.write(JSON.stringify({ status: 'error', reason: e.message }) + '\n');
      process.exit(1);
    }
  } else {
    process.stdout.write(JSON.stringify({ status: 'error', reason: 'usage: run_precedent.mjs verdict|finalize --input <file.json>' }) + '\n');
    process.exit(1);
  }
}
