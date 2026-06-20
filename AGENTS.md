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

- Windows. Node.js ≥18. `agent-browser` CLI (`npm i -g agent-browser` + `agent-browser install`).
- `agent-browser` uses its own bundled Chromium (not system Chrome) with a persistent profile at
  `data/chrome-profile/` so the Qualcomm/Okta session survives between runs.
- Login uses **email OTP** (human-entered, in the browser). Browser-launching commands must run in a
  **real terminal** (they hang in a piped/automation shell).

## Do not commit / do not copy across machines

- `data/chrome-profile/` — live auth, DPAPI-encrypted to this Windows user (non-portable).
- `data/cases/` — Qualcomm NDA case content.

Both are git-ignored.
