---
name: qualcomm-case-agent
description: "Capture or sync a Qualcomm support case on an 8-digit case code (e.g. 08460319, CASE-08460319), 'qualcomm case', or 'pull/sync case'."
allowed-tools: Bash(node:*), Bash(npm:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Retrieve the complete case from the Qualcomm Support portal (support.qualcomm.com), preserve verbatim comments ordered newest-first with replies grouped under their parent, and produce structured `case.json` and `case.md` artifacts in local cache `data/cases/<CODE>/`.

## Execution Workflow

### Step 1 — Input Contract
- **Input:** Exactly one 8-digit case code (e.g. `08460319`). Strip leading `CASE-` prefix if present.
- **Validation:** If input is missing or not an 8-digit code, request a valid 8-digit case code from the user, then STOP.
- **Completion Criterion:** Exactly one sanitized 8-digit numeric case code is identified. Proceed directly to Step 2 without asking for user confirmation.

### Step 2 — Run Capture
- **Action:** Execute the deterministic headless capture pipeline:
  ```bash
  node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
  ```
  *(Optional flag: `--mode full` or `--mode update` to override automatic cache detection).*
- **Completion Criterion:** The process finishes and outputs exactly one JSON verdict line on stdout. Proceed directly to Step 3.

### Step 3 — Branch on JSON Verdict
- **Action:** Parse the single stdout JSON verdict line and branch strictly on its `status` field per the authoritative table below:

| `status` | Exit | Meaning | Action |
|----------|------|---------|--------|
| `created` | 0 | New case captured | Report case metadata & artifacts to user (Step 4) |
| `updated` | 0 | New comments merged (`newComments`, `newCommentIds`) | Report updated comments & artifacts to user (Step 4) |
| `no-update` | 0 | Unchanged since last sync | Report unchanged status to user, STOP |
| `otp-timeout` | 2 | Password accepted; OTP window elapsed | Instruct user to enter OTP in open Chrome window, then re-run capture (`references/login-flow.md`) |
| `auth-required` | 3 | Okta SSO session lapsed | Instruct user to complete sign-in in open Chrome window, then re-run capture (`references/login-flow.md`) |
| `not-found` | 4 | Case does not exist or unviewable | Report case not found or access permission limitation to user, STOP |
| `blocked` | 5 | Expansion / extraction stuck | Inspect `reason` in verdict; if `retryable: true`, retry once; otherwise consult `references/manual-flow.md` (`blocked`) |
| `busy` | 6 | Capture lock held by another process | Wait 30s, retry once; if still busy, follow `references/manual-flow.md` (`busy`) |
| `port-conflict` | 7 | CDP port 9773 held by non-project process | Execute `references/manual-flow.md` (`port-conflict` / `recover_chrome.ps1`) |
| `error` | 1 | Unconfigured credentials or invocation error | Fix per `reason` (e.g. `npm run setup:credentials` or `references/manual-flow.md`), then retry |

> **Structured Signal Rule**: Non-zero exit codes are structured status signals. Always branch on the `status` field in the stdout JSON line, never on generic shell exit labels.

- **Completion Criterion:**
  - For exit 0 statuses (`created`, `updated`): Proceed directly to Step 4.
  - For exit 0 status (`no-update`): Render unchanged notification to user and stop execution.
  - For non-zero statuses: Execute the specific recovery action mapped above (retrying once if indicated, or prompting user action). Do not proceed to Step 4.

### Step 4 — Report to User
- **Action:** Synthesize the capture report using only the stdout JSON verdict payload fields (`caseNumber`, `title`, `caseStatus`, `commentCount`, `newComments`, `caseJsonPath`, `caseMdPath`):
  - Case number, title, and case status.
  - Total comments captured (including count of newly added comments on updates).
  - Artifact locations: `data/cases/<CODE>/case.json` and `data/cases/<CODE>/case.md`.
- **Redundant Reads Guardrail:** Rely directly on the stdout JSON verdict line for metadata and paths. Do not open or read `case.json` or `case.md`.
- **Completion Criterion:** Final summary displayed to user with case metadata, comment counts, and artifact paths.

---

## Disclosed References (Load on Demand)

Load reference documents only when specific trigger conditions are met:

- [`references/login-flow.md`](references/login-flow.md): Load on `auth-required` (exit 3) or `otp-timeout` (exit 2) to guide authentication, credential setup, and manual OTP flow.
- [`references/manual-flow.md`](references/manual-flow.md): Load on `blocked` (exit 5), `busy` (exit 6), or `port-conflict` (exit 7) to execute recovery runbooks.
- [`references/consumer-guide.md`](references/consumer-guide.md): Load when downstream agents or tools need data schemas, field types, or NDA boundaries for consuming `case.json`.
- [`references/extraction.md`](references/extraction.md): Load when diagnosing DOM selectors, Chatter feed expansion loops, or tab switching during extraction maintenance.
- [`references/workflow.md`](references/workflow.md): Load when reviewing architectural state machines, CDP session lifecycles, or lock concurrency models.

---

## Operational Guardrails

- **Fast-path first:** Let `run_case.mjs` handle capture autonomously; consult references only on non-zero verdicts.
- **Verbatim fidelity:** Preserve comment bodies, timestamps, authors, and attachments verbatim without truncation or redaction.
- **Confidentiality:** Keep all case artifacts and logs inside local `data/` directory to maintain Qualcomm NDA compliance.
- **Single case scope:** Process exactly one case code per command invocation.
- **Canonical URL resolution:** Resolve case URLs via portal global search matching `/s/case/<SFID>/<slug>`.
