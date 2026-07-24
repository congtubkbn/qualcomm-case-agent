# Automation: one-command capture, scheduled sweeps, local dashboard

Three things live here, in the order you'd adopt them:

1. **`run_case.mjs`** — the whole capture as one command (the token fix).
2. **`scheduler.mjs`** — that command on a schedule, unattended.
3. **`web/server.mjs`** — a localhost dashboard fed by the same cache.

---

## 1. The fast path

```bash
node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
```

It attaches to the persistent-profile Chrome (launching it if the CDP port is dead), opens
`/s/global-search/<CODE>`, resolves the real case URL, expands the Chatter feed, extracts,
finalizes with hash + index, renders and prints the PDF. New-vs-update is decided from the cache,
so there is no mode to pass and nothing to confirm.

stdout is **one JSON line**:

```json
{"code":"08603854","status":"updated","commentCount":11,"newComments":2,
 "newCommentIds":["c1","c2"],"hash":"…","dir":"…/data/cases/08603854","elapsedMs":48210}
```

`status` ∈ `created | updated | no-update | auth-required | not-found | blocked | error`, with
exits `0 | 0 | 0 | 3 | 4 | 5 | 1`. `blocked` is never downgraded to `no-update` — an unchanged
case is a positive finding, and a failed probe is not evidence of one.

### Why this saves tokens

The measured baseline (`OPTIMIZATION_ANALYSIS.md`, flow 1784759542159, case 08603854) was
**123k input tokens** for one case. Almost none of that was analysis:

| Cost centre | Before | After |
|---|---|---|
| Skill activation | 15,592 tok (42,439 B of SKILL.md) | ~4,700 tok (12,789 B — phases moved to `references/manual-flow.md`, loaded only on `blocked`) |
| `snapshot -c` / `-i` dumps to find `@ref`s | dozens; the home-page snapshot alone is ~35k chars ≈ 12k tok | **0** — `find_case_link.js` and `expand_step.js` click inside the page and return counters |
| Click → wait → re-snapshot per "Expand Post" / "View More" | 1 turn each (~15 on a 9-post case) | **0** — one in-page loop |
| Error/retry turns from shell quoting | 5 errors, ~50 s + retry tokens | **0** — Node spawns with an argv array; nothing crosses a shell |
| Reading the pipeline's own scripts to debug | ~3.2k tok | 0 |
| Capture result the model actually reads | whole `case.json` | one ~200-token verdict line |

Capture-side cost lands at roughly **5k tokens** (mostly activation) instead of ~123k. What
remains is the part that genuinely needs a model: reading the comment bodies you are about to
analyze in PHASE 3 — and `--enrich local` removes that too (see `LOCAL_LLM.md`).

The ratio used above (2.72 bytes/token) comes from the measured 15,592 tokens for the 42,439-byte
SKILL.md, so the "~4,700" figure is an extrapolation from a measured point, not a guess — but it
is still an extrapolation. The elimination of the snapshot turns is structural, not estimated:
those tool calls no longer exist in the fast path.

### Three rules that keep it cheap

- **Don't `Read` `case.json` to see what happened.** The verdict line carries the counts, the new
  comment ids and the paths.
- **Don't backfill header fields by editing the raw JSON.** `find_case_link.js` reads
  title/status/priority off the search-results row and `scrape_case.mjs` merges them in code.
- **Don't load `references/manual-flow.md` speculatively.** It exists for `blocked`.

---

## 2. Scheduled sweeps

```bash
node ".claude/skills/qualcomm-case-agent/scripts/scheduler.mjs" --once           # one sweep (cron/Task Scheduler)
node ".claude/skills/qualcomm-case-agent/scripts/scheduler.mjs"                  # resident, checks every minute
node ".claude/skills/qualcomm-case-agent/scripts/scheduler.mjs" --case 08603854  # force one case now
```

`data/watchlist.json` (created on first run, git-ignored — case codes are customer data):

```json
{
  "intervalMinutes": 240,
  "enrich": "local",
  "pdf": true,
  "cases": [
    { "code": "08603854", "enabled": true },
    { "code": "08550063", "enabled": true, "intervalMinutes": 1440 }
  ]
}
```

A sweep runs only the cases whose own interval has elapsed, writes each verdict to
`data/runs.json`, and **stops at the first `auth-required`** — the Okta email OTP is human-only,
so retrying a lapsed session just burns attempts and hides the one fact you need to see.

Register it on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\register_task.ps1 -EveryMinutes 60
powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\register_task.ps1 -Remove
```

The task runs **interactive, as you** — not as SYSTEM. The Chrome profile and the DPAPI-encrypted
password are bound to your user account; a SYSTEM task sees neither. The machine must be logged
in for a sweep to reach the portal.

---

## 3. Dashboard

```bash
node web/server.mjs --scheduler      # http://127.0.0.1:8787, sweeps in the same process
node web/server.mjs --port 9000      # dashboard only
```

Bound to `127.0.0.1` only — the cache is Qualcomm NDA material and must not be reachable from the
network. The page lists every cached case with status, priority, comment count (flagging
captured < displayed), last sync, and the last run verdict; expands to the enrichment (summary,
current status, root cause, open questions, recommended actions) and links `case.html` /
`case.pdf` / `case.md` / `case.txt` plus the portal URL. You can add or remove a watched case and
force a sync from the page. Artifacts are served from a fixed whitelist, so no path outside a
case folder can be requested.

`GET /api/overview` is the same projection as JSON if you want to feed something else.

---

## Under Cline

The fast path is **one `execute_command`**. That matters twice over: it is the cheap path, and it
avoids the twenty-short-commands pattern that kept tripping Cline's shell dispatch (bare
PowerShell running under cmd.exe, `<` redirection, nested quotes — all of `OPTIMIZATION_ANALYSIS.md`
§1/§3). Node spawns `agent-browser` with an argv array, so no JS payload ever crosses a shell.

```
execute_command: node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" 08603854
```

Read the JSON line, then either analyze (PHASE 3) or report. Ask the user something only via
`ask_followup_question` — ACT mode errors a turn that used no tool.

If a capture legitimately runs long, Cline may report the command as timed out and backgrounded;
that is Cline's timeout, not a failure. `data/runs.json` and the dashboard show the real outcome.

---

## Tests

```bash
npm test        # node --test tests/pipeline.test.mjs
```

Covers the pure logic: payload stripping and CLI-output parsing, the update anchor and the
no-update rule (including "a failed probe is never unchanged"), the local-LLM response parsing and
schema coercion, scheduler due-ness, and a dashboard smoke test against a fixture cache. The
browser-driven parts are not covered — they need a real Chrome, a real session and a real case.
