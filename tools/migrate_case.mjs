#!/usr/bin/env node
// tools/migrate_case.mjs — Re-sort comments chronologically, re-classify roles,
// sanitize comment schema, re-calculate case hash, and re-render case.md for cached cases.
//
// Usage:
//   node tools/migrate_case.mjs [path-to-case.json | caseCode | all]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeHash,
  sortCommentsChronological,
  classifyRole,
  isBlacklistedTs,
  extractSummary,
  synthesizeDescriptionComment,
  hasDescriptionComment,
  assignIds,
} from '../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = join(__dirname, '../.claude/skills/qualcomm-case-agent/scripts/render_case.mjs');
const DATA_CASES_DIR = join(__dirname, '../data/cases');

export { classifyRole, isBlacklistedTs, extractSummary, synthesizeDescriptionComment, hasDescriptionComment };

export function sanitizeComment(comment) {
  if (!comment || typeof comment !== 'object') return comment;

  const rawTs = comment.timestamp || '';
  const timestamp = isBlacklistedTs(rawTs) ? '' : rawTs;

  const body = comment.body || '';
  let summary = comment.summary;
  if (!summary || summary.trim() === '' || summary.trim() === body.trim()) {
    summary = extractSummary(body);
  }

  const sanitized = {
    ...comment,
    timestamp,
    summary,
  };

  delete sanitized.analysisLog;

  return sanitized;
}

export function migrateCaseData(caseData) {
  if (!caseData || typeof caseData !== 'object') return caseData;

  let comments = Array.isArray(caseData.comments) ? [...caseData.comments] : [];

  // Check and inject description comment if non-empty and missing from comments
  const desc = typeof caseData.description === 'string' ? caseData.description.trim() : '';
  if (desc && !hasDescriptionComment(comments, desc)) {
    const descComment = synthesizeDescriptionComment({
      description: caseData.description,
      customer: caseData.customer,
      created: caseData.created,
    });
    if (descComment) {
      comments.push(descComment);
    }
  }

  // Ensure content-derived IDs are assigned
  const { comments: idComments } = assignIds(comments);
  comments = idComments;

  // 1. Detect legacy corrupted head where empty-timestamp comments were dumped at index 0..k-1
  // while the rest of the array (k..n-1) is in increasing chronological order.
  let firstNonEmptyIdx = -1;
  for (let i = 0; i < comments.length; i++) {
    const rawTs = comments[i].timestamp || '';
    if (!isBlacklistedTs(rawTs) && rawTs.trim() !== '') {
      firstNonEmptyIdx = i;
      break;
    }
  }

  if (firstNonEmptyIdx > 0) {
    const remaining = comments.slice(firstNonEmptyIdx);
    const hasTimestamps = remaining.filter(c => {
      const ts = c.timestamp || '';
      return !isBlacklistedTs(ts) && ts.trim() !== '';
    });
    if (hasTimestamps.length > 0) {
      comments = [...comments.slice(firstNonEmptyIdx), ...comments.slice(0, firstNonEmptyIdx)];
    }
  }

  // 2. Sanitize comments & update roles
  const sanitizedComments = comments.map(c => {
    const sanitized = sanitizeComment(c);
    return {
      ...sanitized,
      role: classifyRole(sanitized.author, sanitized.company, '', sanitized.body),
    };
  });

  // 3. Re-sort chronologically with relative interpolation
  const sortedComments = sortCommentsChronological(sanitizedComments);

  // 4. Form updated case object
  const updatedCase = {
    ...caseData,
    comments: sortedComments,
  };

  // 5. Re-calculate hash
  updatedCase.hash = computeHash(updatedCase);

  return updatedCase;
}

export function migrateCaseJson(jsonPath, options = {}) {
  if (!existsSync(jsonPath)) {
    throw new Error(`File not found: ${jsonPath}`);
  }
  const raw = readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);

  const updatedCase = migrateCaseData(data);

  // Write back to json
  writeFileSync(jsonPath, JSON.stringify(updatedCase, null, 2), 'utf8');

  // Re-render case.md
  spawnSync(process.execPath, [RENDER_SCRIPT, jsonPath], { encoding: 'utf8' });

  // Update _index.json if present alongside jsonPath — never fall back to the
  // real DATA_CASES_DIR when migrating an out-of-tree (e.g. test fixture)
  // case.json, or that fallback silently writes fixture data into production.
  const caseCode = updatedCase.caseNumber || basename(dirname(jsonPath));
  const candidateIndex = options.indexPath || join(dirname(dirname(jsonPath)), '_index.json');
  const indexPath = existsSync(candidateIndex) ? candidateIndex : null;

  if (indexPath && existsSync(indexPath)) {
    try {
      let index = {};
      try {
        index = JSON.parse(readFileSync(indexPath, 'utf8'));
      } catch {
        index = {};
      }
      index[caseCode] = {
        syncedAt: new Date().toISOString(),
        commentCount: updatedCase.comments.length,
        hash: updatedCase.hash,
        ...(updatedCase.enrichment?.enrichedAt ? { enrichedAt: updatedCase.enrichment.enrichedAt } : {}),
      };
      writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
    } catch (e) {
      process.stderr.write(`Warning: Failed to update _index.json: ${e.message}\n`);
    }
  }

  return { ok: true, jsonPath, caseNumber: caseCode, commentCount: updatedCase.comments.length, hash: updatedCase.hash };
}

export const migrateCase = migrateCaseJson;

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
      console.log(`Migrated ${res.caseNumber || res.jsonPath}: ${res.commentCount} comments, hash=${res.hash}`);
    } catch (e) {
      console.error(`Error migrating ${t}: ${e.message}`);
      process.exit(1);
    }
  }
}
