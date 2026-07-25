# access-qualcomm

Local workspace for capturing Qualcomm Support (support.qualcomm.com) cases.

## What it does

Drives real Chrome (via the `agent-browser` CLI) to sign in to the Qualcomm Support portal,
extracts a full support case — metadata plus **every** comment (verbatim, with analysis logs and
attachments) — adds engineer-grade analysis (Protocol / RF / 3GPP), and writes a local cache per
case in several formats. Re-running an unchanged case reports **"no update"** (incremental,
hash-based).

The capture itself is deterministic code, not agent choreography:

```bash
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" 08603854
```

One command, one JSON verdict line, no browser babysitting — see [`docs/AUTOMATION.md`](docs/AUTOMATION.md).

## Usage

**From an agent**, with a case code:

- "access qualcomm case CASE-12345" / "qualcomm case 00123456"
- "phân tích case qualcomm CASE-12345"

A valid 8-digit code goes straight to the portal — no confirmation step. The runbook lives inside
this project at [`.claude/skills/qualcomm-case-agent/SKILL.md`](.claude/skills/qualcomm-case-agent/SKILL.md),
so it travels with the repo. One case per run.

**From the terminal:**

```bash
npm run case -- 08603854          # capture one case
npm run sync                      # one sweep of everything due in data/watchlist.json
npm run watch                     # resident scheduler
npm run web                       # dashboard on http://127.0.0.1:8787 + sweeps
npm test                          # unit tests
```

## Agents (Claude Code + Cline / VS Code)

The skill is **harness-agnostic** — it drives `node` and the `agent-browser` CLI through a
terminal, so it runs under any agent that can run commands and edit files:

- **Claude Code** — discovers `.claude/skills/qualcomm-case-agent/` (project skill).
- **Cline (VS Code)** — reads `.clinerules/qualcomm-case-agent.md`; the capture is a single
  `execute_command`. Do not use Cline's built-in `browser_action`.
- **Other agents** — point them at the same SKILL.md; every step is a plain terminal command.

## Scheduling + dashboard

`data/watchlist.json` lists the cases to keep in sync and how often. `scheduler.mjs` runs the due
ones (`--once` for Task Scheduler / cron, or resident), records each verdict in `data/runs.json`,
and stops at the first `auth-required` — the email OTP is the one step a schedule cannot do.
`web/server.mjs` serves a localhost-only dashboard over the same cache: status, comment counts,
enrichment, artifact links, add/remove a case, force a sync. Details in
[`docs/AUTOMATION.md`](docs/AUTOMATION.md).

## Analysis on a local LLM

Per-comment and case-level analysis can run on a **local model in 4–7 GB of RAM** (Qwen3-4B at
4 GB, Qwen2.5-7B at 6–7 GB, any OpenAI-compatible server), for zero cloud tokens:

```bash
node .claude/skills/qualcomm-case-agent/scripts/enrich_local.mjs 08603854
```

What fits, what it must not be trusted with, and setup: [`docs/LOCAL_LLM.md`](docs/LOCAL_LLM.md).

## Login / MFA

- Qualcomm ID: `the.thoi@samsung.com` (login id only — the password is never typed by the agent).
- Auth: Okta OAuth at `account.qualcomm.com`. A fresh session requires **email OTP** — a 6-digit
  code emailed to the Samsung mailbox (expires ~5 min). The **user** pastes it in the browser.
- **No email access = no fresh login.** A still-valid profile session bypasses OTP; once it expires
  and the mailbox is unreachable, authentication can't complete — the run reports `auth-required`
  and stops.
- After one sign-in the session lives in the persistent Chrome profile `data/chrome-profile/`
  (git-ignored), so MFA is one-time until it expires ("Keep me signed in" ≈ 30 days).

## Layout

```
data/chrome-profile/            # persistent Chrome --user-data-dir (real Chrome via CDP)
data/cases/<CODE>/case.json     # complete per-case data (source of truth, machine-readable)
data/cases/<CODE>/case.report.md# concise SUMMARY report (engineer summary, root cause, actions)
data/cases/<CODE>/case.md       # full readable snapshot (every comment verbatim)
data/cases/<CODE>/case.html     # full single-file HTML (easiest human review)
data/cases/<CODE>/case.txt      # plain text  ·  case.pdf — printed from the HTML
data/cases/_index.json          # <CODE> -> { syncedAt, commentCount, hash } for incremental sync
data/watchlist.json             # scheduled cases + intervals
data/runs.json                  # last verdict per case (the dashboard reads this)
```

All of `data/` is git-ignored — case content is Qualcomm NDA material, kept local only.

## Design docs

[`docs/DESIGN.md`](docs/DESIGN.md) is the architecture reference: constraints, the decisions and the
alternatives they beat, data model, runtime flows, invariants, failure modes and the improvement
backlog. Its module/API section is generated from the source — `npm run docs` regenerates it,
`npm run docs:hook` installs the pre-commit hook that keeps it current, `npm run docs:check` fails
when it is stale.

## Requirements

- Windows (the auth helpers are PowerShell + DPAPI), Node.js ≥18
- `agent-browser` CLI (`npm i -g agent-browser`) + **real Google Chrome** — the pipeline attaches
  to system Chrome over CDP 9222, not the bundled Chromium (a broken bundled build caused
  `os error 10060`). Launch helper: `scripts/connect_chrome.ps1`, or let `run_case.mjs` do it.
- Optional: an OpenAI-compatible local LLM server for `enrich_local.mjs`.

## New machine

1. Install Node + agent-browser + Chrome (above).
2. Copy the **whole project folder** over (the skill is inside `.claude/skills/`).
3. Do **not** copy `data/` — the Chrome profile is encrypted to the old user, `qid.bin` is
   DPAPI-bound, and case content is NDA. All git-ignored.
4. First login (Okta + email OTP) in a **real terminal**; the profile persists afterward.
