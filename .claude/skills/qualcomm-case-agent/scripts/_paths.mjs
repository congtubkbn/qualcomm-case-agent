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

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
export const SKILL_ROOT = resolve(here, '..');        // qualcomm-case-agent/

function findProjectRoot(start) {
  let d = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(d, '.git')) || existsSync(join(d, 'data', 'cases'))) return d;
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
