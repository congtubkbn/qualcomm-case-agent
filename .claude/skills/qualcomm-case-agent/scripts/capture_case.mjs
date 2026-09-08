// capture_case.mjs - captureCase(code): spawns run_case.mjs as a subprocess and
// parses its one-line JSON verdict.
//
// Owned here (not by qualcomm-case-summary) because it wraps run_case.mjs, which this
// skill owns. qualcomm-case-summary's run_summary.mjs imports it from here so the
// Watch Run and the summary skill share one seam instead of growing a second one.

import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RUN_CASE_MJS = fileURLToPath(new URL('./run_case.mjs', import.meta.url));

export async function captureCase(code) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [RUN_CASE_MJS, code]));
  } catch (e) {
    if (typeof e.stdout !== 'string' || !e.stdout.trim()) {
      throw new Error(`qualcomm-case-agent capture failed to run: ${e.message}`);
    }
    stdout = e.stdout;
  }
  const line = stdout.trim().split('\n').pop();
  return JSON.parse(line);
}
