---
name: qualcomm-case-agent
description: "Capture complete Qualcomm support case from portal into structured cache (`data/cases/<CODE>/`). Triggers: Qualcomm case code (e.g. 08460319, CASE-08460319), 'qualcomm case', 'pull case', 'lấy case qualcomm'. Use when the user provides a Qualcomm case code and requests case capture or sync."
allowed-tools: Bash(node:*), Bash(npm:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Retrieve the complete case from the Qualcomm Support portal (support.qualcomm.com), preserve verbatim comments ordered newest-first with replies grouped under their parent, and produce structured `case.json` and `case.md` artifacts in local cache `data/cases/<CODE>/`.

## Execution Workflow

### Step 1 — Input Contract
- **Input:** Exactly one 8-digit case code (e.g. `08460319`). Strip leading `CASE-` prefix if present.
- If input is invalid: ask user for a valid 8-digit code, then STOP.
- A valid code proceeds directly to capture without confirmation.

### Step 2 — Run Capture
Execute the deterministic headless pipeline:
```bash
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
```
*(Optional flag: `--mode full` or `--mode update` to override automatic cache detection).*

### Step 3 — Branch on JSON Verdict
`run_case.mjs` outputs exactly one JSON verdict line on stdout. Branch strictly on `status`:

| `status` | Exit | Meaning | Action |
|----------|------|---------|--------|
| `created` | 0 | New case captured | Report case metadata & artifacts to user |
| `updated` | 0 | New comments merged (`newComments`, `newCommentIds`) | Report updated comments & artifacts to user |
| `no-update` | 0 | Unchanged since last sync | Report "no update", STOP |
| `otp-timeout` | 2 | Password accepted; OTP window elapsed | Instruct user to enter OTP in open Chrome window, then re-run command (`references/login-flow.md`) |
| `auth-required` | 3 | Okta SSO session lapsed | Complete sign-in in open Chrome window, then re-run command (`references/login-flow.md`) |
| `not-found` | 4 | Case does not exist or unviewable | Report case not found / permission limitation, STOP |
| `blocked` | 5 | Expansion / extraction stuck | Inspect `reason` in verdict; if `retryable: true`, retry once; otherwise follow `references/manual-flow.md` |
| `busy` | 6 | Capture lock held by another process | Wait 30s, retry once; if still busy, follow `references/manual-flow.md` Recovery 4 |
| `port-conflict` | 7 | CDP port 9773 held by non-project process | Follow `references/manual-flow.md` Recovery 5 (`recover_chrome.ps1`) |
| `error` | 1 | Unconfigured credentials or invocation error | Fix per `reason` (e.g. `npm run setup:credentials`), then retry |

> Non-zero exit codes are structured status signals. Always branch on the `status` field in the stdout JSON line, not the generic shell exit label.

### Step 4 — Report to User
Report:
- Case number, title, and status.
- Number of comments captured (and new comments added for updates).
- Artifact locations: `data/cases/<CODE>/case.json` and `data/cases/<CODE>/case.md`.
- Rely directly on the stdout JSON verdict line for metadata and paths without reading `case.json`.

---

## Disclosed References (Load on Demand)

- [`references/login-flow.md`](references/login-flow.md): Re-authentication workflows, Okta SSO, password autofill, and email OTP handling.
- [`references/manual-flow.md`](references/manual-flow.md): Runbook for resolving non-zero verdicts (`blocked`, `busy`, `port-conflict`).
- [`references/consumer-guide.md`](references/consumer-guide.md): Schema definition and consumption guidelines for downstream agents/skills.
- [`references/extraction.md`](references/extraction.md): Selector mappings and DOM extraction mechanics for maintainers.
- [`references/workflow.md`](references/workflow.md): Complete lifecycle, concurrency architecture, and end-to-end flowchart reference.

---

## Operational Guardrails

- **Fast-path first:** Let `run_case.mjs` handle capture autonomously; consult references only on non-zero verdicts.
- **Verbatim fidelity:** Comment bodies and logs are preserved verbatim without truncation.
- **Confidentiality:** Case data contains Qualcomm NDA material; keep artifacts inside `data/` and never expose to external endpoints.
- **Single case scope:** One case code per invocation.
- **URL discipline:** Real case URLs follow `/s/case/<SFID>/<slug>` resolved from search results.
