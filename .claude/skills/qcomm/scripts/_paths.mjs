// _paths.mjs - single source of truth for skill paths (Node / ESM).
//
// Import it in every .mjs in this folder:
//     import { SKILL_ROOT, PROJECT_ROOT, DATA_DIR } from './_paths.mjs';
//
// Mirrors _paths.ps1. Design goals (so the skill keeps working when copied to
// ANY workspace/machine):
//   - CWD-independent: paths derive from import.meta.url (THIS file), never cwd().
//   - Nesting-depth-independent: PROJECT_ROOT is found by WALKING UP to a marker
//     (.git or an existing data/cases), not by counting a fixed number of '..'.
//   - Escape hatch: env QUALCOMM_ROOT pins the project root for odd layouts.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
export const SKILL_ROOT = resolve(here, '..');        // qcomm/

// A real checkout has `.git` as a DIRECTORY. A git *worktree* has `.git` as a
// FILE (a `gitdir: <path>/.git/worktrees/<name>` pointer). Worktrees do NOT
// share a working directory with the main checkout, so their own `data/`
// starts out empty — no secrets, no chrome-profile, no case cache. Resolve
// the pointer straight back to the main repo root so every worktree shares
// ONE `data/` tree with the checkout it belongs to (confirmed bug: without
// this, a worktree silently forks its own cache — a fully captured real case
// ended up stranded in a worktree-local data/cases/, invisible to the main
// project and any other worktree).
function resolveWorktreeMainRoot(d) {
  const p = join(d, '.git');
  if (!existsSync(p) || statSync(p).isDirectory()) return null;
  const m = readFileSync(p, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const gitdir = m[1].replace(/\\/g, '/');
  const i = gitdir.indexOf('/worktrees/');
  if (i === -1) return null;
  return dirname(gitdir.slice(0, i)); // .../.git -> main repo root
}

function isGitRepoDir(d) {
  const p = join(d, '.git');
  return existsSync(p) && statSync(p).isDirectory();
}

function findProjectRoot(start) {
  let d = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const mainRoot = resolveWorktreeMainRoot(d);
    if (mainRoot) return mainRoot;
    if (isGitRepoDir(d) || existsSync(join(d, 'data', 'cases'))) return d;
    const parent = dirname(d);
    if (parent === d) return null; // filesystem root
    d = parent;
  }
}

export const PROJECT_ROOT =
  process.env.QUALCOMM_ROOT || findProjectRoot(SKILL_ROOT) || process.cwd();

export const DATA_DIR = join(PROJECT_ROOT, 'data', 'cases');
export const SECRET_PATH =
  process.env.QUALCOMM_SECRET || join(PROJECT_ROOT, 'data', '.secrets', 'qid.bin');
export const PROFILE_DIR = join(PROJECT_ROOT, 'data', 'chrome-profile');
export const USER_PATH = join(PROJECT_ROOT, 'data', '.secrets', 'qid.user');

// Resolve username
let resolvedUser = process.env.QUALCOMM_USER || null;
if (!resolvedUser && existsSync(USER_PATH)) {
  try {
    resolvedUser = readFileSync(USER_PATH, 'utf8').trim();
  } catch {}
}
export const QUALCOMM_USER = resolvedUser;
