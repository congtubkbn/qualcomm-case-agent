#!/usr/bin/env node
// tools/migrate_case.mjs — Re-sort comments chronologically, re-classify roles,
// re-calculate case hash, and re-render case.md for cached cases.
//
// Usage:
//   node tools/migrate_case.mjs [path-to-case.json | caseCode | all]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeHash, sortCommentsChronological } from '../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = join(__dirname, '../.claude/skills/qualcomm-case-agent/scripts/render_case.mjs');
const DATA_CASES_DIR = join(__dirname, '../data/cases');

export function classifyRole(author, company = '', context = '', body = '') {
  const combined = ((author || '') + ' ' + (company || '') + ' ' + (context || '')).toLowerCase();
  if (combined.includes('qualcomm') || combined.includes('@qualcomm.com') || combined.includes('qcom support')) {
    return 'Qualcomm';
  }
  if (combined.includes('system') || combined.includes('automated process')) {
    return 'System';
  }
  const firstLines = (body || '').slice(0, 200).toLowerCase();
  if (/^(?:dear|hi|hello)\s+customer\b/i.test(firstLines.trim()) || /\bqualcomm\s+team\b/i.test(firstLines)) {
    return 'Qualcomm';
  }
  if (/^(?:dear|hi|hello)\s+(?:qcom|qualcomm)\b/i.test(firstLines.trim())) {
    return 'Customer';
  }
  const authorLower = (author || '').toLowerCase();
  if (['aiden an', 'seunghoon lee', 'hoon lee', 'cs lee', 'kyungnam ken lee'].includes(authorLower)) {
    return 'Qualcomm';
  }
  return 'Customer';
}

export function migrateCaseJson(jsonPath) {
  if (!existsSync(jsonPath)) {
    throw new Error(`File not found: ${jsonPath}`);
  }
  const raw = readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);

  let comments = Array.isArray(data.comments) ? data.comments : [];
  
  // 1. Detect legacy corrupted head where empty-timestamp comments were dumped at index 0..k-1
  // while the rest of the array (k..n-1) is in increasing chronological order.
  let firstNonEmptyIdx = -1;
  for (let i = 0; i < comments.length; i++) {
    if ((comments[i].timestamp || '').trim() !== '') {
      firstNonEmptyIdx = i;
      break;
    }
  }

  if (firstNonEmptyIdx > 0) {
    // Check if the remaining comments with timestamps are in increasing order
    const remaining = comments.slice(firstNonEmptyIdx);
    const hasTimestamps = remaining.filter(c => (c.timestamp || '').trim() !== '');
    if (hasTimestamps.length > 0) {
      // Rotate leading empty-timestamp comments to the end
      comments = [...comments.slice(firstNonEmptyIdx), ...comments.slice(0, firstNonEmptyIdx)];
    }
  }

  // 2. Update roles
  const updatedComments = comments.map(c => ({
    ...c,
    role: classifyRole(c.author, c.company, '', c.body),
  }));

  // 3. Re-sort chronologically with relative interpolation
  const sortedComments = sortCommentsChronological(updatedComments);

  // 4. Update case object
  const updatedCase = {
    ...data,
    comments: sortedComments,
  };

  // 5. Re-calculate hash
  updatedCase.hash = computeHash(updatedCase);

  // 6. Write back to json
  writeFileSync(jsonPath, JSON.stringify(updatedCase, null, 2), 'utf8');

  // 7. Re-render case.md
  spawnSync(process.execPath, [RENDER_SCRIPT, jsonPath], { encoding: 'utf8' });

  return { ok: true, jsonPath, commentCount: sortedComments.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const targets = [];

  if (!arg || arg === 'all') {
    if (existsSync(DATA_CASES_DIR)) {
      for (const entry of readdirSync(DATA_CASES_DIR)) {
        const full = join(DATA_CASES_DIR, entry, 'case.json');
        if (existsSync(full)) targets.push(full);
      }
    }
  } else if (/^\d{8}$/.test(arg)) {
    targets.push(join(DATA_CASES_DIR, arg, 'case.json'));
  } else {
    targets.push(resolve(arg));
  }

  if (targets.length === 0) {
    console.error('No case.json targets found.');
    process.exit(1);
  }

  for (const t of targets) {
    try {
      const res = migrateCaseJson(t);
      console.log(`Migrated ${res.jsonPath} (${res.commentCount} comments)`);
    } catch (e) {
      console.error(`Error migrating ${t}: ${e.message}`);
      process.exit(1);
    }
  }
}
