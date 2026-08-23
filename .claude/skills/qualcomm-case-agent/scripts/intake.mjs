// Intake guard: validate case code + prep cache dirs. No browser, no deps.
// Run: node scripts/intake.mjs "<CODE>"
// Import: import { intake } from './intake.mjs'  ->  intake('<CODE>') => code
// Regex/metachars live here, NOT on the command line, so it behaves
// identically under PowerShell, cmd, and the POSIX Bash tool.
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';

/**
 * Validate a case code shape: exactly 8 digits, tolerating a leading CASE-
 * prefix and surrounding whitespace. Shared by intake() and delete_case.mjs
 * so the "what is a valid case code" rule lives in exactly one place.
 * @returns {string} the normalized 8-digit code
 */
export function normalizeCaseCode(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('empty case code');

  // Tolerate a leading CASE- prefix, then require exactly 8 digits.
  const code = s.replace(/^CASE-/i, '');
  if (!/^\d{8}$/.test(code)) throw new Error(`case code must be 8 digits (got: ${s})`);
  return code;
}

/**
 * Validate a case code and prepare its cache folder.
 * Paths come from _paths.mjs (project root), not the CWD, so a scheduled run
 * launched from anywhere writes to the same cache an interactive run does.
 * @returns {string} the normalized 8-digit code
 */
export function intake(raw) {
  const code = normalizeCaseCode(raw);

  // Create both the cache root AND this case's folder now, so the PHASE 2 raw
  // file write never needs a separate shell `mkdir -p` — that line kept breaking
  // under PowerShell (where `-p` is parsed as a directory name, not a flag).
  fs.mkdirSync(join(DATA_DIR, code), { recursive: true });

  const idx = join(DATA_DIR, '_index.json');
  if (!fs.existsSync(idx)) {
    fs.writeFileSync(idx, '{}');
  } else {
    try {
      const t = fs.readFileSync(idx, 'utf8');
      JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
    }
    catch (e) { throw new Error(`corrupt _index.json — ${e.message}`); }
  }
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(`intake OK ${intake(process.argv[2])}`);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
