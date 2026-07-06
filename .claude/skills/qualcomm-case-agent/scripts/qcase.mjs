#!/usr/bin/env node
// qcase — single entry point for the Qualcomm Case Management Agent scripts.
//
// Installed globally (`npm link` / `npm i -g` from this folder) it puts a `qcase`
// command on PATH, so SKILL.md calls short verbs (`qcase intake 08460319`) instead
// of long literal paths (`node ".claude/skills/qualcomm-case-agent/scripts/intake.mjs"`).
//
// This is a THIN dispatcher: each verb simply runs the SAME underlying script the
// skill has always used, with stdio inherited and the child's exit code forwarded.
// Nothing about extraction / hashing / rendering behaviour changes — the heavy
// logic still lives in intake.mjs / scrape_case.mjs / render_case.mjs, which each
// have their own `process.argv` entry point. Spawning them (rather than importing)
// keeps output, exit codes and the deterministic hash byte-identical.
//
// Two of the underlying scripts are NOT Node programs — readiness.js and
// extract_case.js run INSIDE the browser via `agent-browser eval`. They cannot be
// "called" here; `qcase script <name>` just prints their source to stdout so the
// skill can pipe it:  `qcase script readiness | agent-browser eval --stdin`.
//
// Usage:
//   qcase intake <CODE>
//   qcase scrape <CODE> <rawJsonPath> [--merge] [--title "..." --status "..." --priority "..."]
//   qcase render <path-to-case.json>
//   qcase script <readiness|extract>
//   qcase chrome            # launch/attach real Chrome on CDP 9222 (connect_chrome.ps1)
//   qcase login             # Okta identifier-first login (okta_login.ps1)
//   qcase capture-pw        # one-time DPAPI password capture (capture_password.ps1, interactive)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const p = name => join(HERE, name);

const [verb, ...args] = process.argv.slice(2);

function runNode(script, forward) {
  // Inherit stdio so stdout (the JSON verdict / rendered paths) and stderr reach
  // the caller unchanged; forward the exact exit code the underlying script sets.
  const r = spawnSync(process.execPath, [p(script), ...forward], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

function runPwsh(script, forward) {
  const r = spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', p(script), ...forward],
    { stdio: 'inherit' }
  );
  process.exit(r.status == null ? 1 : r.status);
}

function emitScript(which) {
  const file = { readiness: 'readiness.js', extract: 'extract_case.js' }[which];
  if (!file) {
    process.stderr.write(`qcase script: unknown script "${which}" (want: readiness | extract)\n`);
    process.exit(2);
  }
  const path = p(file);
  if (!existsSync(path)) {
    process.stderr.write(`qcase script: missing ${file}\n`);
    process.exit(2);
  }
  // Raw source to stdout, no trailing manipulation — it is piped verbatim into
  // `agent-browser eval --stdin`, which runs it as a browser expression.
  process.stdout.write(readFileSync(path, 'utf8'));
  process.exit(0);
}

function usage(code) {
  process.stderr.write(
    'qcase <command>\n' +
    '  intake <CODE>\n' +
    '  scrape <CODE> <rawJsonPath> [--merge] [--title .. --status .. --priority ..]\n' +
    '  render <case.json>\n' +
    '  script <readiness|extract>\n' +
    '  chrome | login | capture-pw\n'
  );
  process.exit(code);
}

switch (verb) {
  case 'intake':     runNode('intake.mjs', args); break;
  case 'scrape':     runNode('scrape_case.mjs', args); break;
  case 'render':     runNode('render_case.mjs', args); break;
  case 'script':     emitScript(args[0]); break;
  case 'chrome':     runPwsh('connect_chrome.ps1', args); break;
  case 'login':      runPwsh('okta_login.ps1', args); break;
  case 'capture-pw': runPwsh('capture_password.ps1', args); break;
  case '-h':
  case '--help':
  case undefined:    usage(0); break;
  default:
    process.stderr.write(`qcase: unknown command "${verb}"\n`);
    usage(2);
}
