# Setup & Troubleshooting

Machine setup, the `qcase` CLI install, running under other agents, and the known
Windows gotchas for the Qualcomm Case Management Agent.

---

## The `qcase` CLI

The skill's Node/PowerShell scripts are packaged as a small CLI so SKILL.md calls short
verbs (`qcase intake <CODE>`) instead of long literal script paths. Install once per
machine from the skill's `scripts/` folder:

```bash
cd .claude/skills/qualcomm-case-agent/scripts
npm link            # or: npm i -g .   → puts `qcase` on PATH
```

Verbs:

| Command | What it runs |
|---------|--------------|
| `qcase intake <CODE>` | validate 8-digit code, prep `data/cases/`, seed `_index.json` |
| `qcase scrape <CODE> <raw.json> [--merge] [--title .. --status .. --priority ..]` | finalize raw capture → `case.json` + `_index.json` (`--merge` = update run) |
| `qcase render <case.json>` | write `case.report.md` / `.md` / `.html` / `.txt` beside it |
| `qcase script readiness` \| `qcase script extract` | print the browser-eval JS to stdout — pipe into `agent-browser eval --stdin` |
| `qcase chrome` | launch/attach real Chrome on CDP 9222 (persistent profile) |
| `qcase login` | Okta identifier-first login (DPAPI-decrypted) |
| `qcase capture-pw` | one-time DPAPI password capture (interactive — real terminal only) |

Paths resolve via `_paths.mjs` (walks up to the project root, or `QUALCOMM_ROOT`), so
`qcase` writes the cache under the project no matter which directory it runs from.

---

## Setup on a New Windows Machine

1. Install Node.js (≥18) + `npm i -g agent-browser`. Install real Google Chrome (bundled
   Chromium not needed).
2. Copy the project folder — the skill travels in `.claude/skills/qualcomm-case-agent/`.
3. Install the CLI: `cd .claude/skills/qualcomm-case-agent/scripts && npm link`.
4. Do NOT copy `data/chrome-profile/`, `data/.secrets/`, `data/cases/` — the DPAPI
   `qid.bin` is machine/user-bound. All git-ignored.
5. First run: try PHASE 1 → Recovery 0 launches Chrome → Recovery 1 handles first login +
   OTP + DPAPI capture. Run `qcase capture-pw` in a real PowerShell terminal (needs
   interactive `Read-Host`).

---

## Running Under Other Agents (Cline / VS Code)

Cline auto-reads `.clinerules/qualcomm-case-agent.md`. Use `execute_command` for every
`qcase` / `agent-browser` / `powershell` line. Do NOT use Cline's `browser_action` — this
skill attaches to real Chrome over CDP.

---

## Troubleshooting

**`os error 10060` on `agent-browser connect 9222`**

`connect 9222` uses `http://localhost:9222`. Windows resolves `localhost` to IPv6 `::1`
first; Chrome binds only IPv4 `127.0.0.1`. Fix: use the explicit ws:// URL that
`qcase chrome` prints:
```bash
agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
```
Diagnose: `curl -s http://127.0.0.1:9222/json/version` → HTTP 200 means Chrome is fine;
10060 is pure IPv6 mismatch.

Recovery 0 already handles the stale-daemon case (clears pid/port/stream files before
re-launching). If Recovery 0 ran but `qcase chrome` still fails, check the Chrome
installation path and run `qcase chrome` manually to see its output.

**"Input redirection is not supported" (Windows)**

Chrome must launch via `Start-Process` (not `&` operator) — avoids inheriting redirected
stdin. `qcase chrome` handles this. agent-browser auto-denies prompts on non-TTY stdin —
do NOT add `< /dev/null` (bash-only; fails in PowerShell/cmd).

**PowerShell syntax in Bash tool**

`if (...) { ... }` is PowerShell — errors in Git-Bash. Use the PowerShell tool or
`powershell -File …` for PS snippets; Bash tool for POSIX one-liners.
