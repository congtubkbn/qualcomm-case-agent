#!/usr/bin/env node
// .claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs — Re-sort comments chronologically,
// re-classify roles, sanitize comment schema, re-calculate case hash, and re-render case.md for
// cached cases.
//
// Usage:
//   node .claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs [path-to-case.json | caseCode | all]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeHash,
  sortCommentsChronological,
  classifyRole,
  isBlacklistedTs,
  isRelativeTimestamp,
  parseTimestamp,
  extractSummary,
  synthesizeDescriptionComment,
  hasDescriptionComment,
  assignIds,
} from './scrape_case.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = join(__dirname, 'render_case.mjs');
const DATA_CASES_DIR = join(__dirname, '../../../../data/cases');

export { classifyRole, isBlacklistedTs, isRelativeTimestamp, extractSummary, synthesizeDescriptionComment, hasDescriptionComment };

export function sanitizeComment(comment, referenceDate = new Date()) {
  if (!comment || typeof comment !== 'object') return comment;

  const rawTs = comment.timestamp || '';
  let timestamp = isBlacklistedTs(rawTs) ? '' : rawTs;
  let rawTimestamp = comment.rawTimestamp;

  if (timestamp && isRelativeTimestamp(timestamp)) {
    const epoch = parseTimestamp(timestamp, referenceDate);
    if (epoch > 0) {
      rawTimestamp = rawTimestamp || timestamp;
      timestamp = new Date(epoch).toISOString();
    }
  }

  const body = comment.body || '';
  // Always recomputed from body, never preserved: extractSummary is the
  // single owner of preview generation (see scrape_case.mjs), so a stale or
  // garbage cached preview (from before a fix landed there) gets repaired
  // on every migrate run rather than surviving because it happened to be
  // non-empty.
  const summary = extractSummary(body);

  const sanitized = {
    ...comment,
    timestamp,
    ...(rawTimestamp ? { rawTimestamp } : {}),
    summary,
  };

  delete sanitized.analysisLog;

  return sanitized;
}

export function stripFieldAffordances(s, label = '') {
  if (!s || typeof s !== 'string') return s;
  let val = s.trim();
  // 1. Trailing "Preview" affordance
  val = val.replace(/\s+Preview\s*$/, '').trim();
  // 2. Trailing inline-edit affordance: e.g. "\nEdit Status", " Edit Priority", "Edit Case Status"
  val = val.replace(/(?:\r?\n|\s+)Edit\s+[A-Za-z0-9_\-\s]+$/i, '').trim();
  // 3. Help tooltip text (e.g. "Help Related CRs", "Help Case Record Type")
  if (/^Help\s+/i.test(val)) {
    const target = val.replace(/^Help\s+/i, '').trim().toLowerCase();
    const lbl = (label || '').trim().toLowerCase();
    if (lbl && (target === lbl || target.includes(lbl) || lbl.includes(target))) {
      return '';
    }
    if (target === 'related crs' || target === 'related cr' || target === 'status' || target === 'priority' || target === 'case record type') {
      return '';
    }
  }
  return val;
}

export function migrateCaseData(caseData, options = {}) {
  if (!caseData || typeof caseData !== 'object') return caseData;

  const refDate = options.referenceDate
    ? (options.referenceDate instanceof Date ? options.referenceDate : new Date(options.referenceDate))
    : (caseData.extractedAt ? new Date(caseData.extractedAt) : (caseData.syncedAt ? new Date(caseData.syncedAt) : new Date()));

  let comments = Array.isArray(caseData.comments) ? [...caseData.comments] : [];

  // Check and inject description comment if non-empty and missing from comments
  const desc = typeof caseData.description === 'string' ? caseData.description.trim() : '';
  if (desc && !hasDescriptionComment(comments, desc)) {
    const descComment = synthesizeDescriptionComment({
      description: caseData.description,
      contactName: caseData.contactName || caseData.customer || caseData.accountName,
      openedAt: caseData.openedAt || caseData.created,
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
    const sanitized = sanitizeComment(c, refDate);
    return {
      ...sanitized,
      role: classifyRole(sanitized.author, sanitized.company, '', sanitized.body),
    };
  });

  // 3. Clean metadata field affordances (e.g. "Closed-Customer Requested\nEdit Status" -> "Closed-Customer Requested")
  const cleanFields = {};
  const fieldKeys = [
    ['status', 'Status'],
    ['priority', 'Priority'],
    ['severity', 'Severity'],
    ['product', 'Product'],
    ['component', 'Component'],
    ['contactName', 'Contact Name'],
    ['customerProject', 'Customer Project'],
    ['customer', 'Customer'],
    ['accountName', 'Account Name'],
    ['caseRecordType', 'Case Record Type'],
    ['relatedCRs', 'Related CRs'],
  ];
  for (const [k, lbl] of fieldKeys) {
    if (typeof caseData[k] === 'string') {
      cleanFields[k] = stripFieldAffordances(caseData[k], lbl);
    }
  }

  // 4. Re-sort chronologically with relative interpolation
  const sortedComments = sortCommentsChronological(sanitizedComments, refDate);

  // 5. Form updated case object
  const updatedCase = {
    ...caseData,
    ...cleanFields,
    comments: sortedComments,
  };

  // 6. Re-calculate hash
  updatedCase.hash = computeHash(updatedCase);

  return updatedCase;
}

/**
 * Detects comment bodies that were flattened at capture time (no internal line breaks
 * despite containing multi-sentence text or log sequences).
 * Such bodies cannot be repaired by re-rendering and require delete + re-capture.
 */
export function detectFlattenedBodies(caseData) {
  const comments = Array.isArray(caseData?.comments) ? caseData.comments : [];
  const flattened = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    if (!c || typeof c.body !== 'string') continue;
    const body = c.body.trim();
    if (!body.includes('\n') && (
      body.length > 200 ||
      /\d{2}:\d{2}:\d{2}/.test(body) ||
      /\b(?:steps|pre-config|1\.|2\.)\b/i.test(body) ||
      /(?:dear|hi|hello)\b.*?(?:thanks|regards|sincerely)\b/is.test(body)
    )) {
      flattened.push({
        index: i,
        id: c.id,
        author: c.author,
        preview: body.slice(0, 80),
      });
    }
  }
  return flattened;
}

export function migrateCaseJson(jsonPath, options = {}) {
  if (!existsSync(jsonPath)) {
    throw new Error(`File not found: ${jsonPath}`);
  }
  const raw = readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  const oldHash = data.hash;

  const updatedCase = migrateCaseData(data, options);
  const rehashed = oldHash !== updatedCase.hash;

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

  const flattenedBodies = detectFlattenedBodies(updatedCase);

  return {
    ok: true,
    jsonPath,
    caseNumber: caseCode,
    commentCount: updatedCase.comments.length,
    hash: updatedCase.hash,
    oldHash,
    rehashed,
    flattenedBodies,
    hasFlattenedBodies: flattenedBodies.length > 0,
    remedy: flattenedBodies.length > 0 ? 'delete-and-re-Capture' : undefined,
  };
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
      const rehashMsg = res.rehashed ? ` (re-hashed from ${res.oldHash})` : '';
      console.log(`Migrated ${res.caseNumber || res.jsonPath}: ${res.commentCount} comments, hash=${res.hash}${rehashMsg}`);
      if (res.hasFlattenedBodies) {
        console.log(`  [Notice] ${res.caseNumber}: Contains ${res.flattenedBodies.length} flattened comment body(ies). Remedy: delete-and-re-Capture.`);
      }
    } catch (e) {
      console.error(`Error migrating ${t}: ${e.message}`);
      process.exit(1);
    }
  }
}
