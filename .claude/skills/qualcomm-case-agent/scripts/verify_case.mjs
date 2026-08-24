// scripts/verify_case.mjs — post-capture QA gate for run_case.mjs's output.
//
// Independent of the capture pipeline: reads only the persisted files under
// data/cases/<CODE>/ and checks that what got written is actually complete
// and accurate, catching anything a capture bug could have let through
// (collapsed teaser text, duplicate/missing comment ids, empty required fields).
//
//     node verify_case.mjs <CODE> [<CODE>...]
//     node verify_case.mjs --all              (every cached case)
//
// Exit 0 if every case has zero ERRORs (WARNs are informational, e.g. a
// header field the base capture never fills without a Detail-tab pass).
// Exit 1 if any case has at least one ERROR.
// Prints one JSON report line per case to stdout, a human summary to stderr.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';

const COLLAPSED_BODY_RE = /\bExpand Post\s*$/i;
const MOJIBAKE_RE = /â”¬Ã¡|Â(?=[\s\n]|$)/;
const REQUIRED_CORE_FIELDS = ['caseNumber', 'title', 'status', 'url', 'hash', 'extractedAt'];
const OPTIONAL_FIELDS_WARN_IF_EMPTY = ['updated', 'product', 'description', 'priority'];
const RENDERED_FILES = ['case.md'];

function readJsonLoose(path) {
  const t = readFileSync(path, 'utf8');
  return JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
}

export function verifyCase(code, dir = join(DATA_DIR, code)) {
  const errors = [];
  const warnings = [];
  const casePath = join(dir, 'case.json');

  if (!existsSync(casePath)) {
    return { code, ok: false, errors: [`case.json missing at ${casePath}`], warnings: [] };
  }

  let c;
  try {
    c = readJsonLoose(casePath);
  } catch (e) {
    return { code, ok: false, errors: [`case.json is not valid JSON: ${e.message}`], warnings: [] };
  }

  for (const f of REQUIRED_CORE_FIELDS) {
    if (!String(c[f] ?? '').trim()) errors.push(`required field "${f}" is empty`);
  }
  for (const f of OPTIONAL_FIELDS_WARN_IF_EMPTY) {
    if (!String(c[f] ?? '').trim()) warnings.push(`field "${f}" is empty (expected without a Detail-tab pass)`);
  }

  if (!Array.isArray(c.comments) || c.comments.length === 0) {
    errors.push('comments array is missing or empty');
  } else {
    const seenIds = new Map();
    c.comments.forEach((cm, i) => {
      const where = `comment[${i}] (${cm.author || 'unknown author'})`;
      if (!String(cm.id || '').trim()) errors.push(`${where}: missing id`);
      if (!String(cm.author || '').trim()) errors.push(`${where}: missing author`);
      if (!String(cm.timestamp || '').trim()) warnings.push(`${where}: missing timestamp`);
      if (!String(cm.body || '').trim()) errors.push(`${where}: empty body`);
      if (COLLAPSED_BODY_RE.test(cm.body || '')) {
        errors.push(`${where}: body still ends in "Expand Post" — capture persisted a collapsed/truncated post`);
      }
      if (MOJIBAKE_RE.test(cm.body || '')) {
        errors.push(`${where}: body contains an unclean separator artifact (mojibake leaked past cleanBody)`);
      }
      if (/<\/?(?:div|span|p|br)\b/i.test(cm.body || '')) {
        errors.push(`${where}: body contains raw HTML tags — extraction likely grabbed markup instead of text`);
      }
      if (cm.id) {
        seenIds.set(cm.id, (seenIds.get(cm.id) || 0) + 1);
      }
    });
    for (const [id, n] of seenIds) {
      if (n > 1) errors.push(`comment id "${id}" is used by ${n} comments — identity collision`);
    }
    if (typeof c.displayedCommentCount === 'number' && c.displayedCommentCount !== c.comments.length) {
      warnings.push(`displayedCommentCount (${c.displayedCommentCount}) != persisted comments (${c.comments.length}) — may be expected if replies nest under top-level posts`);
    }
  }

  // Capture evidence — what the expander actually left behind. A capture that
  // persisted while a control was still hiding content looks complete in the
  // JSON (case 08503838 lost a nested reply with no error anywhere), so the
  // counters are the only thing that can catch it after the fact.
  if (!c.capture) {
    warnings.push('no capture evidence block (cache written before run_case.mjs recorded it)');
  } else {
    const { pendingExpand, pendingMoreComments, screenshot } = c.capture;
    if (pendingExpand > 0) {
      errors.push(`capture left ${pendingExpand} post(s) still showing "Expand Post" — content is missing from this case`);
    }
    if (pendingMoreComments > 0) {
      errors.push(`capture left ${pendingMoreComments} reply thread(s) still showing "more comments" — nested replies are missing from this case`);
    }
    if (!screenshot) {
      warnings.push('capture recorded no screenshot — the expansion cannot be visually audited');
    } else if (!existsSync(join(dir, screenshot))) {
      warnings.push(`capture claims a screenshot (${screenshot}) that is not on disk`);
    }
  }

  for (const f of RENDERED_FILES) {
    const p = join(dir, f);
    if (!existsSync(p)) { errors.push(`${f} was not rendered`); continue; }
    const size = statSync(p).size;
    if (size === 0) { errors.push(`${f} exists but is 0 bytes`); continue; }
    const body = readFileSync(p, 'utf8');
    if (COLLAPSED_BODY_RE.test(body.trim())) {
      warnings.push(`${f} ends in a literal "Expand Post" — check rendering, not just the source JSON`);
    }
  }

  return { code, ok: errors.length === 0, errors, warnings };
}

function listCachedCodes() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function main(argv) {
  const codes = argv.includes('--all') ? listCachedCodes() : argv.filter(a => !a.startsWith('--'));
  if (codes.length === 0) {
    process.stderr.write('usage: node verify_case.mjs <CODE> [<CODE>...] | --all\n');
    process.exit(1);
  }

  let anyError = false;
  let totalWarnings = 0;
  for (const code of codes) {
    const report = verifyCase(code);
    process.stdout.write(JSON.stringify(report) + '\n');
    totalWarnings += report.warnings.length;
    if (!report.ok) anyError = true;
    const label = report.ok ? 'PASS' : 'FAIL';
    process.stderr.write(`${label} ${code} — ${report.errors.length} error(s), ${report.warnings.length} warning(s)\n`);
    for (const e of report.errors) process.stderr.write(`  ERROR: ${e}\n`);
    for (const w of report.warnings) process.stderr.write(`  warn:  ${w}\n`);
  }
  process.stderr.write(`\n${codes.length} case(s) checked, ${anyError ? 'FAILURES FOUND' : 'all passed'}, ${totalWarnings} total warning(s)\n`);
  process.exit(anyError ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
