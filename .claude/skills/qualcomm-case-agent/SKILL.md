---
name: qualcomm-case-agent
description: "Capture or sync live Qualcomm support cases by 8-digit code from portal. Trigger on 'capture case <CODE>', 'fetch case <CODE>', 'sync case <CODE>'."
---

# Qualcomm Case Management Agent

Live portal capture and sync pipeline saving cases to local storage (`data/cases/<CODE>/`).

## Execution Flow

### Step 1 — Input Normalization
Extract the 8-digit case code from input (strip optional `CASE-` prefix).
- Missing or non-8-digit code: Ask user for the 8-digit case code, then stop.

*Completion Criterion:* Exactly one 8-digit numeric code is bound, or clarification requested and execution stopped.

### Step 2 — Run Capture Pipeline
Run the capture CLI:
```bash
node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs <CODE>
```
*(Alternative from repo root: `npm run case -- <CODE>`. Append `--mode full` or `--mode update` only when explicitly requested by user).*

*Completion Criterion:* Process exits with a valid single-line JSON verdict on stdout.

### Step 3 — Dispatch on Verdict
Parse `status` from the JSON verdict and branch:

| `status` | Condition | Action |
|---|---|---|
| `created` | New case captured | Proceed to Step 4 |
| `updated` | New comments merged | Proceed to Step 4 |
| `no-update` | Already current | Report case is up to date, then stop |
| `otp-timeout` | OTP window expired | Load [`references/login-flow.md`](references/login-flow.md), guide user OTP input |
| `auth-required` | Session expired | Load [`references/login-flow.md`](references/login-flow.md), guide user login |
| `not-found` | Missing / unauthorized | Report case not found or unauthorized, then stop |
| `blocked` | Extraction stalled | Retry once if `retryable: true`; else load [`references/manual-flow.md`](references/manual-flow.md) |
| `busy` | Locked by other task | Wait 30s, retry once; if still busy load [`references/manual-flow.md`](references/manual-flow.md) |
| `port-conflict` | CDP port 9773 busy | Run `recover_chrome.ps1` per [`references/manual-flow.md`](references/manual-flow.md) |
| `error` | Pipeline failure | Report `reason` from verdict; retry once if transient |

*Completion Criterion:* Exactly one branch executed: stopped with message, remediation initiated via reference doc, or proceed to Step 4.

### Step 4 — Render Capture Report
Format report using fields from the stdout JSON verdict (`code`, `title`, `status`, `commentCount`, `newComments`, `casePath`, `mdPath`):

- **Case**: `<CODE>` — *<title>* (`<status>`)
- **Comments**: `<commentCount>` total (`<newComments>` new)
- **Artifacts**:
  - [`data/cases/<CODE>/case.json`](file:///<normalized_casePath>)
  - [`data/cases/<CODE>/case.md`](file:///<normalized_mdPath>)

*(Note: Convert backslashes `\` in `casePath` and `mdPath` to forward slashes `/` to form valid clickable `file:///` URLs on any OS).*

*Completion Criterion:* Report rendered containing case metadata and clickable links derived directly from the verdict payload.
