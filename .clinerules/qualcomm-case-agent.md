# Cline rule — Qualcomm case agent

When the user asks to capture / sync / analyze a **Qualcomm case** (e.g. "sync Qualcomm case
CASE-12345", "lấy case qualcomm CASE-12345", "qualcomm case 00123456"), follow the runbook:

**`.claude/skills/qualcomm-case-agent/SKILL.md`**

(plus its `references/` for login, extraction and workflow detail).

## How to run it under Cline

- It is a plain runbook, not a Claude-Code skill. Use **execute_command** for every `agent-browser`
  and `node` line; use your file tools (read_file / write_to_file / replace_in_file) for read/write.
- All paths are **relative to the workspace root** (this project). Run commands from the project
  folder.
- **Do not** use Cline's built-in `browser_action`. This agent drives the standalone `agent-browser`
  CLI, which uses its own bundled Chromium and a persistent `--profile` directory
  (`data/chrome-profile/`) so the Qualcomm/Okta login survives between runs. `browser_action` cannot
  reuse that session.
- Prerequisites (install once): Node.js ≥18, `npm i -g agent-browser`, then `agent-browser install`.
- First login (Okta password + 6-digit **email OTP**) is human-in-the-loop and must be done in a
  **real terminal** — browser launch hangs in a piped/automation shell. After that the profile
  persists; later syncs need no OTP until it expires.
- Output goes to `data/cases/<CODE>.json` (full) + `<CODE>.report.md` (summary) +
  `<CODE>.md` / `<CODE>.html` (review). Unchanged cases report "no update".

One case per request. Never type the Qualcomm password or OTP — the user enters those in the browser.
