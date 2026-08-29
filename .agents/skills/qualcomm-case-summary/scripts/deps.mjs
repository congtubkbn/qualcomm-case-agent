// deps.mjs - the ONE effects boundary for qualcomm-case-summary.
// Everything that leaves the process goes through this module; the orchestrator
// (run_summary.mjs) imports nothing else for external effects. Summarization itself
// is not an effect here: this skill runs inside an agent (Claude Code, Cline, ...)
// that already has NDA-cleared access to the case data in this workspace, so the
// per-comment/case-flow summaries are produced by that agent between the `prepare`
// and `finalize` CLI steps (see SKILL.md), never by a script-initiated model call.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RUN_CASE_MJS = fileURLToPath(
  new URL('../../qualcomm-case-agent/scripts/run_case.mjs', import.meta.url),
);

// Invokes qualcomm-case-agent's capture pipeline for one case code and returns its
// parsed verdict object (the JSON line on stdout), regardless of exit code -- several
// non-zero exits (auth-required, not-found, blocked, busy) are expected verdicts, not
// invocation failures. Throws only if the subprocess can't be run or emits no verdict.
export async function captureCase(code) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [RUN_CASE_MJS, code]));
  } catch (e) {
    // execFile rejects on non-zero exit; run_case.mjs still writes its verdict to stdout.
    if (typeof e.stdout !== 'string' || !e.stdout.trim()) {
      throw new Error(`qualcomm-case-agent capture failed to run: ${e.message}`);
    }
    stdout = e.stdout;
  }
  const line = stdout.trim().split('\n').pop();
  return JSON.parse(line);
}
