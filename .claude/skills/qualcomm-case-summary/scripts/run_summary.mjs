// run_summary.mjs - orchestrator for qualcomm-case-summary.
//
// Two CLI steps, with the calling agent doing the actual summarization in between
// (see SKILL.md):
//   node run_summary.mjs prepare <CODE>
//     -> ensures capture (deps.captureCase), computes the delta, applies the char
//        cap, and prints either a cached summary (status: no-delta / capture-failure
//        passthrough) or the model-input package (status: needs-summary) as one JSON
//        line. An empty delta short-circuits before any summarization is requested.
//   node run_summary.mjs finalize <CODE> --input <file.json>
//     -> takes the agent-produced { comments, flow } from <file.json>, merges it into
//        summary.json, renders summary.md (newest-first), and prints the result.
//
// Only deps.mjs (captureCase) is an effect; delta/cap/merge/render below are pure.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../qualcomm-case-agent/scripts/_paths.mjs';
import { applyCharCapToComments } from './cap.mjs';
import { captureCase } from './deps.mjs';
import { computeDelta } from './delta.mjs';
import { mergeSummary } from './merge.mjs';
import { renderSummaryMd } from './render_summary.mjs';
import { updateCaseOverview } from '../../../../tools/cases_overview.mjs';

const CAPTURE_OK = new Set(['created', 'updated', 'no-update']);

function paths(code) {
  const dir = join(DATA_DIR, code);
  return { dir, casePath: join(dir, 'case.json'), summaryPath: join(dir, 'summary.json'), mdPath: join(dir, 'summary.md') };
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export async function prepare(code) {
  const capture = await captureCase(code);
  if (!CAPTURE_OK.has(capture.status)) {
    return { status: capture.status, capture };
  }

  const { casePath, summaryPath, mdPath } = paths(code);
  const caseJson = readJson(casePath);
  const prior = readJson(summaryPath);
  const delta = computeDelta(caseJson.comments, prior?.summarizedCommentIds ?? []);

  if (delta.length === 0) {
    return { status: 'no-delta', summary: prior, summaryPath, mdPath, caseStatus: caseJson.status };
  }

  return {
    status: 'needs-summary',
    code,
    caseNumber: caseJson.caseNumber,
    caseStatus: caseJson.status,
    deltaComments: applyCharCapToComments(delta),
    priorFlow: prior?.flow ?? '',
  };
}

export function finalize(code, { comments: newComments, flow, executive }) {
  const { casePath, summaryPath, mdPath } = paths(code);
  const caseJson = readJson(casePath);
  const prior = readJson(summaryPath);
  const merged = mergeSummary(prior, {
    caseNumber: caseJson.caseNumber,
    title: caseJson.title,
    url: caseJson.url,
    priority: caseJson.priority,
    product: caseJson.product,
    status: caseJson.status,
    newComments,
    flow,
    executive,
  });
  writeFileSync(summaryPath, JSON.stringify(merged, null, 2));
  writeFileSync(mdPath, renderSummaryMd(merged));
  try {
    updateCaseOverview(code, DATA_DIR);
  } catch (e) {
    process.stderr.write(`Warning: overview auto-sync failed (${e.message})\n`);
  }
  return { status: 'summarized', summaryPath, mdPath, newCount: newComments.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [step, code, ...rest] = process.argv.slice(2);
  if (step === 'prepare' && code) {
    prepare(code)
      .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
      .catch((e) => {
        process.stdout.write(JSON.stringify({ status: 'error', reason: e.message }) + '\n');
        process.exit(1);
      });
  } else if (step === 'finalize' && code) {
    const inputIdx = rest.indexOf('--input');
    const inputPath = inputIdx !== -1 ? rest[inputIdx + 1] : null;
    if (!inputPath) {
      process.stdout.write(JSON.stringify({ status: 'error', reason: 'finalize requires --input <file.json>' }) + '\n');
      process.exit(1);
    } else {
      try {
        const input = JSON.parse(readFileSync(inputPath, 'utf8'));
        const r = finalize(code, input);
        process.stdout.write(JSON.stringify(r) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ status: 'error', reason: e.message }) + '\n');
        process.exit(1);
      }
    }
  } else {
    process.stdout.write(JSON.stringify({ status: 'error', reason: 'usage: run_summary.mjs prepare|finalize <CODE> [--input <file.json>]' }) + '\n');
    process.exit(1);
  }
}
