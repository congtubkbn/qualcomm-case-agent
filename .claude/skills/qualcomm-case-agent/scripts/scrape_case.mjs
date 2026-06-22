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

// ---- Index path ----
const INDEX_PATH = join(DATA_DIR, '_index.json');

// ---- Main ----
function finalize(caseCode, rawPath) {
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
    ...(assertion.warning ? { warning: assertion.warning } : {}),
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
    emit({ code: EXIT.BAD_ARGS, reason: 'usage: node scrape_case.mjs <CASE_CODE> <rawJsonPath>' });
    process.exit(EXIT.BAD_ARGS);
  }
  finalize(caseCode, rawPath);
}
