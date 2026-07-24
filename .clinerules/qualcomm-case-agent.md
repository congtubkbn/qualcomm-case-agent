# Cline rule — Qualcomm case agent

When the user asks to capture / sync / analyze a **Qualcomm case** (e.g. "sync Qualcomm case
CASE-12345", "lấy case qualcomm CASE-12345", "qualcomm case 00123456"), follow the runbook:

**`.claude/skills/qualcomm-case-agent/SKILL.md`**

## The whole capture is ONE execute_command

```
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
```

A valid 8-digit code goes straight to the portal — **do not ask "shall I update?" first**. The
script decides new-vs-update from the cache, signs in with the persistent Chrome profile, expands
the feed, extracts, finalizes, renders and prints the PDF. It prints **one JSON line**:

| `status` | exit | Do this |
|---|---|---|
| `created` / `updated` | 0 | analyze (PHASE 3 — `updated` gives you `newCommentIds`), then report |
| `no-update` | 0 | report "no update since …", stop |
| `auth-required` | 3 | Okta session lapsed → `references/login-flow.md`, human pastes the email OTP, re-run once |
| `not-found` | 4 | wrong code or no access — stop |
| `blocked` | 5 | load `references/manual-flow.md` and finish by hand; `reason` says where it stopped |
| `error` | 1 | fix per `reason` |

`blocked` is never reported as "no update".

**Do not `read_file` the case JSON to see what happened** — the verdict line has the counts, ids
and paths. Read only the comments you are about to analyze. (Capture used to cost ~123k tokens a
case, nearly all of it accessibility-tree snapshots; this command is ~1k. See `docs/AUTOMATION.md`.)

## Rules that still apply

- Use **execute_command** for every `node` / `powershell` line; file tools for read/write.
- All paths are relative to the workspace root. Node resolves the cache from the project root, so
  the command works from any working directory.
- **Do not** use Cline's built-in `browser_action`. This agent drives the standalone
  `agent-browser` CLI against **real Google Chrome over CDP 9222**, with a persistent
  `--user-data-dir` (`data/chrome-profile/`) so the Okta login survives between runs.
  `browser_action` cannot reuse that session.
- Prerequisites (once): Node.js ≥18, `npm i -g agent-browser`, real Google Chrome.
- First login (Okta password + 6-digit **email OTP**) is human-in-the-loop in the visible Chrome
  window. After that the profile persists.
- **Asking the user anything MUST use `ask_followup_question`** — ACT mode errors a turn that
  used no tool.
- A long capture may be reported as timed out and backgrounded. That is Cline's timeout, not a
  failure: check `data/runs.json` or the dashboard for the real outcome.
- Output: `data/cases/<CODE>/` — `case.json` (source of truth) + `case.report.md` + `case.md` /
  `case.html` / `case.txt` / `case.pdf`.

## Beyond one case

- **Scheduled sweeps:** `node .claude/skills/qualcomm-case-agent/scripts/scheduler.mjs --once`,
  driven by `data/watchlist.json`. Windows Task Scheduler: `scripts/register_task.ps1`.
- **Dashboard:** `node web/server.mjs --scheduler` → `http://127.0.0.1:8787`.
- **Local LLM enrichment** (4–7 GB RAM, zero tokens): `scripts/enrich_local.mjs`, or
  `--enrich local` on the capture. See `docs/LOCAL_LLM.md`.
- **Deep analysis without re-scraping:** the sibling skill
  `.claude/skills/qualcomm-enrich/SKILL.md` ("enrich/re-enrich/analyze qualcomm case",
  "phân tích lại / đánh giá case qualcomm").

One case per request. Never type the Qualcomm password or OTP — the user enters those in the browser.
