#!/usr/bin/env node
// .claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs
// Wrapper script providing direct access to the migration tool from the skill directory.
//
// Usage:
//   node .claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs [path-to-case.json | caseCode | all]

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export * from '../../../../tools/migrate_case.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = join(__dirname, '../../../../tools/migrate_case.mjs');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = spawnSync(process.execPath, [TOOL_PATH, ...process.argv.slice(2)], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  process.exit(res.status ?? 0);
}
