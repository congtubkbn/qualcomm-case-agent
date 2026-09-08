// run_summary.mjs - orchestrator for qualcomm-case-summary.
//
// Two CLI steps, with the calling agent doing the actual summarization in between
// (see SKILL.md):
//   node run_summary.mjs prepare <CODE>
//     -> ensures capture (captureCase), computes the delta, applies the char
//        cap, and prints either a cached summary (status: no-delta / capture-failure
//        passthrough) or the model-input package (status: needs-summary) as one JSON
//        line. An empty delta short-circuits before any summarization is requested.
//   node run_summary.mjs finalize <CODE> --input <file.json>
//     -> takes the agent-produced { comments, flow } from <file.json>, merges it into
//        summary.json, renders summary.md (newest-first), and prints the result.
//
// Only captureCase (imported from qualcomm-case-agent) is an effect; delta/cap/merge/
// render below are pure.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../qualcomm-case-agent/scripts/_paths.mjs';
import { captureCase } from '../../qualcomm-case-agent/scripts/capture_case.mjs';
import { afterFinalize } from '../../qualcomm-case-overview/scripts/overview_store.mjs';

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

// Places each new digest next to its parent's already-summarized entry (mirrors
// finalize_case.mjs's orderCommentsForPresentation for case.json) instead of blindly
// prepending the whole batch — a reply to an old post must land beside that post, not
// at the array head. A digest with no known parent (or whose parent isn't summarized
// yet) is genuinely new top-level content, so it keeps the old prepend/newest-first
// placement.
//
// newComments arrives oldest-first (delta preserves case.json's chronological order),
// so a parent always precedes its own reply in the loop below. Inserting each comment
// immediately after its parent's *current* position — rather than after the last
// sibling already placed — means: (1) a reply to a same-batch (not-yet-summarized)
// parent finds that parent already spliced into `working`, so chains nest correctly;
// (2) processing oldest-to-newest with "insert right after parent" pushes each earlier
// sibling one slot further down, so siblings end up newest-first under the parent —
// matching the newest-first convention without a separate reverse step.
function insertCommentsByParent(priorComments, newComments, parentIdOf) {
  const working = [...priorComments];
  const topLevel = [];
  for (const c of newComments) {
    const parentId = parentIdOf?.[c.id];
    const parentIdx = parentId != null ? working.findIndex((r) => r.id === parentId) : -1;
    if (parentIdx === -1) {
      topLevel.push(c);
    } else {
      working.splice(parentIdx + 1, 0, c);
    }
  }
  return [...topLevel, ...working];
}

// ---- merge.mjs inline ----
export function mergeSummary(prior, { caseNumber, title, url, priority, product, status, newComments, parentIdOf, flow, executive, now }) {
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
    comments: insertCommentsByParent(priorComments, newComments, parentIdOf),
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

export function finalize(code, { comments: newComments, flow, executive }, options = {}) {
  const { casePath, summaryPath, mdPath } = paths(code);
  const caseJson = readJson(casePath);
  const prior = readJson(summaryPath);
  const parentIdOf = Object.fromEntries(
    (caseJson.comments ?? [])
      .filter((c) => c.parentId != null)
      .map((c) => [c.id, c.parentId]),
  );
  const merged = mergeSummary(prior, {
    caseNumber: caseJson.caseNumber,
    title: caseJson.title,
    url: caseJson.url,
    priority: caseJson.priority,
    product: caseJson.product,
    status: caseJson.status,
    newComments,
    parentIdOf,
    flow,
    executive,
  });
  writeFileSync(summaryPath, JSON.stringify(merged, null, 2));
  writeFileSync(mdPath, renderSummaryMd(merged));
  afterFinalize(code, options.casesDir || DATA_DIR, options);
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
