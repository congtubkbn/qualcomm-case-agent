// PROTOTYPE — throwaway, answers issue #109 ("how should a Reply read under its
// parent in the Chronological Timeline of Comments?"). Not wired into run_case.mjs.
// Run: node .claude/skills/qualcomm-case-agent/scripts/render_case.prototype-109.mjs <caseCode>
// Delete after the layout decision is captured on #109 and folded into render_case.mjs.

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatBody } from './render_case.mjs';
import { classifyRole } from './scrape_case.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S = v => (v == null ? '' : String(v));

const caseCode = process.argv[2] || '08633581';
const jsonPath = path.resolve(__dirname, '../../../../data/cases', caseCode, 'case.json');
const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
const rawComments = data.comments || data.timelineComments || [];

// case.json does not carry parentId/isReply yet (stripped by finalize() per #105/#106
// design — not implemented until the schema ticket lands). Synthetic threading below,
// derived from #106's own DOM-order findings for this exact case (08633581): a single
// top-level post followed by 3 replies to it, in document/chronological order.
const comments = rawComments.map((c, i) => ({
  ...c,
  parentId: i === 0 ? null : rawComments[0].id,
}));

const TRUNCATE = 280;
const bodyFor = c => {
  const b = S(c.body).trim();
  return b.length > TRUNCATE ? b.slice(0, TRUNCATE) + '\n\n*[...truncated for prototype legibility...]*' : b;
};
const headFor = c => {
  const role = c.role || classifyRole(c.author, c.company, '', c.body);
  const authorStr = S(c.author) ? (role ? `${S(c.author)} (${role})` : S(c.author)) : (role ? `(${role})` : '');
  return [S(c.timestamp), authorStr].filter(Boolean).join(' · ');
};
const idxById = new Map(comments.map((c, i) => [c.id, i]));

function variantA(L) {
  // A: indent marker (↳) in the heading + blockquoted body for replies
  comments.forEach((c, i) => {
    const isReply = c.parentId != null;
    const marker = isReply ? '↳ ' : '';
    L.push(`### ${i + 1}. ${marker}${headFor(c) || 'Comment'}`, '');
    const body = formatBody(bodyFor(c));
    if (isReply) {
      L.push(...body.split('\n').map(line => (line ? `> ${line}` : '>')), '');
    } else {
      L.push(body, '');
    }
    L.push('---', '');
  });
}

function variantB(L) {
  // B: nested sub-heading — replies drop one heading level under the parent
  comments.forEach((c, i) => {
    const isReply = c.parentId != null;
    const hashes = isReply ? '####' : '###';
    const label = isReply ? 'Reply · ' : '';
    L.push(`${hashes} ${i + 1}. ${label}${headFor(c) || 'Comment'}`, '');
    L.push(formatBody(bodyFor(c)), '');
    L.push('---', '');
  });
}

function variantC(L) {
  // C: flat heading level, inline "in reply to #N" annotation right under the heading
  comments.forEach((c, i) => {
    const isReply = c.parentId != null;
    L.push(`### ${i + 1}. ${headFor(c) || 'Comment'}`, '');
    if (isReply) {
      const parentNum = idxById.get(c.parentId) + 1;
      L.push(`*↳ in reply to #${parentNum}*`, '');
    }
    L.push(formatBody(bodyFor(c)), '');
    L.push('---', '');
  });
}

const L = [];
L.push(`# Prototype #109 — threaded-reply layouts for \`case.md\` (case ${caseCode})`, '');
L.push('Synthetic \`parentId\` per #106\'s DOM-order findings: comment 1 is the post, comments 2-4 are replies to it. Numbering stays strict chronological (1..N) in all three variants — only the reply\'s visual presentation changes.', '');

L.push('## Variant A — indent marker (↳) + blockquoted body', '');
variantA(L);

L.push('## Variant B — nested sub-heading (#### for replies)', '');
variantB(L);

L.push('## Variant C — flat heading, inline "in reply to #N" annotation', '');
variantC(L);

const outPath = path.resolve(__dirname, '../../../../data/cases', caseCode, 'PROTOTYPE-109-reply-layouts.md');
writeFileSync(outPath, L.join('\n'), 'utf8');
console.log('Wrote', outPath);
