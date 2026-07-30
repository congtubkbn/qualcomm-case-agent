// web/cli_run.mjs — trigger the qualcomm-case-agent SKILL through an external
// agent CLI (claude/cline/gemini), for the dashboard's manual "Sync now"
// button.
//
// This is deliberately NOT scheduler.mjs's path: that one calls run_case.mjs
// directly for zero model tokens (the documented capture-is-code path, still
// used by the automatic background sweep — see web/server.mjs's --scheduler
// mode). This path exists because "Sync now" should reproduce exactly what
// the user gets typing "qualcomm case <CODE>" to their agent by hand —
// including going through a real agent process, at real per-run cost. Do not
// wire the automatic sweep to this path.
//
//     node cli_run.mjs <CODE>
//
// Config: data/agent-cli.json (git-ignored, machine-local — which CLIs are
// actually installed varies per desktop):
//   { "tool": "claude", "commands": { "claude": ["claude", "-p", "{prompt}", "--output-format", "json"] } }
// Auto-created with a claude-only default on first read, same pattern as
// scheduler.mjs's loadWatchlist(). Add a "cline"/"gemini" entry under
// "commands" and flip "tool" to switch — this script never guesses a CLI's
// invocation syntax; the array is your literal argv, no shell re-parsing.
//
// The agent is told to capture only and skip PHASE 3 (enrichment is out of
// scope here, and PHASE 3's "ask before a large analysis" gate has no one to
// answer it in headless mode). Status is never parsed from the agent's reply
// — instead this script re-reads data/cases/<CODE>/ before and after the CLI
// process exits and derives created/updated/no-update/error from what's
// actually on disk, the same source of truth /api/overview already reads.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, PROJECT_ROOT } from '../.claude/skills/qualcomm-case-agent/scripts/_paths.mjs';
import { RUNS_PATH, readJson, writeJson } from '../.claude/skills/qualcomm-case-agent/scripts/scheduler.mjs';

export const CONFIG_PATH = join(PROJECT_ROOT, 'data', 'agent-cli.json');
const DEFAULT_CONFIG = {
  tool: 'claude',
  commands: { claude: ['claude', '-p', '{prompt}', '--output-format', 'json'] },
};

export function loadCliConfig() {
  if (!existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) };
}

/** Substitute the {prompt} token into an argv template. Array-in, array-out —
 *  no string re-parsing, so no quoting ambiguity (same "argv array, nothing
 *  crosses a shell as text" rule browser.mjs follows for agent-browser). */
export function fillArgv(template, prompt) {
  return template.map(a => (a === '{prompt}' ? prompt : a));
}

function caseState(code) {
  const idx = readJson(join(DATA_DIR, '_index.json'), {});
  const casePath = join(DATA_DIR, code, 'case.json');
  const exists = existsSync(casePath);
  const commentCount = exists ? (readJson(casePath, {}).comments?.length ?? 0) : 0;
  return { syncedAt: idx[code]?.syncedAt || null, exists, commentCount };
}

/** Derive a verdict purely from disk state before/after the CLI ran — never
 *  from the agent's own reply text. */
export function classifyRun(before, after, cliFailed, reason) {
  if (cliFailed) return { status: 'error', reason: reason || 'agent CLI exited non-zero' };
  if (!before.exists && after.exists) return { status: 'created', newComments: after.commentCount };
  if (before.syncedAt !== after.syncedAt) {
    return { status: 'updated', newComments: Math.max(0, after.commentCount - before.commentCount) };
  }
  if (!before.exists && !after.exists) {
    return { status: 'error', reason: reason || 'agent CLI exited 0 but produced no case.json — capture likely never ran (check reason/output)' };
  }
  return { status: 'no-update' };
}

const WIN = process.platform === 'win32';
// Same guard as browser.mjs's winLine(): our argv is config-authored plus a
// digits-and-spaces prompt, which never legitimately needs a cmd.exe metachar.
const CMD_UNSAFE = /[&|<>^"%!]/;

function winLine(argv) {
  const bad = argv.find(a => CMD_UNSAFE.test(a));
  if (bad) throw new Error(`arg contains a cmd.exe metacharacter: ${String(bad).slice(0, 60)}`);
  return `"${argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}"`;
}

function runCli(argv) {
  return WIN
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', winLine(argv)], {
        encoding: 'utf8', timeout: 900000, windowsVerbatimArguments: true,
      })
    : spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 900000 });
}

function main(code) {
  const cfg = loadCliConfig();
  const template = cfg.commands[cfg.tool];
  if (!template) {
    const line = { code, status: 'error', reason: `no command configured for tool "${cfg.tool}" in data/agent-cli.json` };
    process.stdout.write(JSON.stringify(line) + '\n');
    process.exit(1);
    return;
  }

  const before = caseState(code);
  const prompt = `qualcomm case ${code} — capture only, skip PHASE 3 enrichment/analysis`;
  const r = runCli(fillArgv(template, prompt));
  const after = caseState(code);
  const failed = r.error != null || r.status !== 0;
  const output = (r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 300);
  const verdict = classifyRun(before, after, failed, output);

  const runs = readJson(RUNS_PATH, {});
  runs[code] = { lastRunAt: new Date().toISOString(), ...verdict };
  writeJson(RUNS_PATH, runs);

  process.stdout.write(JSON.stringify({ code, ...verdict }) + '\n');
  process.exit(verdict.status === 'error' ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = process.argv[2];
  if (!code) { console.error('usage: node cli_run.mjs <CODE>'); process.exit(2); }
  main(code);
}
