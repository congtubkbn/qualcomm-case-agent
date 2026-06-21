# AGENTS.md — access-qualcomm

Generic instructions for any coding agent working in this repository (Claude Code, Cline, Cursor,
Copilot, etc.).

## Primary task: Qualcomm case capture

When the user asks to capture / sync / analyze a **Qualcomm case** by code, follow the runbook at:

**`.claude/skills/qualcomm-case-agent/SKILL.md`** (with its `references/`).

It is harness-agnostic: drive the `agent-browser` CLI and `node` through your terminal /
execute-command tool, and use your file tools for read/write. All paths are relative to this
workspace root.

## Environment

- Windows. Node.js ≥18. `agent-browser` CLI (`npm i -g agent-browser`) + **real Google Chrome**.
- `agent-browser` attaches to **real system Chrome over CDP** (`connect 9222`), launched detached with
  a persistent `--user-data-dir` at `data/chrome-profile/` so the Qualcomm/Okta session survives
  between runs. NOT the bundled Chromium (a broken bundled build caused `os error 10060`). Launch via
  `.claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1`; it never closes personal Chrome.
- Login uses **email OTP** (human-entered, in the visible Chrome window). Launch Chrome with
  `Start-Process` (the helper does this) so it doesn't hang on a piped shell's redirected stdin.

## Do not commit / do not copy across machines

- `data/chrome-profile/` — live auth, DPAPI-encrypted to this Windows user (non-portable).
- `data/cases/` — Qualcomm NDA case content.

Both are git-ignored.
