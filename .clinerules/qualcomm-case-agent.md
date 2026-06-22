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
- **Do not** use Cline's built-in `browser_action`. This agent attaches the standalone `agent-browser`
  CLI to **real Google Chrome over CDP** (`connect 9222`), launched detached with a persistent
  `--user-data-dir` (`data/chrome-profile/`) so the Qualcomm/Okta login survives between runs.
  `browser_action` cannot reuse that session. NOT the bundled Chromium — a broken bundled build
  caused `os error 10060` (see SKILL.md → Troubleshooting).
- Prerequisites (install once): Node.js ≥18, `npm i -g agent-browser`, and **real Google Chrome**
  installed (`agent-browser install`'s bundled Chromium is not required).
- Launch + attach (Phase 0): `execute_command` →
  `powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"`
  then `agent-browser connect 9222 < /dev/null`. The helper never kills the user's personal Chrome.
- First login (Okta password + 6-digit **email OTP**) is human-in-the-loop, done in the visible
  Chrome window. After that the profile persists; later syncs need no OTP until it expires.
- Output goes to `data/cases/<CODE>.json` (full) + `<CODE>.report.md` (summary) +
  `<CODE>.md` / `<CODE>.html` / `<CODE>.txt` (review, + optional `<CODE>.pdf`). Unchanged cases
  report "no update".
- **Deep analysis** (overview, analysis flow, root cause, open questions, per-comment role +
  3GPP citations) is PHASE 4 of the runbook, and can also be run standalone — no browser/re-scrape —
  via the sibling skill `.claude/skills/qualcomm-enrich/SKILL.md` (triggers: "enrich/re-enrich/
  analyze qualcomm case", "phân tích lại / đánh giá case qualcomm").

One case per request. Never type the Qualcomm password or OTP — the user enters those in the browser.
