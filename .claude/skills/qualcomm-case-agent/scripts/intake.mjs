// Intake guard: validate case code + prep cache dirs. No browser, no deps.
// Run: node scripts/intake.mjs "<CODE>"
// Regex/metachars live here, NOT on the command line, so it behaves
// identically under PowerShell, cmd, and the POSIX Bash tool.
// Paths resolve via _paths.mjs (CWD-independent) — the same data/cases the
// finalizer (scrape_case.mjs) writes to, no matter where node is launched from.
import fs from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './_paths.mjs';

const raw = (process.argv[2] || '').trim();
if (!raw) { console.error('ERROR: empty case code'); process.exit(1); }

// Tolerate a leading CASE- prefix, then require exactly 8 digits.
const code = raw.replace(/^CASE-/i, '');
if (!/^\d{8}$/.test(code)) {
  console.error(`ERROR: case code must be 8 digits (got: ${raw})`);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const idx = join(DATA_DIR, '_index.json');
if (!fs.existsSync(idx)) {
  fs.writeFileSync(idx, '{}');
} else {
  try { JSON.parse(fs.readFileSync(idx, 'utf8')); }
  catch (e) { console.error(`ERROR: corrupt _index.json — ${e.message}`); process.exit(1); }
}

console.log(`intake OK ${code}`);
