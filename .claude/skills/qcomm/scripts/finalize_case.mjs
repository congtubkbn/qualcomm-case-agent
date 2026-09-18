// scripts/finalize_case.mjs
//
// Persistence post-processor for the AGENT-DRIVEN extraction.
//
// This script does NOT drive the browser. The agent expands the case via
// agent-browser snapshot->click (SKILL.md PHASE 1.5), then extracts the raw
// case object from the already-expanded live DOM with ONE `agent-browser eval`
// (selectors from references/extraction.md lock-in table). The agent writes
// that raw JSON to a file and hands it here to be finalized:
//
//     node finalize_case.mjs <CASE_CODE> <rawJsonPath>              (full capture)
//     node finalize_case.mjs <CASE_CODE> <rawJsonPath> --merge      (update run)
//
// Finalize = completeness assert -> stamp hash + extractedAt -> write the
// canonical data/cases/<CODE>/case.json -> update root _index.json.
//
// --merge (update run on an already-cached case): the raw file is a PARTIAL
// capture — only the new posts were expanded; old posts may be collapsed/
// truncated in the DOM. The script keeps every cached comment verbatim,
// prepends only the comments not already cached (dedup by author + body
// prefix), and recomputes the hash. It never blanks a cached field from a
// thinner fresh capture.
//
// COMMENT IDENTITY is content-derived (`commentId` = hash of author + body
// prefix), assigned HERE for every persisted comment. Ids used to be positional
// (`c1`, `c2`, … from the extractor), which meant a full re-capture of a thread
// that gained a post re-keyed every comment. Content ids are stable across runs
// and independent of position. A cache still carrying legacy ids is migrated on
// read (`migrateIds`).
//
// Why a script at all (vs the agent writing JSON directly): the SHA-256 hash
// (incremental "no update" detection) and the _index.json merge must be
// deterministic and identical across runs — that belongs in code, not the model.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';
import { syncCaseOverview } from './overview_store.mjs';
import { buildNestedTree, countAllComments } from './comment_tree.mjs';
import { HEADER_KEYS, DETAIL_KEYS, parseHeaderFlags } from './finalize_header.mjs';
import { computeHash, assignIds, migrateIds } from './finalize_identity.mjs';
import { findCollapsed, countAssert, genuineCommentCount } from './finalize_completeness.mjs';
import { normalizeComment, normalizeComments } from './finalize_normalize.mjs';
import { mergeComments } from './finalize_merge.mjs';
import { extractSummary, synthesizeDescriptionComment, hasDescriptionComment } from './finalize_description.mjs';

// ---- Exit codes (exported so tests can import) ----
export const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  INCOMPLETE: 5,
};

// ---- Main ----
export function finalize(caseCode, rawPath, header = {}, merge = false, options = {}) {
  if (!existsSync(rawPath)) {
    return { code: EXIT.BAD_ARGS, reason: `raw JSON not found: ${rawPath}` };
  }

  // options.casesDir lets a direct/programmatic caller (tests, and any future
  // script) point finalize() at a throwaway directory instead of the real
  // DATA_DIR — every read AND write below goes through this, not just the
  // overview sync at the bottom. A prior version of this override only reached
  // the overview sync call, so an in-process test call using a real case code (e.g.
  // "08603854", used throughout this test suite) silently overwrote that real
  // case's cached data via DATA_DIR — confirmed on a real checkout, not
  // hypothetical.
  const casesDir = options.casesDir || DATA_DIR;
  const indexPath = join(casesDir, '_index.json');

  const rawText = readFileSync(rawPath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText);
  } catch (e) {
    return { code: EXIT.BAD_ARGS, reason: `raw JSON parse error: ${e.message}` };
  }

  if (!raw || !Array.isArray(raw.comments)) {
    return { code: EXIT.BAD_ARGS, reason: 'raw.comments must be an array' };
  }

  // A real Qualcomm case always has at least the opening post. Zero comments means
  // the extractor ran on the wrong view (Feed not loaded, drifted to the Cases list,
  // session expired) — reject so a failed pull never OVERWRITES a good cached case.
  if (raw.comments.length === 0) {
    return { code: EXIT.INCOMPLETE, reason: 'extracted 0 comments — likely wrong page / failed capture; not persisting', caseCode };
  }

  // Reference date for resolving relative Chatter timestamps (e.g. "12 days ago")
  // into absolute ISO strings at capture time. Injected via options or --ref-date for tests.
  const refDate = options.referenceDate
    ? (options.referenceDate instanceof Date ? options.referenceDate : new Date(options.referenceDate))
    : (header.refDate ? new Date(header.refDate) : new Date());

  // Read the cache once — BOTH paths need it, to union comments rather than
  // letting a thinner fresh capture silently drop one already confirmed to exist.
  const casePath = join(casesDir, caseCode, 'case.json');
  let cached = null;
  if (existsSync(casePath)) {
    try {
      const t = readFileSync(casePath, 'utf8');
      cached = migrateIds(JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t));
    } catch (e) {
      if (merge) {
        return { code: EXIT.BAD_ARGS, reason: `cached case.json parse error: ${e.message}`, caseCode };
      }
      // Full capture over an unreadable cache: the fresh pull replaces it wholesale.
      process.stderr.write(`Warning: cached case.json unreadable (${e.message}), replacing it\n`);
    }
  }
  if (merge && !cached) {
    return { code: EXIT.BAD_ARGS, reason: `--merge but no cached case.json at ${casePath} — run a full extraction (no --merge) first`, caseCode };
  }

  // Inject description as initial comment if non-empty and not already present.
  const descRaw = {
    description: String(raw.description || (cached && cached.description) || '').trim(),
    contactName: String(raw.contactName || (cached && cached.contactName) || '').trim(),
    openedAt: String(raw.openedAt || (cached && cached.openedAt) || '').trim(),
  };
  const descComment = synthesizeDescriptionComment(descRaw);
  let rawComments = normalizeComments(raw.comments || [], refDate);
  if (descComment && !hasDescriptionComment(rawComments, descRaw.description)) {
    rawComments.push(normalizeComment(descComment, refDate));
  }

  // Identity is assigned HERE, in code, for every comment we persist.
  const fresh = assignIds(rawComments);

  // Resolve parentId from parentIndex while fresh.comments is still in DOM order
  for (const c of fresh.comments) {
    if (c.parentId === undefined) {
      if (c.parentIndex != null && fresh.comments[c.parentIndex]) {
        c.parentId = fresh.comments[c.parentIndex].id;
      } else {
        c.parentId = null;
      }
    }
  }

  // `out` is the object that gets persisted. Full capture: the raw itself.
  // Update run (--merge): the cached case with only the NEW comments prepended.
  let out;
  let mergeInfo = null;
  let newIds = [];
  let possibleEdits = [];
  if (merge) {
    const merge0 = mergeComments(cached.comments || [], fresh.comments, refDate);
    newIds = merge0.newIds;
    possibleEdits = merge0.possibleEdits;
    // Start from the cache: every already-captured field survives.
    out = { ...cached, comments: merge0.merged };
    // Fresh page values that are always current truth:
    if (raw.displayedCommentCount != null) out.displayedCommentCount = raw.displayedCommentCount;
    // Capture evidence always describes THIS run, never the previous one.
    if (raw.capture) out.capture = raw.capture;
    if (String(raw.url || '').trim()) out.url = raw.url;
    // Everything else from the partial capture only FILLS BLANKS — a collapsed
    // Description/Detail panel must never clobber a good cached value.
    for (const k of ['description', 'product', 'updated', ...DETAIL_KEYS, ...HEADER_KEYS]) {
      if (!String(out[k] || '').trim() && String(raw[k] || '').trim()) out[k] = raw[k];
    }
    mergeInfo = { newIds, oldHash: cached.hash, cached };
  } else {
    // Full capture: header/description/etc. are complete by definition and
    // replace the cache. Comments are UNIONED with whatever is already
    // cached, not replaced — a thinner fresh extraction (Chatter feed lazy-
    // load stopping short, a transient portal hiccup) must never silently
    // DROP comments already confirmed to exist; a comment missing from one
    // capture is not proof it is gone for good. This is the same dedup as
    // --merge; a full run can only grow the comment list, never shrink it.
    const cachedComments = cached ? (cached.comments || []) : [];
    const merge0 = mergeComments(cachedComments, fresh.comments, refDate);
    newIds = merge0.newIds;
    possibleEdits = merge0.possibleEdits;
    out = { ...raw, comments: merge0.merged };
    if (cached) {
      for (const k of ['description', 'product', 'updated', ...DETAIL_KEYS]) {
        if (!String(out[k] || '').trim() && String(cached[k] || '').trim()) out[k] = cached[k];
      }
      mergeInfo = { newIds, oldHash: cached.hash, cached };
    }
  }

  // Normalize URL to always point to Communication tab (tabset-XXXX=1)
  if (typeof out.url === 'string' && out.url.trim()) {
    out.url = out.url.replace(/tabset-([a-zA-Z0-9_-]+)=\d+/gi, 'tabset-$1=1');
  }

  // Hard gate: a genuinely NEW comment that still carries the "Expand Post"
  // control label is a half-captured post, whatever the cause. Reject rather
  // than persist it — a truncated body silently baked into the cache is worse
  // than a capture that fails loud and gets retried.
  const collapsed = findCollapsed(out.comments, newIds);
  if (collapsed.length) {
    return {
      code: EXIT.INCOMPLETE,
      reason: `${collapsed.length} new comment(s) still show a collapsed "Expand Post" control — expansion incomplete, not persisting`,
      collapsedAuthors: collapsed.map(c => c.author),
      caseCode,
    };
  }

  // Completeness gate BEFORE any write — a short capture is not persisted.
  // Uses the genuine comment count: the synthesized description comment must
  // not pad the count and mask one real Chatter comment missing.
  const assertion = countAssert(genuineCommentCount(out.comments, out.description), out.displayedCommentCount);
  if (!assertion.ok) {
    return { code: EXIT.INCOMPLETE, ...assertion, caseCode };
  }

  // Header fields from CLI flags (PHASE 1 search row). Full capture: only fill
  // where the Feed extractor left them blank, so a real extracted value always
  // wins. Update run: flags WIN over the cache — they are the freshest truth
  // (Status/Priority change over a case's life; that's often the whole update).
  for (const k of HEADER_KEYS) {
    const v = String(header[k] || '').trim();
    if (!v) continue;
    if (merge || !String(out[k] || '').trim()) out[k] = v;
  }

  // Header gate: title drives the human-facing heading. The extractor leaves it
  // "" on the Feed view; the agent must backfill it from the PHASE 1 search row
  // (pass `--title`). An empty title is a failed pull dressed as success (the
  // renderer would fall back to "Untitled case"), so reject rather than persist.
  if (!String(out.title || '').trim()) {
    return {
      code: EXIT.INCOMPLETE,
      reason: 'empty title — backfill header fields (title/status/priority) from the PHASE 1 search row before finalizing',
      caseCode,
    };
  }

  // Soft signal for the remaining header fields — sometimes legitimately empty
  // (old/closed/draft cases), so warn but do NOT block.
  const thinHeader = ['status', 'priority'].filter(k => !String(out[k] || '').trim());

  // Comments must never carry role/company — scrub them here so an --merge or
  // full re-capture of a case cached before this field was dropped gets
  // cleaned on its next capture, with no separate migration pass.
  // displayPosition is also scrubbed: it's a getBoundingClientRect().top value
  // from ONE extraction pass (sortCommentsChronological's tie-break signal,
  // already consumed by mergeComments above), not durable content — persisting
  // it would let a future run's tie-break compare positions measured on two
  // different page loads, which is meaningless.
  // Preview is generated HERE, for every persisted comment — fresh, cached,
  // and the synthesized description comment alike — so this is the single
  // place a comment's preview is ever derived (see extractSummary above).
  out.comments = out.comments.map(({ role, company, displayPosition, isReply, parentIndex, ...rest }) => ({
    ...rest,
    parentId: rest.parentId ?? null,
    summary: extractSummary(rest.body),
  }));

  // Build the nested tree: top-level oldest→newest, each comment's subs:[]
  // also oldest→newest. parentId is dropped from the output — nesting position
  // is the only source of parent/child truth in the persisted case.json.
  // (Reverts the 2026-08-27 presentation-only newest-first decision; PRD
  // #105-109 "Variant A" already specified oldest-first as the canonical shape.)
  out.comments = buildNestedTree(out.comments);

  // Stamp identity + write canonical JSON.
  out.hash = computeHash(out);
  out.extractedAt = new Date().toISOString();

  // Per-case folder: data/cases/<CODE>/case.json — keeps all artifacts (render
  // md/html/txt, pdf) together. _index.json stays at casesDir root (cross-case).
  const caseDir = join(casesDir, caseCode);
  mkdirSync(caseDir, { recursive: true });
  const outPath = join(caseDir, 'case.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

  // Delete the raw scratch capture ourselves, now that the canonical case.json is
  // written. Previously the SKILL told the agent to `del`/`rm` it in a follow-up
  // shell line, which thrashed on Windows dialect (`del /F` in cmd vs Remove-Item
  // in PowerShell vs `rm` in Bash). Owning it here keeps cleanup cross-platform and
  // one turn shorter. Only runs on the success path (we're about to exit OK).
  try { rmSync(rawPath, { force: true }); } catch { /* non-fatal: leftover scratch is harmless */ }

  // Merge into _index.json.
  let index = {};
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      process.stderr.write('Warning: _index.json unreadable, starting fresh\n');
    }
  }
  index[caseCode] = {
    syncedAt: out.extractedAt,
    commentCount: countAllComments(out.comments),
    hash: out.hash,
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

  // Auto-sync cases overview and dashboard. syncCaseOverview only traps its
  // own render-stage failures; a failure earlier in the sync (e.g. a
  // malformed case.json) must not crash a successful finalize either, so it
  // is caught here.
  const syncFn = options.syncCaseOverview || syncCaseOverview;
  try {
    syncFn(caseCode, { ...options, casesDir, action: 'upsert' });
  } catch (e) {
    if (typeof options.onError === 'function') {
      options.onError(e, 'overview');
    }
    process.stderr.write(`Warning: overview auto-sync failed (${e.message})\n`);
  }

  // Verdict fields the agent branches on. Emitted whenever a cached case existed,
  // including a FULL re-capture of one — the agent sees exactly which comments
  // are genuinely new, whatever the capture mode.
  //   newComments > 0                      -> report the new comments, re-render
  //   newComments 0 but headerChanged      -> re-render only
  //   newComments 0, !headerChanged, !changed -> "no update", STOP
  const mergeVerdict = mergeInfo
    ? {
        newComments: mergeInfo.newIds.length,
        newCommentIds: mergeInfo.newIds,
        changed: out.hash !== mergeInfo.oldHash,
        headerChanged: HEADER_KEYS.some(k =>
          String(header[k] || '').trim() &&
          String(header[k]).trim() !== String(mergeInfo.cached[k] || '').trim()),
      }
    : {};

  return {
    code: EXIT.OK,
    caseCode,
    commentCount: countAllComments(out.comments),
    hash: out.hash,
    path: outPath,
    ...mergeVerdict,
    // Ambiguous identity is surfaced, never resolved silently (see assignIds).
    ...(fresh.collisions.length ? { idCollisions: fresh.collisions.length } : {}),
    // A same-author, high-similarity "new" comment may be an edit of an old one
    // (I3) — surfaced for a human to check, never auto-merged (see mergeComments).
    ...(possibleEdits.length ? { possibleEdits } : {}),
    ...(assertion.warning || thinHeader.length
      ? { warning: [assertion.warning, thinHeader.length ? `empty header fields: ${thinHeader.join(', ')}` : '']
          .filter(Boolean).join('; ') }
      : {}),
  };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Entry point guard — prevents finalize() running when imported for tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const caseCode = process.argv[2]?.trim().toUpperCase();
  const rawPath = process.argv[3]?.trim();
  if (!caseCode || !rawPath) {
    emit({ code: EXIT.BAD_ARGS, reason: 'usage: node finalize_case.mjs <CASE_CODE> <rawJsonPath> [--merge] [--title "..." --status "..." --priority "..."]' });
    process.exit(EXIT.BAD_ARGS);
  }
  const rest = process.argv.slice(4);
  const result = finalize(caseCode, rawPath, parseHeaderFlags(rest), rest.includes('--merge'));
  emit(result);
  process.exit(result.code);
}
