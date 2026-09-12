// run_summary.mjs - orchestrator for qcomm summary.
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
//        summary.json (nested tree, oldest-first — mirrors case.json's shape per #233),
//        renders summary.md (oldest-first, hierarchical numbering per #234), and prints
//        the result.
//
// Only deps.mjs (captureCase) is an effect; delta/cap/merge/render below are pure.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterFinalize } from './overview_store.mjs';
import { sortCommentsChronological } from './finalize_case.mjs';
import { walkCommentTree } from './render_case.mjs';

const execFileAsync = promisify(execFile);

const RUN_CASE_MJS = fileURLToPath(
  new URL('./run_case.mjs', import.meta.url),
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
// caseComments may be a nested tree (subs:[], per #233) or a flat legacy array;
// walkCommentTree handles both and flattens to every comment at every depth, so a
// reply the top-level filter used to miss is still checked against summarizedIds.
export function computeDelta(caseComments, summarizedIds) {
  const seen = new Set(summarizedIds);
  return walkCommentTree(caseComments)
    .map(({ comment: { subs, ...rest } }) => rest)
    .filter((c) => !seen.has(c.id));
}

// ---- deps.mjs inline ----
export async function captureCase(code) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [RUN_CASE_MJS, code]));
  } catch (e) {
    if (typeof e.stdout !== 'string' || !e.stdout.trim()) {
      throw new Error(`qcomm capture failed to run: ${e.message}`);
    }
    stdout = e.stdout;
  }
  const line = stdout.trim().split('\n').pop();
  return JSON.parse(line);
}

function cloneCommentTree(nodes) {
  return (nodes || []).map((n) => ({ ...n, subs: cloneCommentTree(n.subs) }));
}

function findCommentNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findCommentNode(n.subs || [], id);
    if (found) return found;
  }
  return null;
}

// Merges new digests into the nested comment tree (subs:[], mirrors case.json's shape
// per #233) instead of a flat array — a reply nests into its parent's `subs`, walking
// the tree rather than splicing by index. Top-level comments and each node's subs stay
// oldest->newest, same ordering rule as #233/#234 (case.json/case.md).
//
// Comments generally arrive oldest-first (prepare sorts delta chronologically), but
// insertion is multi-pass so any reply to a same-batch parent nests correctly under its
// parent (already-merged or newly-inserted this batch) regardless of input order. A
// digest whose parent never resolves (unknown id, or a cycle) is treated as new
// top-level content.
function insertCommentsByParent(priorComments, newComments, parentIdOf, commentOrder) {
  // Pre-#235 summary.json stored comments as a flat array with no subs/parentId at
  // all, so a legacy reply's parent link was never persisted -- and each finalize()
  // used to prepend its batch, so the array itself is newest-batch-first, not
  // chronological. Detect that shape, sort by commentOrder (finalize()'s walk of the
  // full case.json tree, i.e. the true oldest-first order), and re-place every prior
  // comment via parentIdOf instead of assuming priorComments is already correctly
  // nested and ordered.
  const isLegacyFlat = priorComments.length > 0 && !priorComments.some((c) => Array.isArray(c.subs));
  let tree = [];
  let pending;
  if (isLegacyFlat) {
    const orderIndex = new Map((commentOrder || []).map((id, i) => [id, i]));
    const sortedPrior = [...priorComments].sort(
      (a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity),
    );
    pending = [...sortedPrior, ...newComments];
  } else {
    tree = cloneCommentTree(priorComments);
    pending = [...newComments];
  }

  while (pending.length > 0) {
    let placedAny = false;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      const parentId = parentIdOf?.[c.id];
      const node = { ...c, subs: [] };

      if (parentId == null) {
        tree.push(node);
        pending.splice(i, 1);
        placedAny = true;
        break;
      }

      const parentNode = findCommentNode(tree, parentId);
      if (parentNode) {
        parentNode.subs.push(node);
        pending.splice(i, 1);
        placedAny = true;
        break;
      }

      // Parent not found yet (may still be pending this batch) -> wait for next pass
    }

    if (!placedAny) {
      // Parent unresolvable (unknown id, or a cycle) -> flush remaining to top level
      for (const c of pending) {
        tree.push({ ...c, subs: [] });
      }
      break;
    }
  }

  return tree;
}

// ---- merge.mjs inline ----
export function mergeSummary(prior, { caseNumber, title, url, priority, product, status, newComments, parentIdOf, commentOrder, flow, executive, now }) {
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
    comments: insertCommentsByParent(priorComments, newComments, parentIdOf, commentOrder),
    flow,
    lastSummarizedAt: now ?? new Date().toISOString(),
  };
}

// ---- render_summary.mjs inline ----
function renderComment(c, { number, isReply } = {}) {
  const marker = isReply ? '↳ ' : '';
  const num = number ? `${number}. ` : '';
  const lines = [`### ${num}${marker}${c.author ?? c.id} (${c.timestamp ?? c.id})`];
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
  const walked = walkCommentTree(summary.comments);
  const blocks = [renderHeader(summary)];
  const executiveBlock = renderExecutiveBlock(summary.executive);
  if (executiveBlock) blocks.push(executiveBlock);
  blocks.push(['## Case Flow', '', summary.flow].join('\n'));
  blocks.push(['## Comments (Oldest First)', '', walked.map(({ comment, number, isReply }) => renderComment(comment, { number, isReply })).join('\n\n'), ''].join('\n'));
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
    deltaComments: applyCharCapToComments(sortCommentsChronological(delta)),
    priorFlow: prior?.flow ?? '',
  };
}

export function finalize(code, { comments: newComments, flow, executive }, options = {}) {
  const { casePath, summaryPath, mdPath } = paths(code);
  const caseJson = readJson(casePath);
  const prior = readJson(summaryPath);
  const walkedCaseComments = walkCommentTree(caseJson.comments ?? []);
  const parentIdOf = Object.fromEntries(
    walkedCaseComments
      .filter((entry) => entry.parent)
      .map((entry) => [entry.comment.id, entry.parent.id]),
  );
  const commentOrder = walkedCaseComments.map((entry) => entry.comment.id);
  const merged = mergeSummary(prior, {
    caseNumber: caseJson.caseNumber,
    title: caseJson.title,
    url: caseJson.url,
    priority: caseJson.priority,
    product: caseJson.product,
    status: caseJson.status,
    newComments,
    parentIdOf,
    commentOrder,
    flow,
    executive,
  });
  writeFileSync(summaryPath, JSON.stringify(merged, null, 2));
  writeFileSync(mdPath, renderSummaryMd(merged));
  afterFinalize(code, options.casesDir || DATA_DIR, options);
  return { status: 'summarized', summaryPath, mdPath, newCount: newComments.length };
}

export async function summarize(code, payload, options = {}) {
  const prep = await prepare(code);
  if (prep.status !== 'needs-summary') {
    return prep;
  }
  if (!payload) {
    return prep;
  }
  const casesDir = options.casesDir || DATA_DIR;
  const caseFolder = join(casesDir, code);
  const tempFile = join(caseFolder, '.summary_temp.json');
  try {
    if (existsSync(caseFolder)) {
      writeFileSync(tempFile, JSON.stringify(payload, null, 2));
    }
    const r = finalize(code, payload, options);
    return r;
  } finally {
    if (existsSync(tempFile)) {
      try {
        unlinkSync(tempFile);
      } catch {}
    }
  }
}

async function readPayloadFromArgs(args) {
  const payloadIdx = args.indexOf('--payload');
  if (payloadIdx !== -1 && args[payloadIdx + 1]) {
    return JSON.parse(args[payloadIdx + 1]);
  }
  const inputIdx = args.indexOf('--input') !== -1 ? args.indexOf('--input') : args.indexOf('--payload-file');
  if (inputIdx !== -1 && args[inputIdx + 1]) {
    return JSON.parse(readFileSync(args[inputIdx + 1], 'utf8'));
  }
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString('utf8').trim();
    if (content) {
      return JSON.parse(content);
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [firstArg, secondArg, ...rest] = process.argv.slice(2);
  if (!firstArg) {
    process.stdout.write(
      JSON.stringify({
        status: 'error',
        reason: 'usage: run_summary.mjs [prepare|finalize|summarize] <CODE> [--payload <json> | --input <file.json>]',
      }) + '\n',
    );
    process.exit(1);
  }

  if (firstArg === 'prepare' && secondArg) {
    prepare(secondArg)
      .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
      .catch((e) => {
        process.stdout.write(JSON.stringify({ status: 'error', reason: e.message }) + '\n');
        process.exit(1);
      });
  } else if (firstArg === 'finalize' && secondArg) {
    const inputIdx = rest.indexOf('--input');
    const inputPath = inputIdx !== -1 ? rest[inputIdx + 1] : null;
    if (!inputPath) {
      process.stdout.write(JSON.stringify({ status: 'error', reason: 'finalize requires --input <file.json>' }) + '\n');
      process.exit(1);
    } else {
      try {
        const input = JSON.parse(readFileSync(inputPath, 'utf8'));
        const r = finalize(secondArg, input);
        process.stdout.write(JSON.stringify(r) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ status: 'error', reason: e.message }) + '\n');
        process.exit(1);
      }
    }
  } else {
    let code = firstArg;
    let remainingArgs = [secondArg, ...rest].filter(Boolean);
    if (firstArg === 'summarize' && secondArg) {
      code = secondArg;
      remainingArgs = rest;
    }

    (async () => {
      try {
        const payload = await readPayloadFromArgs(remainingArgs);
        const r = await summarize(code, payload);
        process.stdout.write(JSON.stringify(r) + '\n');
      } catch (e) {
        process.stdout.write(JSON.stringify({ status: 'error', reason: e.message }) + '\n');
        process.exit(1);
      }
    })();
  }
}

