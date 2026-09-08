#!/usr/bin/env node
// tools/regen_case_markdown.mjs
//
// Redraws case.md from case.json for every case directory under cwd.
//
// Run by data/cases/.git/hooks/post-merge (installed by
// scripts/ensure_merge_driver.mjs): case.json is unioned by the custom merge
// driver (tools/merge_case_json.mjs), but case.md is attributed `merge=ours`
// (data/cases/.gitattributes) — it is never textually merged, so whatever a
// merge left it holding is stale and must be regenerated from the case.json
// the merge just resolved, not trusted as-is.
//
// Idempotent: regenerating from an unchanged case.json reproduces the same
// bytes, so a case untouched by the merge stays clean in `git status`.

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCase } from '../.claude/skills/qualcomm-case-agent/scripts/render_case.mjs';

export function regenAllCaseMarkdown(root = process.cwd()) {
  const rendered = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const jsonPath = join(dir, 'case.json');
    if (existsSync(jsonPath)) rendered.push(renderCase(jsonPath));
  }
  return rendered;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  regenAllCaseMarkdown();
}
