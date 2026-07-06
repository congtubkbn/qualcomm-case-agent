// Intake guard: validate case code + prep cache dirs. No browser, no deps.
// Run: node scripts/intake.mjs "<CODE>"   (or `qcase intake <CODE>`)
// Regex/metachars live here, NOT on the command line, so it behaves
// identically under PowerShell, cmd, and the POSIX Bash tool.
//
// Paths come from _paths.mjs (DATA_DIR), never CWD-relative — so the bundled
// `qcase` CLI writes the cache under the project root no matter which directory
// it is launched from. QUALCOMM_ROOT overrides the root for odd layouts.
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
