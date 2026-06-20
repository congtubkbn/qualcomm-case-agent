#!/usr/bin/env node
// render_case.mjs — deterministic renderer for the Qualcomm Case Management Agent.
// Reads a case.json and writes sibling <CODE>.md and <CODE>.html (single-file, inline CSS).
//
//   node render_case.mjs "data/cases/CASE-01234567.json"
//
// Input shape (see SKILL.md PHASE 5). Comments are expected newest-first already; this script
// does not reorder, summarize, or invent — it only formats what is in the JSON.

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
const enrich = data.enrichment || {};

/* ----------------------------- Markdown ----------------------------- */
function md() {
  const L = [];
  L.push(`# ${S(data.caseNumber) || stem} — ${S(data.title) || 'Untitled case'}`);
  L.push('');
  const meta = [
    ['Status', data.status], ['Priority', data.priority], ['Severity', data.severity],
    ['Product', data.product], ['Customer', data.customer],
    ['Created', data.created], ['Updated', data.updated],
    ['Comments', comments.length], ['Synced', data.extractedAt],
  ].filter(([, v]) => S(v) !== '');
  for (const [k, v] of meta) L.push(`- **${k}:** ${S(v)}`);
  if (S(data.url)) L.push(`- **URL:** ${S(data.url)}`);
  L.push('');

  if (S(enrich.engineerSummary)) { L.push('## Engineer Summary', '', S(enrich.engineerSummary), ''); }
  if (S(enrich.rootCause))       { L.push('## Root Cause', '', S(enrich.rootCause), ''); }
  if (arr(enrich.recommendedActions).length) {
    L.push('## Recommended Actions', '');
    for (const a of enrich.recommendedActions) L.push(`- ${S(a)}`);
    L.push('');
  }
  if (arr(enrich.tags).length) { L.push('## Tags', '', enrich.tags.map(t => `\`${S(t)}\``).join(' '), ''); }
  if (arr(enrich.timeline).length) {
    L.push('## Timeline (newest first)', '');
    for (const t of enrich.timeline) {
      if (t && typeof t === 'object') L.push(`- **${S(t.date)}** — ${S(t.event)}`);
      else L.push(`- ${S(t)}`);
    }
    L.push('');
  }
  if (S(data.description)) { L.push('## Description', '', S(data.description), ''); }

  L.push('## Comments (newest first)', '');
  comments.forEach((c, i) => {
    const head = [S(c.timestamp), S(c.company), S(c.author) + (S(c.role) ? ` (${S(c.role)})` : '')]
      .filter(x => x && x !== ' ()').join(' · ');
    L.push(`### ${i + 1}. ${head || 'Comment'}`, '');
    const cSum = (enrich.commentSummaries || {})[c.id];
    if (S(cSum)) L.push(`> **Summary (engineer):** ${S(cSum)}`, '');
    if (S(c.body)) L.push(S(c.body), '');
    for (const log of arr(c.analysisLog)) { if (S(log)) L.push('```', S(log), '```', ''); }
    const atts = arr(c.attachments).filter(a => a && (S(a.name) || S(a.href)));
    if (atts.length) {
      L.push('**Attachments:** ' + atts.map(a => `[${S(a.name) || 'file'}](${S(a.href)})`).join(', '), '');
    }
    L.push('---', '');
  });
  return L.join('\n');
}

/* -------------------------- Report (summary) ------------------------ */
function report() {
  const L = [];
  L.push(`# Case Report — ${S(data.caseNumber) || stem}`, '');
  L.push(`**${S(data.title) || 'Untitled case'}**`, '');
  const meta = [
    ['Status', data.status], ['Priority', data.priority], ['Severity', data.severity],
    ['Product', data.product], ['Customer', data.customer], ['Updated', data.updated],
    ['Comments', comments.length], ['Synced', data.extractedAt],
  ].filter(([, v]) => S(v) !== '');
  L.push(meta.map(([k, v]) => `${k}: ${S(v)}`).join(' · '), '');

  // Completeness flag: captured vs displayed (set during extraction).
  if (data.displayedCommentCount != null &&
      Number(data.displayedCommentCount) !== comments.length) {
    L.push(`> ⚠ **Completeness:** captured ${comments.length} of ${S(data.displayedCommentCount)} displayed comments — extraction may be incomplete.`, '');
  }

  if (S(enrich.engineerSummary)) L.push('## Summary', '', S(enrich.engineerSummary), '');
  if (S(enrich.rootCause))       L.push('## Root Cause', '', S(enrich.rootCause), '');
  if (arr(enrich.recommendedActions).length) {
    L.push('## Recommended Actions', '');
    enrich.recommendedActions.forEach((a, i) => L.push(`${i + 1}. ${S(a)}`));
    L.push('');
  }
  if (arr(enrich.tags).length) L.push('**Tags:** ' + enrich.tags.map(t => `\`${S(t)}\``).join(' '), '');
  if (arr(enrich.timeline).length) {
    L.push('## Timeline', '');
    for (const t of enrich.timeline) {
      if (t && typeof t === 'object') L.push(`- ${S(t.date)} — ${S(t.event)}`);
      else L.push(`- ${S(t)}`);
    }
    L.push('');
  }
  L.push('## Comments (one-line, newest first)', '');
  comments.forEach((c, i) => {
    const who = [S(c.timestamp), S(c.company), S(c.author)].filter(Boolean).join(' · ');
    const oneline = S((enrich.commentSummaries || {})[c.id]) || S(c.body).replace(/\s+/g, ' ').slice(0, 160);
    L.push(`${i + 1}. **${who}** — ${oneline}`);
  });
  L.push('', `_Full data: ${stem}.json · Full review: ${stem}.html_`);
  return L.join('\n');
}

/* ------------------------------- HTML ------------------------------- */
const esc = s => S(s).replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const nl2br = s => esc(s).replace(/\n/g, '<br>');

function html() {
  const badge = (label, v) => S(v) ? `<span class="badge"><b>${esc(label)}</b> ${esc(v)}</span>` : '';
  const incomplete = data.displayedCommentCount != null &&
    Number(data.displayedCommentCount) !== comments.length;
  const completeness = incomplete
    ? `<div class="warn">⚠ Completeness: captured ${comments.length} of ${esc(data.displayedCommentCount)} displayed comments — extraction may be incomplete.</div>`
    : '';
  const cards = [];
  if (S(enrich.engineerSummary)) cards.push(`<div class="card"><h2>Engineer Summary</h2><p>${nl2br(enrich.engineerSummary)}</p></div>`);
  if (S(enrich.rootCause))       cards.push(`<div class="card"><h2>Root Cause</h2><p>${nl2br(enrich.rootCause)}</p></div>`);
  if (arr(enrich.recommendedActions).length)
    cards.push(`<div class="card"><h2>Recommended Actions</h2><ul>${enrich.recommendedActions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`);

  const tags = arr(enrich.tags).length
    ? `<div class="tags">${enrich.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : '';

  const timeline = arr(enrich.timeline).length
    ? `<div class="card"><h2>Timeline</h2><ul class="tl">${enrich.timeline.map(t =>
        (t && typeof t === 'object')
          ? `<li><span class="when">${esc(t.date)}</span> ${esc(t.event)}</li>`
          : `<li>${esc(t)}</li>`).join('')}</ul></div>` : '';

  const commentCards = comments.map((c, i) => {
    const head = [S(c.timestamp), S(c.company), S(c.author) + (S(c.role) ? ` (${S(c.role)})` : '')]
      .filter(x => x && x !== ' ()').map(esc).join(' &middot; ');
    const logs = arr(c.analysisLog).filter(x => S(x));
    const atts = arr(c.attachments).filter(a => a && (S(a.name) || S(a.href)));
    const details = (logs.length || atts.length) ? `
      <details><summary>Analysis log / attachments</summary>
        ${logs.map(l => `<pre>${esc(l)}</pre>`).join('')}
        ${atts.length ? `<ul>${atts.map(a => `<li><a href="${esc(a.href)}">${esc(a.name) || 'file'}</a></li>`).join('')}</ul>` : ''}
      </details>` : '';
    return `<article class="comment">
      <div class="chead"><span class="cnum">#${i + 1}</span> ${head || 'Comment'}</div>
      ${(cSumH => S(cSumH) ? `<div class="esum"><b>Summary (engineer):</b> ${nl2br(cSumH)}</div>` : '')((enrich.commentSummaries || {})[c.id])}
      ${S(c.body) ? `<div class="body">${nl2br(c.body)}</div>` : ''}
      ${details}
    </article>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.caseNumber || stem)} — ${esc(data.title || 'Case')}</title>
<style>
:root{--bg:#0f1419;--card:#1a2029;--line:#2a323d;--fg:#e6edf3;--mut:#8b98a5;--acc:#3b82f6;--hl:#1e3a5f}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;background:#0b0f14ee;backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:14px 22px;z-index:5}
header h1{margin:0 0 6px;font-size:18px}
.badge{display:inline-block;margin:2px 8px 2px 0;padding:2px 8px;border:1px solid var(--line);border-radius:6px;color:var(--mut);font-size:12px}
.badge b{color:var(--fg)}
main{max-width:980px;margin:0 auto;padding:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:0 0 16px}
.card h2{margin:0 0 8px;font-size:15px;color:var(--acc)}
.tags{margin:0 0 16px}.tag{display:inline-block;margin:2px;padding:2px 9px;background:#23303f;border-radius:999px;font-size:12px;color:#bcd}
.tl{list-style:none;padding:0;margin:0}.tl li{padding:4px 0;border-bottom:1px dashed var(--line)}.when{color:var(--mut);margin-right:8px}
.comment{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:10px;padding:14px 18px;margin:0 0 14px}
.chead{color:var(--mut);font-size:13px;margin-bottom:8px}.cnum{color:var(--acc);font-weight:700;margin-right:6px}
.esum{background:var(--hl);border-radius:8px;padding:8px 12px;margin:0 0 10px}
.body{white-space:normal}
pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font:12px/1.45 ui-monospace,Consolas,monospace}
details{margin-top:8px}summary{cursor:pointer;color:var(--mut)}
.warn{background:#3a2a12;border:1px solid #6b4f1d;color:#f0c674;border-radius:8px;padding:10px 14px;margin:0 0 16px}
a{color:#6ea8fe}
</style></head><body>
<header>
  <h1>${esc(data.caseNumber || stem)} — ${esc(data.title || 'Untitled case')}</h1>
  <div>${[badge('Status', data.status), badge('Priority', data.priority), badge('Severity', data.severity),
          badge('Product', data.product), badge('Customer', data.customer), badge('Updated', data.updated),
          badge('Comments', comments.length)].join('')}</div>
</header>
<main>
  ${completeness}
  ${cards.join('\n')}
  ${tags}
  ${timeline}
  ${S(data.description) ? `<div class="card"><h2>Description</h2><p>${nl2br(data.description)}</p></div>` : ''}
  <h2 style="color:var(--acc)">Comments (newest first)</h2>
  ${commentCards}
  ${S(data.url) ? `<p style="color:var(--mut)"><a href="${esc(data.url)}">${esc(data.url)}</a></p>` : ''}
</main></body></html>`;
}

const mdPath = join(dir, `${stem}.md`);
const htmlPath = join(dir, `${stem}.html`);
const reportPath = join(dir, `${stem}.report.md`);
writeFileSync(mdPath, md(), 'utf8');
writeFileSync(htmlPath, html(), 'utf8');
writeFileSync(reportPath, report(), 'utf8');
console.log(`wrote:\n  ${reportPath}\n  ${mdPath}\n  ${htmlPath}`);
