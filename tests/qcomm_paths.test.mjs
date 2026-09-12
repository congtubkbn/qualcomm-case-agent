// Unit tests for _paths.mjs's project-root resolution, and a regression guard that
// every consumer of "the cases directory" resolves through the same root as _paths.mjs
// (a worktree checkout must never fork its own data/cases — see _paths.mjs comment).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  DATA_DIR,
  findProjectRoot,
  PROFILE_DIR,
  PROJECT_ROOT,
  QUALCOMM_USER,
  SECRET_PATH,
  SKILL_ROOT,
  USER_PATH,
} from '../.claude/skills/qcomm/scripts/_paths.mjs';

const SCRIPTS = new URL('../.claude/skills/qcomm/scripts/', import.meta.url);
const PATHS_URL = new URL('_paths.mjs', SCRIPTS);
let seq = 0;
const importOverviewStore = () => import(new URL(`overview_store.mjs?t=${++seq}`, SCRIPTS));

describe('_paths: findProjectRoot', () => {
  it('resolves a real checkout (.git directory) to itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'qc-root-'));
    try {
      mkdirSync(join(root, '.git'));
      mkdirSync(join(root, 'sub', 'nested'), { recursive: true });
      assert.equal(findProjectRoot(join(root, 'sub', 'nested')), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a git worktree pointer back to the main repo root, not the worktree dir', () => {
    const main = mkdtempSync(join(tmpdir(), 'qc-main-'));
    let worktree;
    try {
      mkdirSync(join(main, '.git', 'worktrees', 'wt1'), { recursive: true });
      mkdirSync(join(main, 'data', 'cases'), { recursive: true });

      worktree = mkdtempSync(join(tmpdir(), 'qc-worktree-'));
      const gitdir = join(main, '.git', 'worktrees', 'wt1').replace(/\\/g, '/');
      writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
      mkdirSync(join(worktree, 'sub'), { recursive: true });

      // resolveWorktreeMainRoot normalizes the gitdir pointer to forward slashes
      // before deriving the root, so compare path text with separators normalized.
      const norm = (p) => p.replace(/\\/g, '/');
      assert.equal(norm(findProjectRoot(join(worktree, 'sub'))), norm(main));
    } finally {
      rmSync(main, { recursive: true, force: true });
      if (worktree) rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe('_paths: single source of truth for the cases directory', () => {
  it('overview_store.mjs delegates DEFAULT_CASES_DIR to _paths.mjs instead of resolving its own root', async (t) => {
    // Prove delegation, not coincidence: point _paths.mjs's DATA_DIR at a value only the
    // worktree-aware resolver could produce, and confirm overview_store.mjs follows it rather
    // than recomputing an independent (and possibly worktree-unaware) root of its own.
    const fakeDataDir = 'Z:\\fake-worktree-main-root\\data\\cases';
    t.mock.module(PATHS_URL, { exports: { DATA_DIR: fakeDataDir } });

    const { DEFAULT_CASES_DIR } = await importOverviewStore();
    assert.equal(DEFAULT_CASES_DIR, fakeDataDir);
  });
});

describe('_paths: --json CLI seam (consumed by _paths.ps1)', () => {
  it('prints the same resolved paths as the ESM exports, as one JSON line', () => {
    const r = spawnSync(process.execPath, [fileURLToPath(PATHS_URL), '--json'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);

    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed, {
      skillRoot: SKILL_ROOT,
      projectRoot: PROJECT_ROOT,
      dataDir: DATA_DIR,
      secretPath: SECRET_PATH,
      profileDir: PROFILE_DIR,
      userPath: USER_PATH,
      user: QUALCOMM_USER,
    });
  });

  it('does not print anything when imported normally (no --json flag)', async () => {
    const r = spawnSync(process.execPath, ['-e', `import('${PATHS_URL}')`], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  });
});
