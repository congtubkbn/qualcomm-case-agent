---
name: qualcomm-case-agent
description: "Qualcomm Case Extraction Agent. Given ONE Qualcomm case code, capture the COMPLETE case from the Qualcomm Support portal (support.qualcomm.com) — full metadata, case description, attachments, and all Chatter feed comments sorted strictly in chronological order (Oldest -> Newest) — with ONE headless command (`run_case.mjs`) that connects via native CDP over the persistent Chrome profile, expands the Chatter feed, extracts the DOM, and finalizes the cache into `case.json` and human-readable `case.md`. Incremental: unchanged cases report 'no update'. Triggers: 'qualcomm case <code>', 'pull qualcomm case', 'access qualcomm case', 'lấy case qualcomm', 'extract qualcomm case code'. Use whenever the user provides a Qualcomm case code/number and wants the full case captured."
allowed-tools: Bash(node:*), Bash(npm:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Qualcomm Case Extraction & Management Agent. Given one **case code**, retrieve the entire case from the Qualcomm Support portal (support.qualcomm.com), sort all Chatter feed comments in chronological order (Oldest -> Newest), and produce clean structured JSON and Markdown artifacts in the local project cache.

**Input contract.** One Qualcomm case code = **exactly 8 digits** (e.g. `08460319`). A leading `CASE-` prefix is accepted and stripped. Anything else → intake fails, ask user, STOP.

**A valid code goes straight to the portal.** No confirmation question, no "shall I update?" prompt — validate the 8 digits, then run the capture. The only thing that stops a run is a genuine blocker (lapsed Okta session, wrong code, portal not rendering), never a policy check.

**Deterministic execution.** Signing in, navigating to the search result, paginating the feed, expanding posts, sorting comments chronologically, and extracting the DOM are deterministic — `scripts/run_case.mjs` executes the entire pipeline in one headless command for zero model tokens.

**Harness-agnostic.** Works under Claude Code, Cline (VS Code), Antigravity, or any agent with terminal and file access.

---

## Configuration

All `data/...` paths resolve from the project root (found by `_paths.mjs`, not the CWD).
Scripts and references live under `.claude/skills/qualcomm-case-agent/`.

| Key | Value |
|-----|-------|
| Portal | `https://support.qualcomm.com` |
| SSO | `https://account.qualcomm.com/...` (Okta — identifier-first two-step) |
| Qualcomm ID | `the.thoi@samsung.com` |
| MFA | **Email OTP** — 6-digit code to Samsung mailbox, expires ~5 min. |
| Browser | **real Google Chrome** on CDP `9222` via `scripts/connect_chrome.ps1` |
| Session store | `data/chrome-profile/` — persistent `--user-data-dir`; git-ignored |
| Case cache | per-case folder `data/cases/<CODE>/`: `case.json` · `case.md` |
| Sync index | `data/cases/_index.json` |

**Scripts** (`scripts/`)

| Script | Role |
|--------|------|
| `run_case.mjs` | **the fast path** — whole pipeline orchestrator, one command, one JSON verdict line |
| `fast_landing.mjs` | fast CDP-native case search & direct landing engine |
| `cdp_client.mjs` | lightweight native Chrome DevTools Protocol WebSocket client |
| `intake.mjs` | validate code + prep cache dirs (also imported by `run_case.mjs`) |
| `browser.mjs` | browser/CDP runtime bridge |
| `readiness.js` · `expand_step.js` · `extract_case.js` | page scripts run inside browser DOM |
| `scrape_case.mjs` | finalizer — sort chronologically, assert, hash, write `case.json` + index (`--merge` = update run) |
| `check_collapsed.js` · `verify_case.mjs` | completeness gates — unexpanded-control read, post-capture QA (`verifyCase`) |
| `render_case.mjs` | `case.json` → clean human-readable `case.md` |
| `connect_chrome.ps1` · `recover_chrome.ps1` | browser + session helpers |

**References** (`references/`) — load ON DEMAND, not up front:
`manual-flow.md` (Troubleshooting & recovery scenarios) ·
`login-flow.md` (Okta SSO + Email OTP + Session Reuse) · `extraction.md` · `workflow.md` · `consumer-guide.md`

---

## Capture — one command

```bash
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
```

That is the whole capture. It validates the code, attaches to the persistent-profile Chrome (launching it if needed), lands on the case via direct cache URL or fast global search (`/s/global-search/<CODE>`), expands the Chatter feed completely, extracts metadata + description + comments, sorts comments chronologically (Oldest -> Newest), writes `case.json`, updates `_index.json`, renders `case.md`, and runs QA validation. It decides new-vs-update from the cache on its own.

Optional: `--mode full|update` (override the auto choice).

**stdout is exactly one JSON line.** Read it and branch:

| `status` | exit | Meaning | Your next step |
|----------|------|---------|----------------|
| `created` | 0 | new case captured | Report case info & artifacts to user |
| `updated` | 0 | new comments merged (`newComments`, `newCommentIds`) | Report updated comments & artifacts to user |
| `no-update` | 0 | nothing new since `since` | Report "no update", STOP |
| `auth-required` | 3 | saved Okta session lapsed | The user must sign in MANUALLY in the open Chrome window (enter password + email OTP) (Recovery 1 → `references/login-flow.md`). Once logged in, re-run the command. |
| `not-found` | 4 | search returned nothing for this code | STOP — wrong code, or the account cannot see it |
| `blocked` | 5 | page never rendered / capture short | load `references/manual-flow.md` and finish by hand; `reason` says where it stopped |
| `busy` | 6 | another capture holds the lock (`data/.capture.lock`) | wait ~30s, re-run **once**; still `busy` after 2 retries → report and STOP |
| `error` | 1 | bad invocation or script failure | fix per `reason`; do not retry blindly |

> **A non-zero exit here is BY DESIGN for `auth-required`/`not-found`/`blocked`/`busy` — it is not a crash.** Whatever ran the command (Bash tool, Cline `execute_command`, a background-task wrapper) may still surface it as a generic "failed" result. **Ignore that label — always branch on the `status` field inside stdout's JSON line, never on the shell exit-status label alone.**

> `blocked` is never "no update". A tool failure means inconclusive — reporting an unchanged case on a failed probe is the one wrong answer here.

**Every `created` / `updated` verdict is verified and carries its evidence.** Before returning, `run_case.mjs` runs `verify_case.mjs` against what it just persisted (`verified: true`, any `verifyWarnings`); a failure comes back as `blocked` + `retryable`, never as success. The verdict's `evidence` block — also persisted as `capture` in `case.json` — records `pendingExpand` / `pendingMoreComments` (both must be 0), the per-control `clicks` tally, and `screenshot` (`capture.png`, or `probe.png` on a `no-update`).

**Do NOT `Read` `case.json` to find out what happened.** The verdict line already carries the counts, ids and paths; the file is the size of the whole case.

---

## Output Artifacts

Each captured case produces two clean artifacts in `data/cases/<CODE>/`:
1. `case.json`: Canonical structured JSON with case metadata, description, attachments, and `comments` array sorted chronologically (Oldest -> Newest).
2. `case.md`: Clean Markdown document containing case headers, initial description, and numbered chronological comment timeline.

The global index `data/cases/_index.json` is updated with synced timestamp, hash, and comment count.

---

## Reporting

Tell the user:
- Case number, title, and status.
- Number of comments captured (and for update runs, how many new comments were added).
- File paths: `data/cases/<CODE>/case.json` and `data/cases/<CODE>/case.md`.

---

## Agent Guardrails

- **Fast path first.** Only fall back to `references/manual-flow.md` when a verdict says `blocked`, or the user explicitly asks for a manual step. Do not hand-drive a run that the script can do.
- **A valid code needs no confirmation** — validate, then capture. Cached case → the script picks the incremental update path by itself.
- **Session = persistent Chrome profile** at `data/chrome-profile`. Never close it between runs.
- **URL discipline.** The only URL ever opened by hand is `/s/global-search/<CODE>`. The real case URL is `/s/case/<SFID>/<slug>` where `<SFID>` is a Salesforce 18-char record id resolved from the search result — **never** construct `/s/case/<case-number>`.
- **Confidentiality:** case content is Qualcomm NDA. Keep it in `data/` (git-ignored). Never paste it to an external service.
- **Fidelity:** comment bodies and logs are captured VERBATIM. Never truncate.
- **No fabrication:** absent field/URL/log → say so.
- **Scope:** one case per invocation.
- **ToS:** extract only cases the signed-in account is authorized to view.
