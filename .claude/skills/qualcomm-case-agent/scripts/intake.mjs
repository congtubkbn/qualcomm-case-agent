// Intake guard: validate case code + prep cache dirs. No browser, no deps.
// Run: node scripts/intake.mjs "<CODE>"
// Regex/metachars live here, NOT on the command line, so it behaves
// identically under PowerShell, cmd, and the POSIX Bash tool.
import fs from 'node:fs';

const code = (process.argv[2] || '').trim();
if (!code) { console.error('ERROR: empty case code'); process.exit(1); }
if (/[\\/:*?"<>|]/.test(code)) {
  console.error(`ERROR: illegal path chars in case code: ${code}`);
  process.exit(1);
}

fs.mkdirSync('data/cases', { recursive: true });

const idx = 'data/cases/_index.json';
if (!fs.existsSync(idx)) {
  fs.writeFileSync(idx, '{}');
} else {
  try { JSON.parse(fs.readFileSync(idx, 'utf8')); }
  catch (e) { console.error(`ERROR: corrupt _index.json — ${e.message}`); process.exit(1); }
}

console.log(`intake OK ${code}`);
