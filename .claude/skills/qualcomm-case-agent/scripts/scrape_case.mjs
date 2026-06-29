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
//     node scrape_case.mjs <CASE_CODE> <rawJsonPath>
//
// Finalize = completeness assert -> stamp hash + extractedAt -> write the
// canonical data/cases/<CODE>/case.json -> update root _index.json.
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

// ---- Index path ----
const INDEX_PATH = join(DATA_DIR, '_index.json');

// ---- Main ----
function finalize(caseCode, rawPath, header = {}) {
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

  // Completeness gate BEFORE any write — a short capture is not persisted.
  const assertion = countAssert(raw.comments.length, raw.displayedCommentCount);
  if (!assertion.ok) {
    emit({ code: EXIT.INCOMPLETE, ...assertion, caseCode });
    process.exit(EXIT.INCOMPLETE);
  }

  // Backfill header fields from CLI flags (PHASE 1 search row) — only where the
  // Feed extractor left them blank, so a real extracted value always wins. This
  // is the cheap path: the agent passes what it already knows instead of Reading
  // back the whole raw file to Edit three fields.
  for (const k of HEADER_KEYS) {
    if (!String(raw[k] || '').trim() && String(header[k] || '').trim()) {
      raw[k] = header[k].trim();
    }
  }

  // Header gate: title drives the human-facing heading. The extractor leaves it
  // "" on the Feed view; the agent must backfill it from the PHASE 1 search row
  // (pass `--title`). An empty title is a failed pull dressed as success (the
  // renderer would fall back to "Untitled case"), so reject rather than persist.
  if (!String(raw.title || '').trim()) {
    emit({
      code: EXIT.INCOMPLETE,
      reason: 'empty title — backfill header fields (title/status/priority) from the PHASE 1 search row before finalizing',
      caseCode,
    });
    process.exit(EXIT.INCOMPLETE);
  }

  // Soft signal for the remaining header fields — sometimes legitimately empty
  // (old/closed/draft cases), so warn but do NOT block.
  const thinHeader = ['status', 'priority', 'customer'].filter(k => !String(raw[k] || '').trim());

  // Stamp identity + write canonical JSON.
  raw.hash = computeHash(raw);
  raw.extractedAt = new Date().toISOString();

  // Per-case folder: data/cases/<CODE>/case.json — keeps all artifacts (render
  // md/html/txt, pdf) together. _index.json stays at DATA_DIR root (cross-case).
  const caseDir = join(DATA_DIR, caseCode);
  mkdirSync(caseDir, { recursive: true });
  const outPath = join(caseDir, 'case.json');
  writeFileSync(outPath, JSON.stringify(raw, null, 2), 'utf8');

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
    syncedAt: raw.extractedAt,
    commentCount: raw.comments.length,
    hash: raw.hash,
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');

  emit({
    code: EXIT.OK,
    caseCode,
    commentCount: raw.comments.length,
    hash: raw.hash,
    path: outPath,
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
    emit({ code: EXIT.BAD_ARGS, reason: 'usage: node scrape_case.mjs <CASE_CODE> <rawJsonPath> [--title "..." --status "..." --priority "..."]' });
    process.exit(EXIT.BAD_ARGS);
  }
  finalize(caseCode, rawPath, parseHeaderFlags(process.argv.slice(4)));
}
