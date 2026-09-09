# access-qualcomm

Local workspace for capturing Qualcomm Support (support.qualcomm.com) cases.

## What it does

Drives real Chrome (via the `agent-browser` CLI) to sign in to the Qualcomm Support portal and
extracts a full support case — metadata plus **every** comment, verbatim — into a local cache.
Re-running an unchanged case reports **"no update"** (incremental, hash-based).

The capture itself is deterministic code, not agent choreography:

```bash
node ".claude/skills/qcomm/scripts/run_case.mjs" 08603854
```

One command, one JSON verdict line, no browser babysitting.

## Usage

**From an agent**, with a case code:

- "access qualcomm case CASE-12345" / "qualcomm case 00123456"
- "phân tích case qualcomm CASE-12345"

A valid 8-digit code goes straight to the portal — no confirmation step. The runbook lives inside
this project at [`.claude/skills/qcomm/SKILL.md`](.claude/skills/qcomm/SKILL.md),
so it travels with the repo. One case per run.

**From the terminal:**

```bash
npm run case -- 08603854          # capture one case
npm run cases:overview            # terminal summary table of all cases
npm run cases:dashboard           # open interactive HTML dashboard in browser
npm run setup:protocol            # manually register qc:// protocol handler
npm run uninstall:protocol        # unregister qc:// protocol handler
npm test                          # unit tests
```

## Interactive Dashboard

Running `npm run cases:dashboard` launches the standalone, offline HTML dashboard (`data/cases/dashboard.html`):

- **`qc://` Protocol Links** (Click `#CaseNumber` or Title): Directly opens and focuses the case inside the dedicated authenticated Chrome session (`data/chrome-profile/` on port 9222/9773). Seamlessly bypasses login gates and Okta SSO prompts.
- **`⚙️ Protocol Help` Modal**: In-dashboard guide explaining `qc://` navigation and 1-click registration command copying for troubleshooting.

## Zero-Config Protocol Onboarding (`qc://`)

The custom URI scheme `qc://case/<case-number>` is automatically registered into the Windows user-space registry (`HKCU:\Software\Classes\qc`) without requiring Administrator privileges:

1. **Auto-Install**: The `npm postinstall` lifecycle hook runs `scripts/ensure_protocol.mjs`, registering `qc://` automatically on `npm install`.
2. **Self-Healing**: Dashboard builds and CLI runs check registry status and silently self-heal missing protocol associations.
3. **Manual Control**:
   - Register: `npm run setup:protocol` (or `powershell -ExecutionPolicy Bypass -File scripts/register_protocol.ps1`)
   - Unregister: `npm run uninstall:protocol` (or `powershell -ExecutionPolicy Bypass -File scripts/unregister_protocol.ps1`)
   - Platform Safety: Non-Windows environments cleanly skip registration as a harmless no-op.

## Agents (Claude Code + Cline / VS Code)

The skills are **harness-agnostic** — they drive `node` through a terminal, so they run under any agent that can run commands and edit files:

- **Claude Code** — discovers `.claude/skills/` (`qcomm`, `qualcomm-issue-precedent`).
- **Cline (VS Code)** — reads `.clinerules/qcomm.md`; the capture is a single
  `execute_command`. Do not use Cline's built-in `browser_action`.
- **Other agents** — point them at the respective `SKILL.md`; every step is a plain terminal command.

## Login / MFA

- Qualcomm ID: Your email address, configured locally via `npm run setup:credentials` (login id only — the password is never typed by the agent).
- Auth: Okta OAuth at `account.qualcomm.com`. A fresh session requires **email OTP** — a 6-digit
  code emailed to your registered mailbox (expires ~5 min). The **user** pastes it in the browser.
- **No email access = no fresh login.** A still-valid profile session bypasses OTP; once it expires
  and the mailbox is unreachable, authentication can't complete — the run reports `auth-required`
  and stops.
- After one sign-in the session lives in the persistent Chrome profile `data/chrome-profile/`
  (git-ignored), so MFA is one-time until it expires ("Keep me signed in" ≈ 30 days).

## Layout

```
data/chrome-profile/            # persistent Chrome --user-data-dir (real Chrome via CDP)
data/cases/<CODE>/case.json     # complete per-case data (source of truth, machine-readable)
data/cases/<CODE>/case.md       # full readable snapshot (every comment verbatim)
data/cases/<CODE>/summary.json  # per-comment technical digest + flow narrative
data/cases/_index.json          # <CODE> -> { syncedAt, commentCount, hash } for incremental sync
data/cases/_overview.json       # fast aggregated multi-case overview cache
data/cases/dashboard.html       # standalone, offline interactive HTML dashboard
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
  to system Chrome over CDP 9773, not the bundled Chromium (a broken bundled build caused
  `os error 10060`). Launch helper: `scripts/connect_chrome.ps1`, or let `run_case.mjs` do it.

## New machine

1. Install Node + agent-browser + Chrome (above).
2. Copy the **whole project folder** over (the skill is inside `.claude/skills/`).
3. Do **not** copy `data/` — the Chrome profile is encrypted to the old user, `qid.bin` is
   DPAPI-bound, and case content is NDA. All git-ignored.
4. First login (Okta + email OTP) in a **real terminal**; the profile persists afterward.
