#!/usr/bin/env node
// tools/merge_case_json.mjs
//
// Custom git merge driver for data/cases/**/case.json (issue #210, spec #205).
// Two machines that both captured the same case diverge as an unresolvable
// text conflict on a large JSON file — a human resolves it by picking a side
// and silently dropping the other side's comments. This driver replaces that
// with the union merge finalize_case.mjs already does for a single machine's
// cache vs. a fresh capture: same identity (comment id), same order guarantee,
// only ever grows the comment list.
//
// Registered per clone by scripts/ensure_merge_driver.mjs (run from postinstall).
// See data/cases/.gitattributes for the attribute mapping.
//
// The common ancestor (%O) is deliberately unused: a comment union does not
// need a base diff to be safe — it is commutative and associative regardless
// of which side is "ours" for this particular merge.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  mergeComments,
  orderCommentsForPresentation,
  computeHash,
  DETAIL_KEYS,
  HEADER_KEYS,
} from '../.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs';

const SCALAR_FILL_KEYS = ['description', 'product', 'updated', ...DETAIL_KEYS, ...HEADER_KEYS];

// Pure: text in, text out. Whichever side has the later extractedAt supplies
// the scalar fields (blanks filled from the other side, same rule finalize()
// uses); a tie breaks on a comparison of the two side's JSON text itself, not
// on which one happens to be "ours" — so merging (A, B) and (B, A) produce
// byte-identical output and two machines converge instead of diverging again
// on their next pull.
export function mergeCaseJson(oursText, theirsText) {
  const ours = JSON.parse(oursText);
  const theirs = JSON.parse(theirsText);

  const oursTime = Date.parse(ours.extractedAt || '') || 0;
  const theirsTime = Date.parse(theirs.extractedAt || '') || 0;
  let newer = ours;
  let older = theirs;
  if (theirsTime > oursTime) {
    newer = theirs;
    older = ours;
  } else if (theirsTime === oursTime) {
    [newer, older] = [ours, theirs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  const refDate = new Date(newer.extractedAt || Date.now());
  const { merged } = mergeComments(newer.comments || [], older.comments || [], refDate);

  const out = { ...newer, comments: merged };
  for (const k of SCALAR_FILL_KEYS) {
    if (!String(out[k] || '').trim() && String(older[k] || '').trim()) out[k] = older[k];
  }

  out.comments = orderCommentsForPresentation(out.comments);
  out.hash = computeHash(out);
  out.extractedAt = newer.extractedAt;

  return JSON.stringify(out, null, 2);
}

// ---- CLI: git merge driver protocol (`driver = "node merge_case_json.mjs %O %A %B"`) ----
// On success the result is written back into %A (git copies it into the real
// working-tree file and stages it). On failure, exit non-zero — a real
// conflict, left for a human, beats silently inventing a merged case.json.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const [, , , oursPath, theirsPath] = process.argv;
  if (!oursPath || !theirsPath) {
    console.error('usage: node merge_case_json.mjs <base> <ours> <theirs>  (git merge driver: %O %A %B)');
    process.exit(2);
  }
  try {
    const mergedText = mergeCaseJson(readFileSync(oursPath, 'utf8'), readFileSync(theirsPath, 'utf8'));
    writeFileSync(oursPath, mergedText, 'utf8');
    process.exit(0);
  } catch (e) {
    console.error(`merge_case_json: ${e.message}`);
    process.exit(1);
  }
}
