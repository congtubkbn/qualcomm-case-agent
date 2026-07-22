// Intake guard: validate case code + prep cache dirs. No browser, no deps.
// Run: node scripts/intake.mjs "<CODE>"
// Regex/metachars live here, NOT on the command line, so it behaves
// identically under PowerShell, cmd, and the POSIX Bash tool.
import fs from 'node:fs';

const raw = (process.argv[2] || '').trim();
if (!raw) { console.error('ERROR: empty case code'); process.exit(1); }

// Tolerate a leading CASE- prefix, then require exactly 8 digits.
const code = raw.replace(/^CASE-/i, '');
if (!/^\d{8}$/.test(code)) {
  console.error(`ERROR: case code must be 8 digits (got: ${raw})`);
  process.exit(1);
}

// Create both the cache root AND this case's folder now, so the PHASE 2 raw-file
// redirect (`... > data/cases/<CODE>/case.raw.json`) never needs a separate shell
// `mkdir -p` — that line kept breaking when the agent ran it under PowerShell
// (where `-p` is parsed as a directory name, not a flag).
fs.mkdirSync(`data/cases/${code}`, { recursive: true });

const idx = 'data/cases/_index.json';
if (!fs.existsSync(idx)) {
  fs.writeFileSync(idx, '{}');
} else {
  try { JSON.parse(fs.readFileSync(idx, 'utf8')); }
  catch (e) { console.error(`ERROR: corrupt _index.json — ${e.message}`); process.exit(1); }
}

console.log(`intake OK ${code}`);
