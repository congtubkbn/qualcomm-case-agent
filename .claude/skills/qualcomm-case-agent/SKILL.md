---
name: qualcomm-case-agent
description: "Capture or sync Qualcomm support cases by 8-digit case number (or CASE- prefix)."
allowed-tools: Bash(node:*), Bash(npm:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

Deterministic pipeline to capture and sync Qualcomm support cases into local artifacts (`data/cases/<CODE>/`).

## Execution Flow

### Step 1 — Input Sanitization
Extract the 8-digit numeric case code from user input (strip optional `CASE-` prefix).
- Valid code: Proceed to Step 2.
- Missing / invalid code: Ask user for the 8-digit case code, then stop.

*Completion Criterion:* Exactly one 8-digit numeric case code is bound, or clarification requested and execution stopped.

### Step 2 — Run Capture Pipeline
Run the capture CLI:
```bash
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
```
*(Append `--mode full` or `--mode update` only when explicitly requested by user).*

*Completion Criterion:* Process terminates with stdout printing a single JSON verdict line.

### Step 3 — Branch on Verdict
Parse the JSON verdict line from `stdout` and take the corresponding action:

| `status` | Exit | Condition | Action |
|---|---|---|---|
| `created` | 0 | New case captured | Proceed to Step 4 |
| `updated` | 0 | New comments merged | Proceed to Step 4 |
| `no-update` | 0 | Already up to date | Report case is current to user, stop |
| `otp-timeout` | 2 | OTP window expired | Load [`references/login-flow.md`](references/login-flow.md), guide user OTP input |
| `auth-required` | 3 | SSO session expired | Load [`references/login-flow.md`](references/login-flow.md), guide user login |
| `not-found` | 4 | Case missing / unauthorized | Report case not found or inaccessible, stop |
| `blocked` | 5 | Extraction stalled | Retry once if `retryable: true`; else load [`references/manual-flow.md`](references/manual-flow.md) |
| `busy` | 6 | Code locked by another task | Wait 30s, retry once; if still busy load [`references/manual-flow.md`](references/manual-flow.md) |
| `port-conflict` | 7 | CDP port 9773 occupied | Run `recover_chrome.ps1` per [`references/manual-flow.md`](references/manual-flow.md) |
| `error` | 1 | Pipeline failure | Report failure `reason` from payload, retry once |

*Completion Criterion:* Exactly one branch executed: pipeline stopped, remediation initiated via reference doc, or proceed to Step 4.

### Step 4 — Render Capture Report
Format summary exclusively from the stdout JSON verdict fields (`caseNumber`, `title`, `caseStatus`, `commentCount`, `newComments`):

- **Case**: `<caseNumber>` — *<title>* (`<caseStatus>`)
- **Comments**: `<commentCount>` total (`<newComments>` new)
- **Artifacts**:
  - [`case.json`](file:///e:/the.thoi/Project/access-qualcomm/data/cases/<CODE>/case.json)
  - [`case.md`](file:///e:/the.thoi/Project/access-qualcomm/data/cases/<CODE>/case.md)

*Completion Criterion:* Summary rendered with metadata and clickable links to both files using only payload data.
