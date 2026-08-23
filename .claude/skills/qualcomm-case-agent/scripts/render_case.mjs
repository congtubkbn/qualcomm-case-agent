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
import { fileURLToPath } from 'node:url';
import { classifyRole } from './scrape_case.mjs';

const S = v => (v == null ? '' : String(v));
const arr = v => (Array.isArray(v) ? v : []);

/**
 * Format a comment or description body for Markdown rendering.
 * Preserves line structure, formats lists, renders modem log excerpts as fenced blocks,
 * escapes Markdown headers within bodies, and maintains readability without breaking document-level structure.
 */
export function formatBody(body) {
  if (!body) return '';
  const text = String(body).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const out = [];

  const isListItem = (line) => /^\s*(\d+\.|[-*+])\s+/.test(line);
  const isLogLine = (line) => /^\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*\|/.test(line);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      out.push('');
      continue;
    }

    // Fenced code block for runs of modem log lines
    if (isLogLine(line)) {
      const logLines = [line];
      while (i + 1 < lines.length && isLogLine(lines[i + 1])) {
        i++;
        logLines.push(lines[i]);
      }
      if (out.length > 0 && out[out.length - 1] !== '') {
        out.push('');
      }
      out.push('```');
      for (const logLine of logLines) {
        out.push(logLine);
      }
      out.push('```');
      continue;
    }

    // Escape leading # that would create a markdown header hierarchy issue
    if (/^\s*#{1,6}\s/.test(line)) {
      line = line.replace(/^(\s*)#{1,6}\s/, (m, spaces) => `${spaces}\\${m.trimStart()}`);
    }

    // If this line is a list item and previous line was regular non-empty text, insert blank line
    if (isListItem(line)) {
      if (out.length > 0 && out[out.length - 1] !== '' && !isListItem(lines[i - 1])) {
        out.push('');
      }
      out.push(line);
    } else {
      // Regular text line.
      // If previous item in out was a fenced code block, separate with blank line
      if (out.length > 0 && out[out.length - 1] === '```') {
        out.push('');
      }

      // If the next line is also non-empty (and not the end of lines, a list item, or a log line),
      // append 2 trailing spaces for hard line break in Markdown
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
      if (nextLine && !isListItem(nextLine) && !isLogLine(lines[i + 1])) {
        out.push(line.trimEnd() + '  ');
      } else {
        out.push(line.trimEnd());
      }
    }
  }

  return out.join('\n');
}

/* ----------------------------- Markdown ----------------------------- */
export function generateMarkdown(data, stem = 'case') {
  const allComments = arr(data?.comments);
  const desc = S(data?.description).trim();
  const timelineComments = allComments.filter(c => !(desc && S(c?.body).trim() === desc));

  const L = [];
  L.push(`# ${S(data?.caseNumber) || stem} — ${S(data?.title) || 'Untitled case'}`);
  L.push('');
  const meta = [
    ['Status', data?.status],
    ['Priority', data?.priority],
    ['Severity', data?.severity],
    ['Product', data?.product],
    ['Component', data?.component],
    ['Contact Name', data?.contactName],
    ['Customer Project', data?.customerProject],
    ['Customer', data?.customer],
    ['Account Name', data?.accountName && data?.accountName !== data?.customer ? data?.accountName : null],
    ['Case Record Type', data?.caseRecordType],
    ['Related CRs', data?.relatedCRs],
    ['Date Opened', data?.openedAt],
    ['Date Closed', data?.closedAt],
    ['Created', data?.created],
    ['Updated', data?.updated],
    ['Comments', timelineComments.length],
    ['Synced', data?.extractedAt],
  ].filter(([, v]) => S(v) !== '');
  const mdCell = v => S(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  if (meta.length) {
    L.push('| Field | Value |', '| --- | --- |');
    for (const [k, v] of meta) L.push(`| ${k} | ${mdCell(v)} |`);
  }
  if (S(data?.url)) L.push(`- **URL:** ${S(data?.url)}`);
  L.push('');

  if (desc) {
    L.push('## Description', '');
    L.push(formatBody(desc), '');
  }

  L.push('## Chronological Timeline of Comments', '');
  timelineComments.forEach((c, i) => {
    const role = c?.role || classifyRole(c?.author, c?.company, '', c?.body);
    const authorStr = S(c?.author) ? (role ? `${S(c.author)} (${role})` : S(c.author)) : (role ? `(${role})` : '');
    const head = [S(c?.timestamp), authorStr].filter(Boolean).join(' · ');
    L.push(`### ${i + 1}. ${head || 'Comment'}`, '');
    if (S(c?.body)) L.push(formatBody(c.body), '');
    const rawAtts = arr(c?.attachments);
    const validAtts = rawAtts.filter(a => {
      if (!a) return false;
      if (typeof a === 'string') return a.trim().length > 0;
      return S(a.name).trim().length > 0 || S(a.url || a.href).trim().length > 0;
    });

    if (validAtts.length) {
      L.push('**Attachments:**');
      for (const a of validAtts) {
        if (typeof a === 'string') {
          L.push(`- ${a.trim()}`);
        } else {
          const name = S(a.name).trim();
          const url = S(a.url || a.href).trim();
          if (name && url) {
            L.push(`- [${name}](${url})`);
          } else if (name) {
            L.push(`- ${name}`);
          } else if (url) {
            L.push(`- [${url}](${url})`);
          }
        }
      }
      L.push('');
    }
    L.push('---', '');
  });
  return L.join('\n');
}

export function renderCase(jsonPath) {
  const _raw = readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(_raw.charCodeAt(0) === 0xFEFF ? _raw.slice(1) : _raw);
  const dir = dirname(jsonPath);
  const stem = basename(jsonPath).replace(/\.json$/i, '');
  const mdPath = join(dir, `${stem}.md`);
  writeFileSync(mdPath, generateMarkdown(data, stem), 'utf8');
  return mdPath;
}

const isDirectRun = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('render_case.mjs')
);

if (isDirectRun) {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error('usage: node render_case.mjs <path-to-case.json>');
    process.exit(2);
  }
  const mdPath = renderCase(jsonPath);
  console.log(`wrote:\n  ${mdPath}`);
}

