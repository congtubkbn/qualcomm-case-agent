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
// Why a script at all (vs the agent writing JSON directly): the SHA-256 hash
// (incremental "no update" detection) and the _index.json merge must be
// deterministic and identical across runs — that belongs in code, not the model.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
export function computeHash(raw) {
  const lines = [
    String(raw.displayedCommentCount ?? ''),
    ...raw.comments.map(c =>
      `${c.id}|${c.timestamp}|${c.author}|${c.body}|${(c.analysisLog || []).join('|')}`
    ),
  ];
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
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

// ---- Merge helpers (update run) ----

// Stable identity for dedup across runs. Timestamps are EXCLUDED on purpose:
// Chatter shows relative times ("13h ago") that drift between runs. Author +
// whitespace-normalized body prefix survives both the drift and the collapsed
// (truncated) rendering of old posts in a partial update capture. Known limit:
// an edit inside the first 120 chars of an old comment makes it look new.
export function commentKey(c) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  return `${norm(c.author)}|${norm(c.body).slice(0, 120)}`;
}

// Prepend the raw comments not already cached (feed order is newest-first).
// Cached comments are kept verbatim — an update run never rewrites old bodies.
// New comments get ids that cannot collide with cached ones.
export function mergeComments(cachedComments, rawComments) {
  const seen = new Set(cachedComments.map(commentKey));
  const usedIds = new Set(cachedComments.map(c => c.id));
  let next = 0;
  for (const id of usedIds) {
    const m = /^c(\d+)$/.exec(id);
    if (m) next = Math.max(next, Number(m[1]));
  }
  const fresh = [];
  for (const c of rawComments) {
    const k = commentKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    let id = c.id;
    if (!id || usedIds.has(id)) {
      do { id = `c${++next}`; } while (usedIds.has(id));
    }
    usedIds.add(id);
    fresh.push({ ...c, id });
  }
  return { merged: [...fresh, ...cachedComments], newIds: fresh.map(c => c.id) };
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

  // `out` is the object that gets persisted. Full capture: the raw itself.
  // Update run (--merge): the cached case with only the NEW comments prepended.
  let out = raw;
  let mergeInfo = null;
  if (merge) {
    const casePath = join(DATA_DIR, caseCode, 'case.json');
    if (!existsSync(casePath)) {
      emit({ code: EXIT.BAD_ARGS, reason: `--merge but no cached case.json at ${casePath} — run a full extraction (no --merge) first`, caseCode });
      process.exit(EXIT.BAD_ARGS);
    }
    let cached;
    try {
      const t = readFileSync(casePath, 'utf8');
      cached = JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
    } catch (e) {
      emit({ code: EXIT.BAD_ARGS, reason: `cached case.json parse error: ${e.message}`, caseCode });
      process.exit(EXIT.BAD_ARGS);
    }
    const { merged, newIds } = mergeComments(cached.comments || [], raw.comments);
    // Start from the cache: enrichment and every already-captured field survive.
    out = { ...cached, comments: merged };
    // Fresh page values that are always current truth:
    if (raw.displayedCommentCount != null) out.displayedCommentCount = raw.displayedCommentCount;
    if (String(raw.url || '').trim()) out.url = raw.url;
    // Everything else from the partial capture only FILLS BLANKS — a collapsed
    // Description/Detail panel must never clobber a good cached value.
    for (const k of ['description', 'product', 'created', 'updated', ...HEADER_KEYS]) {
      if (!String(out[k] || '').trim() && String(raw[k] || '').trim()) out[k] = raw[k];
    }
    mergeInfo = { newIds, oldHash: cached.hash, cached };
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
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');

  // Update-run verdict fields the agent branches on:
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
