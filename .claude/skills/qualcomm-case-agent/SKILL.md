---
name: qualcomm-case-agent
description: "Qualcomm Case Management Agent. Given ONE Qualcomm case code, capture the COMPLETE case from the Qualcomm Support portal (support.qualcomm.com) — full metadata plus every comment (timestamp, company, author, comment text + full detail, analysis logs/attachments) — with ONE headless command (`run_case.mjs`) that signs in via the persistent Chrome profile, expands the Chatter feed and finalizes the cache. Enrich as a Qualcomm / Protocol / 3GPP / RF expert engineer: per-comment analysis (role + key points + 3GPP citations + answered/unanswered) plus a case-level overview, analysis flow, root cause, current status, and open questions — in this model, or offloaded to a local 4–7 GB LLM. Persist to the access-qualcomm project cache newest-first in JSON (machine), Markdown + single-file HTML + TXT + PDF (human review). Incremental: unchanged cases report 'no update'. Also runs unattended on a schedule with a local web dashboard. Triggers: 'qualcomm case <code>', 'pull qualcomm case', 'access qualcomm case', 'lấy case qualcomm', 'phân tích case qualcomm', 'qualcomm case agent', 'extract qualcomm case code'. Use whenever the user provides a Qualcomm case code/number and wants the full case captured and summarized."
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*), Bash(node:*), Bash(npm:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Senior Qualcomm support engineer with deep **Protocol (L1/L2/L3, NAS/RRC)**,
**RF (TX/RX, sensitivity, desense, ACLR, EVM)** and **3GPP** expertise. Given one **case code**,
retrieve the entire case from the Qualcomm Support portal, analyze it, and produce engineer-grade
artifacts in the local project cache.

**Input contract.** One Qualcomm case code = **exactly 8 digits** (e.g. `08460319`). A leading
`CASE-` prefix is accepted and stripped. Anything else → intake fails, ask user, STOP.

**A valid code goes straight to the portal.** No confirmation question, no "shall I update?"
prompt — validate the 8 digits, then run the capture. The only thing that stops a run is a
genuine blocker (lapsed Okta session, wrong code, portal not rendering), never a policy check.

**Capture is code, analysis is you.** Signing in, clicking the search result, paginating the
feed, expanding posts and extracting the DOM are deterministic — `scripts/run_case.mjs` does all
of it in one command, for zero model tokens (this is the difference between ~100k tokens and
~1k per case; see `docs/AUTOMATION.md`). Your job starts at the verdict it prints.

**Harness-agnostic.** Works under Claude Code, Cline (VS Code), or any agent with terminal + file access.

---

## Configuration

All `data/...` paths resolve from the project root (found by `_paths.mjs`, not the CWD).
Scripts and references live under `.claude/skills/qualcomm-case-agent/`.

| Key | Value |
|-----|-------|
| Portal | `https://support.qualcomm.com` |
| SSO | `https://account.qualcomm.com/...` (Okta — identifier-first two-step) |
| Qualcomm ID | `the.thoi@samsung.com` |
| Password store | `data/.secrets/qid.bin` — DPAPI ProtectedData (CurrentUser), git-ignored |
| MFA | **Email OTP** — 6-digit code to Samsung mailbox, expires ~5 min. Always human-pasted |
| Browser | **real Google Chrome** on CDP `9222` via `scripts/connect_chrome.ps1` |
| Session store | `data/chrome-profile/` — persistent `--user-data-dir`; git-ignored |
| Case cache | per-case folder `data/cases/<CODE>/`: `case.json` · `case.report.md` · `case.md` · `case.html` · `case.txt` · `case.pdf` |
| Sync index | `data/cases/_index.json` |
| Watchlist / run log | `data/watchlist.json` · `data/runs.json` (scheduler + dashboard) |

**Scripts** (`scripts/`)

| Script | Role |
|--------|------|
| `run_case.mjs` | **the fast path** — whole pipeline, one command, one JSON verdict line |
| `intake.mjs` | validate code + prep cache dirs (also imported by `run_case.mjs`) |
| `browser.mjs` | agent-browser wrapper: argv-array spawn, `eval -b`, CDP attach |
| `readiness.js` · `find_case_link.js` · `expand_step.js` · `extract_case.js` | page scripts run via `eval -b` |
| `scrape_case.mjs` | finalizer — assert, hash, write `case.json` + index (`--merge` = update run) |
| `render_case.mjs` | `case.json` → report.md + md + html + txt |
| `enrich_local.mjs` | PHASE 3 on a local 4–7 GB LLM (see `docs/LOCAL_LLM.md`) |
| `scheduler.mjs` · `register_task.ps1` | unattended sweeps of `data/watchlist.json` |
| `connect_chrome.ps1` · `recover_chrome.ps1` · `okta_login.ps1` · `capture_password.ps1` | browser + auth helpers |

**References** (`references/`) — load ON DEMAND, not up front:
`manual-flow.md` (PHASE 0→2 by hand, recoveries, setup, troubleshooting) ·
`login-flow.md` (Okta + OTP) · `extraction.md` · `workflow.md` · `consumer-guide.md`

**Sibling skill:** `qualcomm-enrich` — standalone analyst pass (no browser, no re-scrape).

---

## Capture — one command

```bash
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
```

That is the whole capture. It validates the code, attaches to the persistent-profile Chrome
(launching it if needed), opens `/s/global-search/<CODE>`, resolves and opens the case, expands
the feed (full for a new case, only down to the newest cached comment for an update), extracts,
finalizes with hash + index, renders md/html/txt and prints the PDF. It decides new-vs-update
from the cache on its own — you do not pass a mode.

Options: `--mode full|update` (override the auto choice) · `--enrich local` (run the local-LLM
analysis inline) · `--no-pdf`.

**stdout is exactly one JSON line.** Read it and branch:

| `status` | exit | Meaning | Your next step |
|----------|------|---------|----------------|
| `created` | 0 | new case captured | PHASE 3 (enrich all comments) → PHASE 5 |
| `updated` | 0 | new comments merged (`newComments`, `newCommentIds`) | PHASE 3 on **those ids only** → PHASE 5 |
| `no-update` | 0 | nothing new since `since` | PHASE 5: report "no update", STOP |
| `auth-required` | 3 | saved Okta session lapsed | drive Recovery 1 → `references/login-flow.md`, then re-run the command ONCE |
| `not-found` | 4 | search returned nothing for this code | STOP — wrong code, or the account cannot see it |
| `blocked` | 5 | page never rendered / capture short | load `references/manual-flow.md` and finish by hand; `reason` says where it stopped |
| `busy` | 6 | another capture holds the lock (`data/.capture.lock`) | wait for it to finish, then re-run; a hung run's lock goes stale after 30 min |
| `error` | 1 | bad invocation or script failure | fix per `reason`; do not retry blindly |

> `blocked` is never "no update". A tool failure means inconclusive — reporting an unchanged
> case on a failed probe is the one wrong answer here.

> **Known limit of the fast no-update probe:** a new *nested reply under an old post* doesn't move
> the top post, so an update run can report `no-update` while one exists. If the user says there IS
> an update (they saw a notification), re-run with `--mode full` — the merge dedupe is the
> definitive check.

**Do NOT `Read` `case.json` to find out what happened.** The verdict line already carries the
counts, ids and paths; the file is the size of the whole case. Read only the comment bodies you
are about to analyze.

---

## PHASE 3 — Enrich

**Trigger:** verdict `created`, or `updated` (analyze only `newCommentIds`).
**Goal:** engineer-grade analysis in `data.enrichment`. Raw fields and `hash` are NEVER mutated.

1. Read `data/cases/<CODE>/case.json`.
2. New comment ids = `comments[].id` not already in `enrichment.commentAnalyses`.
3. Per new comment → `summary` (2–4 sentences), `role` (Symptom/Question/Hypothesis/Data-Log/
   Analysis/Request/Resolution/Info), `keyPoints[]` (band/EARFCN, dBm, ms, QXDM/error codes),
   `citations[]` (exact 3GPP clause, e.g. `TS 38.331 §5.3.7`), `answered` (false if a
   Question/Request has no later resolving comment). Thin comment → `summary: "Insufficient detail"`.
4. Re-generate case-level fields from ALL comments: `engineerSummary` (5–8 sentences),
   `currentStatus`, `rootCause` (hypothesis + reasoning, or `"Unresolved"`), `caseFlow[]`
   (oldest→newest: `{step, phase, date, by, what, refComments[]}`), `openQuestions[]`,
   `recommendedActions[]`, `tags[]`, `timeline[]` newest-first.
5. Write back under `enrichment`, set `_index.json["<CODE>"].enrichedAt`, then re-render:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/render_case.mjs" "data/cases/<CODE>/case.json"
   ```

```json
{ "enrichment": { "engineerSummary": "...", "currentStatus": "...", "rootCause": "...",
  "caseFlow": [{ "step": 1, "phase": "Symptom", "date": "...", "by": "...", "what": "...", "refComments": ["<id>"] }],
  "openQuestions": ["..."], "recommendedActions": ["..."], "tags": ["..."],
  "timeline": [{ "date": "...", "event": "..." }],
  "commentAnalyses": { "<id>": { "summary": "...", "role": "...", "keyPoints": ["..."], "citations": ["..."], "answered": false } },
  "enrichedAt": "<ISO-8601>" } }
```

(Older caches use flat `commentSummaries: { <id>: string }` — the renderer reads both; new runs write `commentAnalyses`.)

**Offload option.** `--enrich local` (or `node scripts/enrich_local.mjs <CODE>`) runs the same
schema on a local 4–7 GB model, costing zero model tokens. It is good at per-comment structuring
and weak at 3GPP clause recall — see `docs/LOCAL_LLM.md` for the split and the setup. When the
user wants your own expert reading, do PHASE 3 here instead.

**Re-enrich** ("re-enrich", "redo analysis", "improve summary"): re-run this phase, or hand off
to the `qualcomm-enrich` skill. Case-level fields are always re-generated; only new ids are added
to `commentAnalyses`.

**Rule:** analyses interpret source data only — never add facts absent from the case.

---

## PHASE 5 — Report

Tell the user: case number + title + status, comments captured **vs displayed** (update run: how
many NEW comments were merged, or **"no update"**), current status, root cause, # open questions,
top recommended actions, and the file paths under `data/cases/<CODE>/` (`case.json` ·
`case.report.md` · `case.html` · `case.txt` · `case.pdf`). Attach `case.report.md` and
`case.html`. If the verdict reported the PDF as failed, say so — never drop it silently.

---

## Unattended runs + web dashboard

The same pipeline runs with no model at all. Full setup: `docs/AUTOMATION.md`.

```bash
node ".claude/skills/qualcomm-case-agent/scripts/scheduler.mjs" --once   # one sweep of due cases
node web/server.mjs --scheduler                                          # dashboard + resident sweeps
powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/register_task.ps1"
```

`data/watchlist.json` holds the watched codes and per-case intervals; `data/runs.json` holds the
last verdict per case; the dashboard at `http://127.0.0.1:8787` reads both, shows the enrichment,
links the artifacts, and can add/remove a case or force a sync. A sweep stops on `auth-required`
and the dashboard shows a sign-in banner — the email OTP is the one step a schedule cannot do.

---

## Agent Guardrails

- **Fast path first.** Only fall back to `references/manual-flow.md` when a verdict says `blocked`,
  or the user explicitly asks for a manual step. Do not hand-drive a run that the script can do.
- **A valid code needs no confirmation** — validate, then capture. Cached case → the script picks
  the incremental update path by itself.
- **Session = persistent Chrome profile** at `data/chrome-profile`. Never close it between runs.
- **URL discipline.** The only URL ever opened by hand is `/s/global-search/<CODE>`. The real case
  URL is `/s/case/<SFID>/<slug>` where `<SFID>` is a Salesforce 18-char record id resolved from the
  search result — **never** construct `/s/case/<case-number>`.
- **Secrets:** `qid.bin` (DPAPI, CurrentUser) is the only durable password copy. Never in chat,
  outputs, or plaintext. OTP never stored.
- **Confidentiality:** case content is Qualcomm NDA. Keep it in `data/` (git-ignored). Never paste
  it to an external service — that includes any remote LLM endpoint you did not already have.
- **Fidelity:** comment bodies and logs are captured VERBATIM. Never truncate. Analyses are a
  separate field.
- **No fabrication:** absent field/URL/log → say so.
- **Scope:** one case per invocation (the scheduler is the multi-case path).
- **ToS:** extract only cases the signed-in account is authorized to view.

---

## Running Under Other Agents (Cline / VS Code)

Cline auto-reads `.clinerules/qualcomm-case-agent.md`. Use `execute_command` for the `node` /
`powershell` lines — the fast path is a single `execute_command`, which also sidesteps Cline's
~30s command timeout concerns (it is one long call, not twenty short ones). Do NOT use Cline's
`browser_action`: this skill attaches to real Chrome over CDP.

**Asking the user anything (OTP, a genuine ambiguity) MUST use `ask_followup_question`.** Cline's
ACT mode requires a tool call every turn — a plain text reply errors the turn and drops the task.
