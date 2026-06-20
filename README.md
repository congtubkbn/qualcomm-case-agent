# access-qualcomm

Local workspace for capturing Qualcomm Support (support.qualcomm.com) cases.

## What it does

Drives a browser (via `agent-browser`) to sign in to the Qualcomm Support portal
(support.qualcomm.com), extracts a full
support case — metadata plus **every** comment (verbatim, with analysis logs and attachments) —
adds engineer-grade summaries (Protocol / RF / 3GPP), and writes a local cache per case in three
formats. Re-running an unchanged case reports **"no update"** (incremental, hash-based).

## Usage

Ask your agent, with a case code:

- "access qualcomm case CASE-12345" / "qualcomm case 00123456"
- "phân tích case qualcomm CASE-12345"

The runbook lives **inside this project** at
[`.claude/skills/qualcomm-case-agent/SKILL.md`](.claude/skills/qualcomm-case-agent/SKILL.md), so it
travels with the repo. One case per run.

## Agents (Claude Code + Cline / VS Code)

The skill is **harness-agnostic** — it drives the `agent-browser` CLI and `node` through a terminal,
so it runs under any agent that can run commands and edit files:

- **Claude Code** — discovers `.claude/skills/qualcomm-case-agent/` (project skill).
- **Cline (VS Code)** — reads `.clinerules/qualcomm-case-agent.md`, which points it at the runbook;
  use Cline's `execute_command` for the CLI lines (not its built-in `browser_action`).
- **Other agents** — `AGENTS.md` at the project root is a generic pointer.

All paths in the runbook are relative to the workspace root — no machine-specific paths.

## Login / MFA

- Qualcomm ID: `the.thoi@samsung.com` (login id only — the password is never typed by the agent).
- Auth: Okta OAuth at `account.qualcomm.com`. A fresh session requires **email OTP** — a 6-digit
  code emailed to the Samsung mailbox (expires ~5 min). The **user** pastes it in the browser;
  Claude cannot read that mailbox.
- **No email access = no fresh login.** A still-valid profile session bypasses OTP; once it expires
  and the mailbox is unreachable, authentication can't complete — the skill reports and stops.
- After one sign-in, the session lives in the persistent Chrome profile `data/chrome-profile/`
  (git-ignored) so MFA is one-time until it expires. On expiry the user just signs in again in the
  same profile (no notification).

## Layout

```
data/chrome-profile/           # persistent browser auth profile (agent-browser --profile; git-ignored)
data/cases/<CODE>.json         # complete per-case data (source of truth, machine-readable)
data/cases/<CODE>.report.md    # concise SUMMARY report (engineer summary, root cause, actions)
data/cases/<CODE>.md           # full readable snapshot (every comment verbatim)
data/cases/<CODE>.html         # full single-file HTML (easiest human review)
data/cases/_index.json         # <CODE> -> { syncedAt, commentCount, hash } for incremental sync
```

`data/cases/` is git-ignored — case content is Qualcomm NDA material, kept local only.

## Requirements

- Windows, Node.js ≥18
- `agent-browser` CLI (`npm i -g agent-browser && agent-browser install`) — uses its own bundled
  Chromium, not system Chrome
- The render script `node .claude/skills/qualcomm-case-agent/scripts/render_case.mjs` (JSON → report
  + Markdown + HTML)

## New machine

1. Install Node + agent-browser (above).
2. Copy the **whole project folder** over (skill is inside `.claude/skills/`).
3. Do **not** copy `data/chrome-profile/` (auth, encrypted to the old user) or `data/cases/` (NDA) —
   both git-ignored. Re-login fresh on the new PC.
4. First login (Okta + email OTP) in a **real terminal**; the profile persists afterward.
