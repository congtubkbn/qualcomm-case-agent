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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateCaseOverview } from '../../qualcomm-case-overview/scripts/cases_overview.mjs';
import { renderDashboardHtml } from '../../qualcomm-case-overview/scripts/dashboard_renderer.mjs';

const execFileAsync = promisify(execFile);

const RUN_CASE_MJS = fileURLToPath(
  new URL('../../qualcomm-case-agent/scripts/run_case.mjs', import.meta.url),
);

// ---- cap.mjs inline ----
export const CHAR_CAP = 20000;

export function applyCharCap(body, cap = CHAR_CAP) {
  return body.length > cap ? body.slice(0, cap) : body;
}

export function applyCharCapToComments(comments, cap = CHAR_CAP) {
  return comments.map((c) => ({ ...c, body: applyCharCap(c.body, cap) }));
}

// ---- delta.mjs inline ----
export function computeDelta(caseComments, summarizedIds) {
  const seen = new Set(summarizedIds);
  return caseComments.filter((c) => !seen.has(c.id));
}

// ---- deps.mjs inline ----
export async function captureCase(code) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [RUN_CASE_MJS, code]));
  } catch (e) {
    if (typeof e.stdout !== 'string' || !e.stdout.trim()) {
      throw new Error(`qualcomm-case-agent capture failed to run: ${e.message}`);
    }
    stdout = e.stdout;
  }
  const line = stdout.trim().split('\n').pop();
  return JSON.parse(line);
}

// ---- merge.mjs inline ----
export function mergeSummary(prior, { caseNumber, title, url, priority, product, status, newComments, flow, executive, now }) {
  const priorIds = prior?.summarizedCommentIds ?? [];
  const priorComments = prior?.comments ?? [];
  const mergedTitle = title || prior?.title;
  const mergedUrl = url || prior?.url;
  const mergedPriority = priority || prior?.priority;
  const mergedProduct = product || prior?.product;
  const mergedExecutive = executive ?? prior?.executive;
  return {
    caseNumber: caseNumber ?? prior?.caseNumber,
    ...(mergedTitle && { title: mergedTitle }),
    ...(mergedUrl && { url: mergedUrl }),
    ...(mergedPriority && { priority: mergedPriority }),
    ...(mergedProduct && { product: mergedProduct }),
    status,
    ...(mergedExecutive && { executive: mergedExecutive }),
    summarizedCommentIds: [...priorIds, ...newComments.map((c) => c.id)],
    comments: [...newComments, ...priorComments],
    flow,
    lastSummarizedAt: now ?? new Date().toISOString(),
  };
}

// ---- render_summary.mjs inline ----
function renderComment(c) {
  const lines = [`### ${c.author ?? c.id} (${c.timestamp ?? c.id})`];
  if (c.kind) lines.push(`- Kind: ${c.kind}`);
  if (c.summary) lines.push(`- Summary: ${c.summary}`);
  if (c.impact) lines.push(`- Impact: ${c.impact}`);
  if (c.owner) lines.push(`- Owner: ${c.owner}`);
  if (c.issue) lines.push(`- Issue: ${c.issue}`);
  if (c.status) lines.push(`- Status: ${c.status}`);
  if (c.nextAction) lines.push(`- Next action: ${c.nextAction}`);
  if (c.references?.length) lines.push(`- References: ${c.references.join(', ')}`);
  return lines.join('\n');
}

function renderHeader(summary) {
  const { caseNumber, title, status, priority, product } = summary;
  const caseNum = caseNumber ? String(caseNumber).trim() : '';
  const portalLine = caseNum
    ? `- **Portal**: [Open in Qualcomm Profile (qc://)](qc://case/${caseNum})`
    : '';

  if (!title) return `# Case ${caseNumber} — ${status}`;
  const lines = [`# [${caseNumber}] ${title}`, `- **Status**: ${status}`];
  if (priority) lines.push(`- **Priority**: ${priority}`);
  if (product) lines.push(`- **Product**: ${product}`);
  if (portalLine) lines.push(portalLine);
  return lines.join('\n');
}

function renderExecutiveBlock(executive) {
  if (!executive) return null;
  const lines = ['## Executive Summary', ''];
  if (executive.ballInCourt) {
    const bic = executive.ballInCourt;
    lines.push(`- **Ball in Court**: ${bic.charAt(0).toUpperCase()}${bic.slice(1)}`);
  }
  if (executive.blockerOrNextMilestone) lines.push(`- **Next Milestone**: ${executive.blockerOrNextMilestone}`);
  if (executive.rootCause) lines.push(`- **Root Cause**: ${executive.rootCause}`);
  if (executive.resolution) lines.push(`- **Resolution**: ${executive.resolution}`);
  return lines.join('\n');
}

export function renderSummaryMd(summary) {
  const newestFirst = summary.comments;
  const blocks = [renderHeader(summary)];
  const executiveBlock = renderExecutiveBlock(summary.executive);
  if (executiveBlock) blocks.push(executiveBlock);
  blocks.push(['## Case Flow', '', summary.flow].join('\n'));
  blocks.push(['## Comments (newest first)', '', newestFirst.map(renderComment).join('\n\n'), ''].join('\n'));
  return blocks.join('\n\n');
}

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
    const overviewData = updateCaseOverview(code, DATA_DIR);
    try {
      renderDashboardHtml(overviewData, join(DATA_DIR, 'dashboard.html'));
    } catch (e) {
      process.stderr.write(`Warning: dashboard render failed (${e.message})\n`);
    }
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
