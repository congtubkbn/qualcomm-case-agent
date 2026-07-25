// scripts/scrape_case.mjs
//
// Persistence post-processor for the AGENT-DRIVEN extraction.
//
// This script does NOT drive the browser. The agent expands the case via
// agent-browser snapshot->click (SKILL.md PHASE 1.5), then extracts the raw
// case object from the already-expanded live DOM with ONE `agent-browser eval`
// (selectors from references/extraction.md lock-in table). The agent writes
// that raw JSON to a file and hands it here to be finalized:
//
//     node scrape_case.mjs <CASE_CODE> <rawJsonPath>              (full capture)
//     node scrape_case.mjs <CASE_CODE> <rawJsonPath> --merge      (update run)
//
// Finalize = completeness assert -> stamp hash + extractedAt -> write the
// canonical data/cases/<CODE>/case.json -> update root _index.json.
//
// --merge (update run on an already-cached case): the raw file is a PARTIAL
// capture — only the new posts were expanded; old posts may be collapsed/
// truncated in the DOM. The script keeps every cached comment verbatim,
// prepends only the comments not already cached (dedup by author + body
// prefix), preserves `enrichment`, and recomputes the hash. It never blanks
// a cached field from a thinner fresh capture.
//
// COMMENT IDENTITY is content-derived (`commentId` = hash of author + body
// prefix), assigned HERE for every persisted comment. Ids used to be positional
// (`c1`, `c2`, … from the extractor), which meant a full re-capture of a thread
// that gained a post re-keyed every comment — and `enrichment.commentAnalyses`
// is keyed by comment id, so the analyses would silently re-attach to the WRONG
// comments. Content ids are stable across runs and independent of position, so
// a cached analysis lands back on the comment it was written for. A cache still
// carrying legacy ids is migrated on read (`migrateIds`).
//
// Because of that, `enrichment` now survives a FULL re-capture of a cached case
// too, not just a --merge run: `--mode full` is the documented remedy when the
// fast no-update probe may have missed a nested reply, and it must not cost the
// user every analysis in the case.
//
// Why a script at all (vs the agent writing JSON directly): the SHA-256 hash
// (incremental "no update" detection) and the _index.json merge must be
// deterministic and identical across runs — that belongs in code, not the model.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';

// ---- Exit codes (exported so tests can import) ----
export const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  INCOMPLETE: 5,
};

// ---- Pure helpers ----

// Hash only the raw, verbatim fields (never enrichment) so re-enriching a case
// does not change its identity. Stable field order = stable hash across runs.
// `id` is deliberately NOT hashed: it is derived from the author + body that are
// already in here, so hashing it would add nothing but a dependency on the id
// scheme. (Caches written before ids became content-derived therefore re-hash
// once on their next capture — one no-op `updated` verdict, no data change.)
export function computeHash(raw) {
  const lines = [
    String(raw.displayedCommentCount ?? ''),
    ...raw.comments.map(c =>
      `${c.timestamp}|${c.author}|${c.body}|${(c.analysisLog || []).join('|')}`
    ),
  ];
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

// A post whose "Expand Post" control never got clicked (or got clicked but
// never actually expanded — see run_case.mjs's stuck-loop detection) still
// extracts fine, just with the collapsed teaser text plus the control's own
// label trailing the body (Chatter renders it as a sibling INSIDE the same
// container extract_case.js reads). This is root-cause-agnostic: it catches a
// stuck click loop, a selector drift, or any other way a post ends up
// half-captured, by looking at the one thing that's always true of a genuine
// full expansion — the label is gone from the body.
const COLLAPSED_BODY_RE = /\bExpand Post\s*$/i;

// Only check comments NEW to this capture — a --merge (and a full re-capture
// of a cache) deliberately leaves OLD posts collapsed (see expand_step.js) and
// keeps their cached verbatim bodies, so those legitimately still carry the
// label in the freshly re-extracted DOM. Checking the whole list would reject
// every routine update run.
export function findCollapsed(comments, newIds) {
  const fresh = new Set(newIds);
  return (comments || []).filter(c => fresh.has(c.id) && COLLAPSED_BODY_RE.test(c.body));
}

// captured < displayed => the agent must expand more / re-extract (do NOT persist
// a partial capture). displayed == null => portal showed no total; persist with a warning.
export function countAssert(capturedCount, displayedCount) {
  if (displayedCount == null) {
    return { ok: true, warning: 'displayedCommentCount not provided' };
  }
  if (capturedCount < displayedCount) {
    return { ok: false, captured: capturedCount, displayed: displayedCount };
  }
  return { ok: true };
}

// Header fields the agent already holds in-context from the PHASE 1 search row.
// Passing them as flags lets the script backfill the big raw file in CODE — the
// agent never re-Reads case.raw.json just to add a title (O(1) tokens, not O(case size)).
export const HEADER_KEYS = ['title', 'status', 'priority', 'severity', 'customer'];

// Parse `--title "..."` style flags into an overrides object. Only HEADER_KEYS honored.
export function parseHeaderFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-zA-Z]+)$/.exec(argv[i]);
    if (m && HEADER_KEYS.includes(m[1]) && argv[i + 1] != null) {
      out[m[1]] = argv[++i];
    }
  }
  return out;
}

// ---- Identity + merge helpers ----

// Stable identity for dedup across runs. Timestamps are EXCLUDED on purpose:
// Chatter shows relative times ("13h ago") that drift between runs. Author +
// whitespace-normalized body prefix survives both the drift and the collapsed
// (truncated) rendering of old posts in a partial update capture. Known limit:
// an edit inside the first 120 chars of an old comment makes it look new.
export function commentKey(c) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  return `${norm(c.author)}|${norm(c.body).slice(0, 120)}`;
}

// Content-derived comment id: the same comment gets the same id in every run,
// whatever position it now occupies in the feed. This is what makes the
// enrichment mapping survive a full re-capture.
export function commentId(c) {
  return `c${createHash('sha256').update(commentKey(c), 'utf8').digest('hex').slice(0, 12)}`;
}

// Assign content ids to a comment list. Two comments with the same key are a
// genuine ambiguity (the same author posting the same opening 120 chars twice),
// so they are kept as distinct comments with a `-N` suffix and REPORTED rather
// than silently collapsed into one.
export function assignIds(comments) {
  const used = new Map();
  const collisions = [];
  const out = (comments || []).map(c => {
    const base = commentId(c);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    if (n > 1) collisions.push(base);
    return { ...c, id: n === 1 ? base : `${base}-${n}` };
  });
  return { comments: out, collisions };
}

// Bring a cached case written with the old positional ids (c1, c2, …) or with
// raw DOM ids onto content ids, carrying the enrichment mapping across with it —
// per-comment analyses, the legacy flat summaries, and caseFlow back-references.
// A cache already on content ids is returned untouched.
export function migrateIds(cached) {
  const before = cached.comments || [];
  const { comments } = assignIds(before);
  const remap = new Map();
  before.forEach((c, i) => { if (c.id !== comments[i].id) remap.set(c.id, comments[i].id); });
  if (!remap.size) return cached;

  const out = { ...cached, comments };
  const e = cached.enrichment;
  if (e && typeof e === 'object') {
    const rekey = obj => Object.fromEntries(
      Object.entries(obj || {}).map(([k, v]) => [remap.get(k) || k, v]));
    out.enrichment = { ...e };
    if (e.commentAnalyses) out.enrichment.commentAnalyses = rekey(e.commentAnalyses);
    if (e.commentSummaries) out.enrichment.commentSummaries = rekey(e.commentSummaries);
    if (Array.isArray(e.caseFlow)) {
      out.enrichment.caseFlow = e.caseFlow.map(s =>
        (s && Array.isArray(s.refComments))
          ? { ...s, refComments: s.refComments.map(id => remap.get(id) || id) }
          : s);
    }
  }
  return out;
}

// Prepend the raw comments not already cached (feed order is newest-first).
// Cached comments are kept verbatim — an update run never rewrites old bodies.
// Both lists must already carry content ids (see assignIds), so dedup is an id
// lookup rather than a second, separately-drifting heuristic.
export function mergeComments(cachedComments, rawComments) {
  const have = new Set((cachedComments || []).map(c => c.id));
  const fresh = [];
  for (const c of rawComments || []) {
    if (have.has(c.id)) continue;
    have.add(c.id);
    fresh.push(c);
  }
  return { merged: [...fresh, ...(cachedComments || [])], newIds: fresh.map(c => c.id) };
}

// ---- Index path ----
const INDEX_PATH = join(DATA_DIR, '_index.json');

// ---- Main ----
function finalize(caseCode, rawPath, header = {}, merge = false) {
  if (!existsSync(rawPath)) {
    emit({ code: EXIT.BAD_ARGS, reason: `raw JSON not found: ${rawPath}` });
    process.exit(EXIT.BAD_ARGS);
  }

  const rawText = readFileSync(rawPath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText);
  } catch (e) {
    emit({ code: EXIT.BAD_ARGS, reason: `raw JSON parse error: ${e.message}` });
    process.exit(EXIT.BAD_ARGS);
  }

  if (!raw || !Array.isArray(raw.comments)) {
    emit({ code: EXIT.BAD_ARGS, reason: 'raw.comments must be an array' });
    process.exit(EXIT.BAD_ARGS);
  }

  // A real Qualcomm case always has at least the opening post. Zero comments means
  // the extractor ran on the wrong view (Feed not loaded, drifted to the Cases list,
  // session expired) — reject so a failed pull never OVERWRITES a good cached case.
  if (raw.comments.length === 0) {
    emit({ code: EXIT.INCOMPLETE, reason: 'extracted 0 comments — likely wrong page / failed capture; not persisting', caseCode });
    process.exit(EXIT.INCOMPLETE);
  }

  // Read the cache once — BOTH paths need it now. A full capture no longer
  // ignores it: `enrichment` is model-produced and unrecoverable, so it must
  // survive a re-capture of a case we already hold.
  const casePath = join(DATA_DIR, caseCode, 'case.json');
  let cached = null;
  if (existsSync(casePath)) {
    try {
      const t = readFileSync(casePath, 'utf8');
      cached = migrateIds(JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t));
    } catch (e) {
      if (merge) {
        emit({ code: EXIT.BAD_ARGS, reason: `cached case.json parse error: ${e.message}`, caseCode });
        process.exit(EXIT.BAD_ARGS);
      }
      // Full capture over an unreadable cache: the fresh pull replaces it wholesale.
      process.stderr.write(`Warning: cached case.json unreadable (${e.message}), replacing it\n`);
    }
  }
  if (merge && !cached) {
    emit({ code: EXIT.BAD_ARGS, reason: `--merge but no cached case.json at ${casePath} — run a full extraction (no --merge) first`, caseCode });
    process.exit(EXIT.BAD_ARGS);
  }

  // Identity is assigned HERE, in code, for every comment we persist.
  const fresh = assignIds(raw.comments);

  // `out` is the object that gets persisted. Full capture: the raw itself.
  // Update run (--merge): the cached case with only the NEW comments prepended.
  let out;
  let mergeInfo = null;
  let newIds = [];
  if (merge) {
    const merge0 = mergeComments(cached.comments || [], fresh.comments);
    newIds = merge0.newIds;
    // Start from the cache: enrichment and every already-captured field survive.
    out = { ...cached, comments: merge0.merged };
    // Fresh page values that are always current truth:
    if (raw.displayedCommentCount != null) out.displayedCommentCount = raw.displayedCommentCount;
    if (String(raw.url || '').trim()) out.url = raw.url;
    // Everything else from the partial capture only FILLS BLANKS — a collapsed
    // Description/Detail panel must never clobber a good cached value.
    for (const k of ['description', 'product', 'created', 'updated', ...HEADER_KEYS]) {
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
    const merge0 = mergeComments(cachedComments, fresh.comments);
    newIds = merge0.newIds;
    out = { ...raw, comments: merge0.merged };
    if (cached) {
      if (cached.enrichment) out.enrichment = cached.enrichment;
      mergeInfo = { newIds, oldHash: cached.hash, cached };
    }
  }

  // Hard gate: a genuinely NEW comment that still carries the "Expand Post"
  // control label is a half-captured post, whatever the cause. Reject rather
  // than persist it — a truncated body silently baked into the cache is worse
  // than a capture that fails loud and gets retried.
  const collapsed = findCollapsed(out.comments, newIds);
  if (collapsed.length) {
    emit({
      code: EXIT.INCOMPLETE,
      reason: `${collapsed.length} new comment(s) still show a collapsed "Expand Post" control — expansion incomplete, not persisting`,
      collapsedAuthors: collapsed.map(c => c.author),
      caseCode,
    });
    process.exit(EXIT.INCOMPLETE);
  }

  // Completeness gate BEFORE any write — a short capture is not persisted.
  const assertion = countAssert(out.comments.length, out.displayedCommentCount);
  if (!assertion.ok) {
    emit({ code: EXIT.INCOMPLETE, ...assertion, caseCode });
    process.exit(EXIT.INCOMPLETE);
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
    emit({
      code: EXIT.INCOMPLETE,
      reason: 'empty title — backfill header fields (title/status/priority) from the PHASE 1 search row before finalizing',
      caseCode,
    });
    process.exit(EXIT.INCOMPLETE);
  }

  // Soft signal for the remaining header fields — sometimes legitimately empty
  // (old/closed/draft cases), so warn but do NOT block.
  const thinHeader = ['status', 'priority', 'customer'].filter(k => !String(out[k] || '').trim());

  // Stamp identity + write canonical JSON.
  out.hash = computeHash(out);
  out.extractedAt = new Date().toISOString();

  // Per-case folder: data/cases/<CODE>/case.json — keeps all artifacts (render
  // md/html/txt, pdf) together. _index.json stays at DATA_DIR root (cross-case).
  const caseDir = join(DATA_DIR, caseCode);
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
  if (existsSync(INDEX_PATH)) {
    try {
      index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    } catch {
      process.stderr.write('Warning: _index.json unreadable, starting fresh\n');
    }
  }
  index[caseCode] = {
    syncedAt: out.extractedAt,
    commentCount: out.comments.length,
    hash: out.hash,
    // Enrichment now survives a re-capture, so the index must not claim the case
    // is unanalyzed just because it was pulled again.
    ...(out.enrichment?.enrichedAt ? { enrichedAt: out.enrichment.enrichedAt } : {}),
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');

  // Verdict fields the agent branches on. Emitted whenever a cached case existed,
  // including a FULL re-capture of one — a re-pull that adds two comments to a
  // 30-comment case should only cost two analyses, not thirty.
  //   newComments > 0                      -> PHASE 3 (enrich new ids) + PHASE 4
  //   newComments 0 but headerChanged      -> skip PHASE 3, re-render (PHASE 4)
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

  emit({
    code: EXIT.OK,
    caseCode,
    commentCount: out.comments.length,
    hash: out.hash,
    path: outPath,
    ...mergeVerdict,
    // Ambiguous identity is surfaced, never resolved silently (see assignIds).
    ...(fresh.collisions.length ? { idCollisions: fresh.collisions.length } : {}),
    ...(assertion.warning || thinHeader.length
      ? { warning: [assertion.warning, thinHeader.length ? `empty header fields: ${thinHeader.join(', ')}` : '']
          .filter(Boolean).join('; ') }
      : {}),
  });
  process.exit(EXIT.OK);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Entry point guard — prevents finalize() running when imported for tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const caseCode = process.argv[2]?.trim().toUpperCase();
  const rawPath = process.argv[3]?.trim();
  if (!caseCode || !rawPath) {
    emit({ code: EXIT.BAD_ARGS, reason: 'usage: node scrape_case.mjs <CASE_CODE> <rawJsonPath> [--merge] [--title "..." --status "..." --priority "..."]' });
    process.exit(EXIT.BAD_ARGS);
  }
  const rest = process.argv.slice(4);
  finalize(caseCode, rawPath, parseHeaderFlags(rest), rest.includes('--merge'));
}
