// tools/gen_design.mjs — regenerate the machine-derived part of docs/DESIGN.md.
//
//     node tools/gen_design.mjs            rewrite the generated block in place
//     node tools/gen_design.mjs --check    exit 1 if the block is stale (CI / hook)
//
// Why: a design doc rots the moment a function is renamed. Everything in DESIGN.md
// that CAN be derived from the source (module inventory, exported API, verdict and
// exit-code tables, npm scripts) is derived here and written between markers, so a
// commit that changes the code either updates the doc or fails `--check`. The prose
// around the block — decisions, rationale, trade-offs, backlog — stays hand-written:
// that is the part a generator has no way to know.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = join(ROOT, 'docs', 'DESIGN.md');
const BEGIN = '<!-- BEGIN GENERATED: reference -->';
const END = '<!-- END GENERATED: reference -->';

// Scanned directories, in the order a reader should meet them. Directories are
// walked (not enumerated), so a new script shows up in the doc on the commit that
// adds it — that is the whole point.
const GROUPS = [
  ['Pipeline scripts', '.claude/skills/qualcomm-case-agent/scripts'],
  ['Summary scripts', '.claude/skills/qualcomm-case-summary/scripts'],
  ['Overview scripts', '.claude/skills/qualcomm-case-overview/scripts'],
  ['Dashboard', 'web'],
  ['Tests', 'tests'],
  ['Doc tooling', 'tools'],
];
const CODE_EXT = new Set(['.mjs', '.js', '.ps1']);

const rel = p => relative(ROOT, p).split(sep).join(posix.sep);
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

function listCode(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  return entries
    .map(name => join(dir, name))
    .filter(p => statSync(p).isFile() && CODE_EXT.has(extname(p)))
    .sort();
}

/** First sentence of a file's header comment: `//`/`#` runs, or a PowerShell `<# … #>` block. */
export function headerPurpose(src, fileName) {
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#!'))) i++;

  const parts = [];
  if (lines[i] && lines[i].trim().startsWith('<#')) {
    for (i++; i < lines.length && !lines[i].includes('#>'); i++) parts.push(lines[i].trim());
  } else {
    for (; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '') { if (parts.length) continue; else break; }
      if (!/^(\/\/|#)/.test(t)) break;
      parts.push(t.replace(/^(\/\/+|#+)\s?/, '').trim());
    }
  }

  let text = parts.join(' ')
    .replace(/^\.(SYNOPSIS|DESCRIPTION)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop a leading "path/to/file.ext" or "file.ext —" self-reference.
  const esc = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  text = text.replace(new RegExp(`^\\S*${esc}\\s*[—:-]?\\s*`), '');
  const stop = text.search(/\.(\s|$)/);
  return stop >= 0 ? text.slice(0, stop + 1) : text;
}

/** First sentence of the comment block directly above `line` in `lines`. */
function docAbove(lines, line) {
  const parts = [];
  for (let i = line - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '') break;
    if (t.startsWith('*/')) { parts.unshift(''); continue; }
    if (/^(\/\/|\*|\/\*)/.test(t)) { parts.unshift(t.replace(/^(\/\/+|\/\*+|\*+\/?)\s?/, '').trim()); continue; }
    break;
  }
  const text = parts.join(' ').replace(/-{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  const stop = text.search(/\.(\s|$)/);
  return stop >= 0 ? text.slice(0, stop + 1) : text;
}

/** Exported symbols of an ES module: { name, kind, signature, doc }. */
export function exportsOf(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  const re = /^export\s+(?:(async)\s+)?(function|class|const|let)\s+([A-Za-z_$][\w$]*)(.*)$/;
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (!m) return;
    const [, isAsync, keyword, name, rest] = m;
    let kind = keyword === 'function' ? (isAsync ? 'async fn' : 'function') : keyword;
    let signature = `${name}`;
    if (rest.trimStart().startsWith('(')) {
      signature = `${name}(${balanced(rest.trimStart())})`;
    } else if (rest.includes('=>')) {
      const params = rest.slice(rest.indexOf('=') + 1, rest.indexOf('=>')).trim().replace(/^\(|\)$/g, '');
      kind = 'function';
      signature = `${name}(${params})`;
    } else {
      kind = 'value';
    }
    out.push({ name, kind, signature, doc: docAbove(lines, i) });
  });
  return out;
}

/** Text inside the first balanced (...) of `s`, which must start with '('. */
function balanced(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return s.slice(1, i);
  }
  return s.slice(1);
}

function table(head, rows) {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

async function build() {
  const scanned = [];
  const sections = [];

  for (const [label, dir] of GROUPS) {
    const files = listCode(join(ROOT, dir));
    if (!files.length) continue;

    const inventory = [];
    const api = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      scanned.push([rel(file), createHash('sha256').update(src).digest('hex')]);
      const name = rel(file).split('/').pop();
      inventory.push([`\`${rel(file)}\``, src.split('\n').length, headerPurpose(src, name) || '—']);
      if (extname(file) === '.ps1') continue;
      for (const e of exportsOf(src)) api.push([`\`${name}\``, `\`${e.signature}\``, e.kind, e.doc]);
    }

    sections.push(`#### ${label}\n\n${table(['File', 'Lines', 'Purpose'], inventory)}`);
    if (api.length) {
      sections.push(`Exported API — ${label.toLowerCase()}:\n\n${table(['Module', 'Export', 'Kind', 'Contract'], api)}`);
    }
  }

  // Contract tables imported from the source of truth rather than transcribed.
  const SCRIPTS = pathToFileURL(join(ROOT, '.claude/skills/qualcomm-case-agent/scripts/'));
  const { STATUS_EXIT } = await import(new URL('run_case.mjs', SCRIPTS));
  const { EXIT } = await import(new URL('finalize_case.mjs', SCRIPTS));
  sections.push(
    `#### Verdict contract — \`run_case.mjs\` stdout \`status\` → process exit\n\n` +
    table(['status', 'exit'], Object.entries(STATUS_EXIT).map(([k, v]) => [`\`${k}\``, v])),
  );
  sections.push(
    `#### Finalizer exit codes — \`finalize_case.mjs\`\n\n` +
    table(['name', 'exit'], Object.entries(EXIT).map(([k, v]) => [`\`${k}\``, v])),
  );

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  scanned.push(['package.json', createHash('sha256').update(JSON.stringify(pkg.scripts)).digest('hex')]);
  sections.push(
    `#### Entry points — \`package.json\` scripts\n\n` +
    table(['Command', 'Runs'], Object.entries(pkg.scripts).map(([k, v]) => [`\`npm run ${k}\``, `\`${v}\``])),
  );

  const fingerprint = createHash('sha256')
    .update(scanned.sort().map(([p, h]) => `${p}:${h}`).join('\n'))
    .digest('hex').slice(0, 12);

  return [
    BEGIN,
    '',
    `> Generated by \`npm run docs\` from the source tree — **do not edit by hand**.`,
    `> Source fingerprint \`${fingerprint}\` over ${scanned.length} files.`,
    `> Stale block ⇒ \`npm run docs:check\` fails.`,
    '',
    sections.join('\n\n'),
    '',
    END,
  ].join('\n');
}

const doc = readFileSync(DOC, 'utf8');
const start = doc.indexOf(BEGIN);
const stop = doc.indexOf(END);
if (start < 0 || stop < 0) {
  console.error(`${rel(DOC)}: missing ${BEGIN} / ${END} markers`);
  process.exit(2);
}

const next = doc.slice(0, start) + (await build()) + doc.slice(stop + END.length);

if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error(`${rel(DOC)} is out of date with the source — run \`npm run docs\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${rel(DOC)} is up to date.`);
} else if (next !== doc) {
  writeFileSync(DOC, next, 'utf8');
  console.log(`updated ${rel(DOC)}`);
} else {
  console.log(`${rel(DOC)} already up to date.`);
}
