// scripts/scrape_case.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Exit codes (exported so tests can import) ----
export const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  AUTH_NEEDED: 3,
  NOT_FOUND: 4,
  INCOMPLETE: 5,
  CONFIG_MISSING: 6,
};

// ---- Pure helpers ----

export function validateSelectors(config) {
  const required = ['fields', 'comments', 'displayedCommentCount'];
  const missingKeys = required.filter(k => config[k] == null);
  return { valid: missingKeys.length === 0, missingKeys };
}

export function computeHash(raw) {
  const lines = [
    String(raw.displayedCommentCount ?? ''),
    ...raw.comments.map(c =>
      `${c.id}|${c.timestamp}|${c.author}|${c.body}|${(c.analysisLog || []).join('|')}`
    ),
  ];
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export function countAssert(capturedCount, displayedCount) {
  if (displayedCount == null) {
    return { ok: true, warning: 'displayedCommentCount not found in DOM' };
  }
  if (capturedCount < displayedCount) {
    return { ok: false, captured: capturedCount, displayed: displayedCount };
  }
  return { ok: true };
}

export function isFixpoint(prev, curr) {
  return curr.clicked === 0 && curr.count === prev.count && curr.h === prev.h;
}

export function selectExitCode(state) {
  if (state.configMissing) return EXIT.CONFIG_MISSING;
  if (state.authNeeded)    return EXIT.AUTH_NEEDED;
  if (state.notFound)      return EXIT.NOT_FOUND;
  if (state.incomplete)    return EXIT.INCOMPLETE;
  return EXIT.OK;
}
