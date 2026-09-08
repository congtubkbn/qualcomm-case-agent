#!/usr/bin/env node
// scripts/ensure_merge_driver.mjs
//
// Registers the case.json union merge driver (tools/merge_case_json.mjs) in
// data/cases's LOCAL git config, and installs its companion post-merge hook.
// Both are per-clone settings by construction: a merge driver's *command* is
// never recorded in .gitattributes (only its name is — see
// data/cases/.gitattributes), only the local git config maps that name to a
// command, same as tools/hooks/pre-commit needs `npm run docs:hook`'s
// `git config core.hooksPath` on every fresh clone. Unlike that hook, this one
// is not manual — it runs on every `npm install` (see package.json postinstall).
//
// A clone with no data/cases repository yet (a plain clone of this public
// tooling repo, with no private data repo cloned in) is a silent no-op, never
// a failure — postinstall must still succeed.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const DATA_CASES_DIR = join(PROJECT_ROOT, 'data', 'cases');
const MERGE_SCRIPT = join(PROJECT_ROOT, 'tools', 'merge_case_json.mjs');
const REGEN_SCRIPT = join(PROJECT_ROOT, 'tools', 'regen_case_markdown.mjs');

const toShellPath = p => String(p).replace(/\\/g, '/');

/**
 * @param {object} [options]
 * @param {string} [options.dataCasesDir]
 * @param {string} [options.mergeScript]
 * @param {string} [options.regenScript]
 * @param {boolean} [options.silent]
 * @returns {{ ok: boolean, skipped?: boolean, registered?: boolean, reason?: string, error?: string }}
 */
export function ensureMergeDriverRegistered(options = {}) {
  const dataDir = options.dataCasesDir || DATA_CASES_DIR;
  const silent = options.silent !== false;

  if (!existsSync(join(dataDir, '.git'))) {
    return { ok: true, skipped: true, reason: 'no-data-cases-repo' };
  }

  // Git runs merge.<name>.driver through a shell after substituting %O/%A/%B
  // with real temp-file paths — quote those too, not just the script path. An
  // unquoted space in a temp path (a data/cases clone under a profile like
  // `C:\Users\Win 11\`) would otherwise mis-tokenize the command.
  const driverCmd = `node "${toShellPath(options.mergeScript || MERGE_SCRIPT)}" "%O" "%A" "%B"`;
  const configs = [
    ['merge.case-json-union.driver', driverCmd],
    // `merge=ours` in .gitattributes needs this local config too — `ours` is a
    // whole-merge strategy, not a built-in per-file driver.
    ['merge.ours.driver', 'true'],
  ];
  for (const [key, value] of configs) {
    const res = spawnSync('git', ['-C', dataDir, 'config', key, value], { encoding: 'utf8' });
    if (res.status !== 0) {
      const error = (res.stderr || res.stdout || `git config ${key} failed`).trim();
      if (!silent) console.error(`[merge-driver] ${error}`);
      return { ok: false, error };
    }
  }

  const regenScript = toShellPath(options.regenScript || REGEN_SCRIPT);
  const hookPath = join(dataDir, '.git', 'hooks', 'post-merge');
  const hookBody = [
    '#!/bin/sh',
    '# Installed by scripts/ensure_merge_driver.mjs (npm postinstall) — do not edit by hand.',
    '# case.md is merge=ours during a merge (see data/cases/.gitattributes): it is',
    '# never textually merged, so it must be redrawn here from the case.json the',
    '# merge just resolved via the case-json-union driver.',
    `node "${regenScript}"`,
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(hookPath, hookBody, 'utf8');
  try { chmodSync(hookPath, 0o755); } catch { /* chmod is a no-op on Windows filesystems, harmless */ }

  if (!silent) console.log('[merge-driver] registered case-json-union merge driver + post-merge hook for data/cases');
  return { ok: true, skipped: false, registered: true };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const result = ensureMergeDriverRegistered({ silent: false });
  process.exit(result.ok ? 0 : 1);
}
