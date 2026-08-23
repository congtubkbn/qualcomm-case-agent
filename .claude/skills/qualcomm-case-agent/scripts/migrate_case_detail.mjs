#!/usr/bin/env node
// .claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs — Upgrade and migrate cached
// cases with Salesforce Detail tab metadata, re-render case.md with Detail fields, and update
// case index/overview.
//
// Usage:
//   node .claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs [path-to-case.json | caseCode | all] [options]
//
// Options:
//   --contactName "Name"
//   --customerProject "Project"
//   --openedAt "Timestamp"
//   --closedAt "Timestamp"
//   --accountName "Account"
//   --relatedCRs "CR1, CR2"
//   --caseRecordType "Record Type"
//   --raisedBy "Opener"
//   --description "Description"
//   --status "Status"
//   --priority "Priority"

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeHash,
  DETAIL_KEYS,
  HEADER_KEYS,
  synthesizeDescriptionComment,
  hasDescriptionComment,
  assignIds,
} from './scrape_case.mjs';
import { extractProductFromTitle } from '../../qualcomm-case-overview/scripts/cases_overview.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = join(__dirname, 'render_case.mjs');
const OVERVIEW_SCRIPT = join(__dirname, '../../qualcomm-case-overview/scripts/cases_overview.mjs');
const DATA_CASES_DIR = join(__dirname, '../../../../data/cases');

export const SUPPORTED_DETAIL_FLAGS = [
  ...DETAIL_KEYS,
  ...HEADER_KEYS,
  'description',
];

/**
 * Parses supported CLI flags from argv into an overrides object.
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseDetailFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (SUPPORTED_DETAIL_FLAGS.includes(key) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i];
      }
    }
  }
  return flags;
}

/**
 * Normalizes and upgrades case data with Salesforce Detail metadata.
 * @param {object} caseData
 * @param {object} [overrides={}]
 * @returns {object}
 */
export function migrateCaseDetailData(caseData, overrides = {}) {
  if (!caseData || typeof caseData !== 'object') return caseData;

  const rawComments = Array.isArray(caseData.comments) ? [...caseData.comments] : [];
  const firstAuthor = rawComments.length > 0 && rawComments[0].author ? rawComments[0].author : '';

  // Extract / infer detail fields
  const contactName =
    overrides.contactName !== undefined
      ? overrides.contactName
      : (typeof caseData.contactName === 'string' && caseData.contactName.trim()
          ? caseData.contactName.trim()
          : firstAuthor);

  const raisedBy =
    overrides.raisedBy !== undefined
      ? overrides.raisedBy
      : (typeof caseData.raisedBy === 'string' && caseData.raisedBy.trim()
          ? caseData.raisedBy.trim()
          : (contactName || firstAuthor));

  const customerProject =
    overrides.customerProject !== undefined
      ? overrides.customerProject
      : (typeof caseData.customerProject === 'string' && caseData.customerProject.trim()
          ? caseData.customerProject.trim()
          : extractProductFromTitle(caseData.title || ''));

  const accountName =
    overrides.accountName !== undefined
      ? overrides.accountName
      : (typeof caseData.accountName === 'string' && caseData.accountName.trim()
          ? caseData.accountName.trim()
          : (typeof caseData.customer === 'string' ? caseData.customer.trim() : ''));

  const openedAt =
    overrides.openedAt !== undefined
      ? overrides.openedAt
      : (typeof caseData.openedAt === 'string' && caseData.openedAt.trim()
          ? caseData.openedAt.trim()
          : (typeof caseData.created === 'string' ? caseData.created.trim() : ''));

  const closedAt =
    overrides.closedAt !== undefined
      ? overrides.closedAt
      : (typeof caseData.closedAt === 'string' ? caseData.closedAt.trim() : '');

  const relatedCRs =
    overrides.relatedCRs !== undefined
      ? overrides.relatedCRs
      : (typeof caseData.relatedCRs === 'string' ? caseData.relatedCRs.trim() : '');

  const caseRecordType =
    overrides.caseRecordType !== undefined
      ? overrides.caseRecordType
      : (typeof caseData.caseRecordType === 'string' ? caseData.caseRecordType.trim() : '');

  const description =
    overrides.description !== undefined
      ? overrides.description
      : (typeof caseData.description === 'string' ? caseData.description.trim() : '');

  const status = overrides.status !== undefined ? overrides.status : (caseData.status || '');
  const priority = overrides.priority !== undefined ? overrides.priority : (caseData.priority || '');
  const severity = overrides.severity !== undefined ? overrides.severity : (caseData.severity || '');
  const product = overrides.product !== undefined ? overrides.product : (caseData.product || '');
  const customer = overrides.customer !== undefined ? overrides.customer : (caseData.customer || '');

  let comments = rawComments;
  if (description && !hasDescriptionComment(comments, description)) {
    const descComment = synthesizeDescriptionComment({
      description,
      customer: accountName || customer,
      created: openedAt,
      contactName,
      openedAt,
    });
    if (descComment) {
      comments.push(descComment);
      const { comments: idComments } = assignIds(comments);
      comments = idComments;
    }
  }

  const updatedCase = {
    ...caseData,
    status,
    priority,
    severity,
    product,
    customer,
    contactName,
    raisedBy,
    customerProject,
    accountName,
    openedAt,
    closedAt,
    relatedCRs,
    caseRecordType,
    description,
    comments,
  };

  updatedCase.hash = computeHash(updatedCase);

  return updatedCase;
}

/**
 * Migrates a case.json file, re-renders case.md and updates _index.json.
 * @param {string} jsonPath
 * @param {object} [overrides={}]
 * @param {object} [options={}]
 * @returns {{ ok: boolean, jsonPath: string, caseNumber: string, hash: string }}
 */
export function migrateCaseDetailJson(jsonPath, overrides = {}, options = {}) {
  if (!existsSync(jsonPath)) {
    throw new Error(`File not found: ${jsonPath}`);
  }
  const raw = readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);

  const updatedCase = migrateCaseDetailData(data, overrides);

  // Write back to json
  writeFileSync(jsonPath, JSON.stringify(updatedCase, null, 2), 'utf8');

  // Re-render case.md
  if (existsSync(RENDER_SCRIPT)) {
    spawnSync(process.execPath, [RENDER_SCRIPT, jsonPath], { encoding: 'utf8' });
  }

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

  return {
    ok: true,
    jsonPath,
    caseNumber: caseCode,
    contactName: updatedCase.contactName,
    customerProject: updatedCase.customerProject,
    hash: updatedCase.hash,
  };
}

export const migrateCaseDetail = migrateCaseDetailJson;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const targetArg = args.find(a => !a.startsWith('--'));
  const flags = parseDetailFlags(args);

  const targets = [];
  // Only a bare code / "all" resolves into the real DATA_CASES_DIR; an
  // explicit path (a test fixture, a one-off file elsewhere) must not
  // trigger the real-overview refresh below.
  let usingRealDataDir = false;
  if (!targetArg || targetArg === 'all') {
    usingRealDataDir = true;
    if (existsSync(DATA_CASES_DIR)) {
      for (const entry of readdirSync(DATA_CASES_DIR)) {
        const full = join(DATA_CASES_DIR, entry, 'case.json');
        if (existsSync(full)) targets.push(full);
      }
    }
  } else if (/^\d{8}$/.test(targetArg)) {
    usingRealDataDir = true;
    targets.push(join(DATA_CASES_DIR, targetArg, 'case.json'));
  } else {
    targets.push(resolve(targetArg));
  }

  if (targets.length === 0) {
    console.error('No case.json targets found.');
    process.exit(1);
  }

  for (const t of targets) {
    try {
      const res = migrateCaseDetailJson(t, flags);
      console.log(
        `Migrated Detail for ${res.caseNumber || res.jsonPath}: contactName="${res.contactName || ''}", project="${res.customerProject || ''}", hash=${res.hash}`
      );
    } catch (e) {
      console.error(`Error migrating Detail for ${t}: ${e.message}`);
      process.exit(1);
    }
  }

  // Refresh overview if present — only when we actually operated on the real
  // DATA_CASES_DIR (bare code / "all"); an explicit out-of-tree path must not
  // touch the real _overview.json/dashboard.html.
  if (usingRealDataDir && existsSync(OVERVIEW_SCRIPT)) {
    try {
      spawnSync(process.execPath, [OVERVIEW_SCRIPT], { encoding: 'utf8' });
      console.log('Refreshed case overview and dashboard.');
    } catch {
      // ignore
    }
  }
}
