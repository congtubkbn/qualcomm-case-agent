---
name: qualcomm-case-agent
description: "Capture or sync Qualcomm support cases by 8-digit case code (e.g. 08460319, CASE-08460319), 'qualcomm case', or 'pull/sync case'."
allowed-tools: Bash(node:*), Bash(npm:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Retrieve complete case records from Qualcomm Support (support.qualcomm.com), preserve verbatim threaded comments, and maintain cached `case.json` and `case.md` artifacts under `data/cases/<CODE>/`.

---

## Execution Flow

### Step 1 — Input Sanitization
Extract and sanitize the 8-digit numeric case code from user input (strip optional `CASE-` prefix).
- If valid code found: Proceed immediately to Step 2.
- If invalid or missing: Prompt user for an 8-digit case code, then stop.

*Completion Criterion:* Exactly one 8-digit numeric case code is identified.

### Step 2 — Run Capture Pipeline
Execute the deterministic capture CLI:
```bash
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
```
*(Append `--mode full` or `--mode update` only when explicitly specified).*

*Completion Criterion:* Command completes and prints a single JSON verdict line on `stdout`.

### Step 3 — Branch on JSON Verdict
Parse the `stdout` JSON verdict line and branch on `status`:

| `status` | Exit | Meaning | Next Action |
|---|---|---|---|
| `created` | 0 | New case captured | Proceed to Step 4 |
| `updated` | 0 | New comments merged | Proceed to Step 4 |
| `no-update` | 0 | Unchanged since last sync | Report unchanged status, stop |
| `otp-timeout` | 2 | OTP window elapsed | Load `references/login-flow.md`, instruct OTP entry |
| `auth-required` | 3 | SSO session expired | Load `references/login-flow.md`, instruct login |
| `not-found` | 4 | Case unviewable / missing | Report missing/unauthorized case to user, stop |
| `blocked` | 5 | Extraction stuck | Retry once if `retryable: true`; else load `references/manual-flow.md` |
| `busy` | 6 | Lock held by another process | Wait 30s, retry once; else load `references/manual-flow.md` |
| `port-conflict` | 7 | CDP port 9773 occupied | Load `references/manual-flow.md` (`recover_chrome.ps1`) |
| `error` | 1 | Credential/execution failure | Fix per `reason` in verdict line, retry once |

*Completion Criterion:* Action for verdict `status` is selected and initiated.

### Step 4 — Render Capture Report
Synthesize summary directly from the stdout JSON verdict payload fields (`caseNumber`, `title`, `caseStatus`, `commentCount`, `newComments`, `caseJsonPath`, `caseMdPath`):
1. **Header**: Case number, title, case status.
2. **Comment Stats**: Total comment count (and new comment count if update).
3. **Artifacts**: Direct file links:
   - [`case.json`](file:///e:/the.thoi/Project/access-qualcomm/data/cases/<CODE>/case.json)
   - [`case.md`](file:///e:/the.thoi/Project/access-qualcomm/data/cases/<CODE>/case.md)

*Completion Criterion:* Final summary displayed to user with payload metadata and artifact links without reading disk files.

---

## Disclosed References

Load reference documents on demand when specific verdict triggers occur:

- [`references/login-flow.md`](references/login-flow.md): Reached on `auth-required` (exit 3) or `otp-timeout` (exit 2). Guides SSO sign-in and OTP input.
- [`references/manual-flow.md`](references/manual-flow.md): Reached on `blocked` (exit 5), `busy` (exit 6), or `port-conflict` (exit 7). Provides manual recovery procedures.
- [`references/consumer-guide.md`](references/consumer-guide.md): Reached when downstream agents require schema specifications or NDA boundaries for `case.json`.
- [`references/extraction.md`](references/extraction.md): Reached when diagnosing DOM selector failures or Chatter feed expansion issues.
- [`references/workflow.md`](references/workflow.md): Reached when reviewing state machines, CDP session lifecycles, or file lock models.

---

## Operational Principles

- **Tight fast-path**: Execute `run_case.mjs` directly; consult reference files only when triggered by non-zero verdicts.
- **Verdict payload reliance**: Rely on the `stdout` verdict JSON line for metadata; disk reads of `case.json` during reporting are redundant.
- **Verbatim preservation**: Keep comment bodies, timestamps, authors, and attachment links intact.
- **NDA compliance**: Restrict all artifacts and debug logs to local workspace `data/` directory.
