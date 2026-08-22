#!/usr/bin/env node
// render_case.mjs — deterministic markdown renderer for the Qualcomm Case Management Agent.
// Reads a case.json and writes sibling <stem>.md (case.md) in the SAME folder.
// Output dir + stem are derived from the input path, so pointing it at
// data/cases/<CODE>/case.json keeps the artifact in that case folder.
//
//   node render_case.mjs "data/cases/08550063/case.json"
//
// Input shape (see SKILL.md): Comments are expected in chronological order (Oldest -> Newest).
// This script formats what is in the JSON into clean, human-readable Markdown.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('usage: node render_case.mjs <path-to-case.json>');
  process.exit(2);
}

const _raw = readFileSync(jsonPath, 'utf8');
const data = JSON.parse(_raw.charCodeAt(0) === 0xFEFF ? _raw.slice(1) : _raw);
const dir = dirname(jsonPath);
const stem = basename(jsonPath).replace(/\.json$/i, '');

const S = v => (v == null ? '' : String(v));
const arr = v => (Array.isArray(v) ? v : []);
const comments = arr(data.comments);

/* ----------------------------- Markdown ----------------------------- */
function md() {
  const L = [];
  L.push(`# ${S(data.caseNumber) || stem} — ${S(data.title) || 'Untitled case'}`);
  L.push('');
  const meta = [
    ['Status', data.status],
    ['Priority', data.priority],
    ['Severity', data.severity],
    ['Product', data.product],
    ['Component', data.component],
    ['Customer', data.customer],
    ['Created', data.created],
    ['Updated', data.updated],
    ['Comments', comments.length],
    ['Synced', data.extractedAt],
  ].filter(([, v]) => S(v) !== '');
  for (const [k, v] of meta) L.push(`- **${k}:** ${S(v)}`);
  if (S(data.url)) L.push(`- **URL:** ${S(data.url)}`);
  L.push('');

  if (S(data.description)) {
    L.push('## Description', '', S(data.description), '');
  }

  L.push('## Chronological Timeline of Comments', '');
  comments.forEach((c, i) => {
    const head = [S(c.timestamp), S(c.author)].filter(Boolean).join(' · ');
    L.push(`### ${i + 1}. ${head || 'Comment'}`, '');
    if (S(c.summary) && S(c.summary) !== S(c.body)) {
      L.push(`> **Summary:** ${S(c.summary)}`, '');
    }
    if (S(c.body)) L.push(S(c.body), '');
    const atts = arr(c.attachments).filter(a => a && (S(a.name) || S(a.href) || S(a.url)));
    if (atts.length) {
      L.push('**Attachments:** ' + atts.map(a => `[${S(a.name) || 'file'}](${S(a.href || a.url)})`).join(', '), '');
    }
    L.push('---', '');
  });
  return L.join('\n');
}

const mdPath = join(dir, `${stem}.md`);
writeFileSync(mdPath, md(), 'utf8');
console.log(`wrote:\n  ${mdPath}`);
