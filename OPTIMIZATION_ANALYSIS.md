# Qualcomm Case Agent Optimization Analysis (corrected)
**Flow Report:** 1784759542159 | **Case:** 08603854 | **Runtime:** 362s (6 min)

**Revision note:** the original version of this doc misdiagnosed the Phase 11 extraction
failure (Section 3) as an "agent-browser writes BOM" bug and prescribed
`Get-Content -Raw | agent-browser eval --stdin` as the fix. That's wrong — it's the exact
command the log already ran (turns 24, 28) and it already failed both times. Root cause was
re-investigated and reproduced live on this machine (not just read from the log) before any
fix was applied. See Section 3 for the corrected root cause and the fix actually shipped.

---

## Executive Summary

**Problems identified:** 5 command errors, PowerShell quoting nightmares, token bloat (123k input),
78s Phase 11 extraction failure, a broken `--stdin` invocation pattern baked into SKILL.md itself.

**Status:** Section 1 (PowerShell wrap) and Section 3 (extraction) fixes are **APPLIED** and
**verified live** against the real scripts + a real case page. Sections 2 and 4 are unverified
estimates, not yet acted on.

---

## 1. PowerShell Quoting/Escaping Hell (5 Errors, 50+ seconds wasted)

### Errors:
| Turn | Error | Cause | Time Lost |
|------|-------|-------|-----------|
| 6 | `Where-Object not recognized` | Bare PowerShell in cmd.exe, no `-Command` wrap | 8s retry |
| 9 | `EMPTY not recognized` | Quote escaping in regex inside `-Command` string | 7s + retry Turn 10 |
| 23 | `< operator reserved` | Bash input redirection `<` in PowerShell | 10s + 2+ retries |
| 29 | UTF-8 decode error | Raw JSON written as UTF-16LE by PowerShell `>`, payload was literal `"null"` | 10s debug |
| 30 | Nested quote syntax | Backslash-escaped `\"` inside a PowerShell `-Command` string (backslash isn't PS's escape char — backtick is) | 10s debug |

### Root cause (corrected):
- **Shell dispatch bug:** the harness's `execute_command` runs bare PowerShell text through
  cmd.exe, not PowerShell — confirmed by turn 6→7 (identical command, wrapped in
  `powershell -NoProfile -Command "..."`, succeeds).
- **String escaping:** nested quotes in a single `-Command` string parse inconsistently
  (turn 30 uses `\"` which is a no-op in PowerShell; the outer string just breaks).
- **`--stdin` is broken under PowerShell on this OS** (see Section 3) — this is the real
  cause of turns 23–30, not a quoting nuance. SKILL.md's own canonical extraction example used
  bash-style `agent-browser eval --stdin < file`, which is why turn 23 tried it verbatim.

### Fixes applied:
1. **Wrap all bare PowerShell in `powershell -NoProfile -Command "..."`.** Unchanged from the
   original analysis — confirmed correct by the log itself (turn 7).
2. **Replace every `agent-browser eval --stdin` invocation with `agent-browser eval -b <base64>`.**
   This is the actual fix (see Section 3) — it also eliminates the turn-30 class of nested-quote
   bug for free, since a base64 payload has no shell metacharacters to escape.

Applied in `SKILL.md` (PHASE 1 readiness poll ×2, Recovery 2 readiness poll, PHASE 2 extraction)
and in the header comments of `scripts/readiness.js` and `scripts/extract_case.js`.

---

## 2. Token Bloat: 123k Input (Should be ~80k)

### Breakdown:
- **Skill activation** (Turn 0): 15,592 tokens (expected ~10k)
- **Readiness.js file reads** (Turns 3, 10): 1,062 + 881 = 1,943 tokens
- **File reads in Phase 12** (Turns 31-32): 1,031 + 2,180 = 3,211 tokens
  - `extract_case.js`: 968 tokens
  - `scrape_case.mjs`: 1,774 tokens
- **PowerShell wrapping repeats**: Each error retry adds 1k-7k tokens

### Correction:
Turns 31–32 (reading `extract_case.js` / `scrape_case.mjs` mid-run) were **not** an independent
inefficiency to guard against — they were the agent debugging the Section 3 root cause it
couldn't see (both scripts turned out to be correct; the bug was in how they were invoked).
With the Section 3 fix applied, there's no error to chase, so these reads don't happen in a
clean run. No separate rule needed here.

### Still open (not yet acted on):
- Skill activation prompt (~15.6k tokens) is verbose. Cutting it to ~8–9k (case code + cache
  check + PHASE 0 pointer, rest inline via reference docs) is a legitimate, separate
  simplification — orthogonal to the bug fixed here.

---

## 3. Phase 11 Extraction (78s, 8 turns, 3 errors) — CORRECTED ROOT CAUSE

### What happened:
- Turn 23: `agent-browser eval --stdin < file` → PowerShell parse error (`<` is reserved)
- Turn 24: switched to `Get-Content -Raw | agent-browser eval --stdin > file` → exit 0, but wrote garbage
- Turn 25: `scrape_case.mjs` rejects the raw file: `raw JSON parse error`
- Turn 26: agent inspects the raw bytes → `\xff\xfen\x00u\x00l\x00l\x00\r\x00\n\x00` (UTF-16LE `"null\r\n"`)
- Turn 28: retries the *exact same* `Get-Content -Raw | eval --stdin > file` command → same result
- Turn 29–30: more debugging, wrong hypotheses (encoding, then inline-eval quoting)
- Turn 31–32: reads `extract_case.js` / `scrape_case.mjs` looking for a script bug — finds none, they're both correct
- Turn 33: gives up, writes `tmp_extract.mjs` as a workaround (violates "no new script" requirement)

### Root cause — verified by live reproduction on this machine, not inferred from the log:

1. **`agent-browser eval --stdin` reliably returns the literal string `"null"` when its stdin
   comes from a PowerShell pipe**, even though the exact same bytes reach a plain `node -e`
   process correctly through the identical pipe (checked by sniffing stdin directly — content
   arrives intact, length and text match). The same script piped from **bash** evaluates
   correctly. This is an agent-browser / Windows-PowerShell-specific stdin-handling bug in the
   native binary, not a bug in `readiness.js`, `extract_case.js`, or the PowerShell pipe
   mechanism itself.
2. **The BOM is a red herring, and the original doc's diagnosis of it was wrong.** It is not
   "agent-browser writes BOM-prefixed UTF-8." The bytes are `FF FE` — a **UTF-16LE** BOM, not a
   UTF-8 BOM (`EF BB BF`). It comes from PowerShell's own `>` redirect operator, which
   BOM-wraps whatever text it's given using the session's default output encoding. Since the
   payload was already the wrong content (`"null"`), the encoding of the file was never the
   actual bug — fixing the encoding alone (as the original Section 3 "solution" proposed) would
   have produced a validly-encoded file containing the string `null`, still useless.
3. **`Get-Content -Raw | agent-browser eval --stdin` — the fix the original doc
   recommended — is not a fix.** It's literally the command turns 24 and 28 already ran, both
   times producing the same broken output. A debugging session that proposes re-running a
   command already proven to fail in the same transcript is a process failure, not a technical
   one — that's why this doc was re-analyzed before touching code.

### Fix applied — verified working end-to-end against the live case page:

Use `agent-browser eval -b <base64>` instead of `--stdin`. This is already agent-browser's own
documented "reliable execution" method (see its `commands.md`: *"Use `-b`/`--base64` or
`--stdin` for reliable execution"* — `--stdin` turns out not to hold that promise on Windows).
Base64 has no shell metacharacters, so it also kills the turn-30 nested-quote bug for free, and
skips stdin plumbing entirely so the PowerShell-pipe bug never comes into play.

```powershell
# Readiness probe (small script, used in a poll loop):
powershell -NoProfile -Command "$b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes('.claude/skills/qualcomm-case-agent/scripts/readiness.js')); for($i=0;$i -lt 6;$i++){ $R = agent-browser eval -b $b64; Write-Output $R; if ($R -match '\"state\":\"(READY|EMPTY|AUTH|BLANK)\"'){break}; agent-browser wait 2000 }"

# Extraction (write result with .NET directly — no shell `>`, no BOM):
powershell -NoProfile -Command "$b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes('.claude/skills/qualcomm-case-agent/scripts/extract_case.js')); $r = agent-browser eval -b $b64; [IO.File]::WriteAllText('data/cases/<CODE>/case.raw.json', $r, (New-Object Text.UTF8Encoding $false))"
```

**Verification performed on this machine** (case 08603854, live persistent Chrome session):
- `readiness.js` via `eval -b` → `{"state":"READY", "url":"...", "title":"Case: 08603854", ...}` — correct object, not `null`.
- `extract_case.js` via `eval -b` → real case JSON (`caseNumber: 08603854`, comments populated).
- `[IO.File]::WriteAllText(..., UTF8Encoding($false))` → first bytes of the written file are
  `{` `space` `space` (0x7B 0x20 0x20) — no BOM (`EF BB BF` or `FF FE`) — confirmed with
  `python -c "..."` `json.load()` parsing it cleanly.

Applied to `SKILL.md` (all 4 `--stdin` call sites) and to the header comments of
`readiness.js` / `extract_case.js` (both previously documented the broken bash-style
`eval --stdin < file` invocation as canonical usage — that's why turn 23 tried it first).

---

## 4. Recovery 1 (Auth Flow) — 95 seconds, 7 turns

### Turns 11-17: Auth required
- Turn 11: Snapshot shows login form (auto-fill works)
- Turn 12-13: Check "Keep signed in" + click Next
- Turn 14-15: Auth gate waits for password/OTP (18s wait in Turn 15)
- Turn 16-17: Retry PHASE 1 open

### Correction — this section's savings estimate is unverified:
The 18s in turn 15 is one chained `click '@e10'; wait 3000; snapshot -i` command. Only 3s of
that is the agent's own `wait`; the remaining ~15s is Okta backend/redirect + page-settle
latency inside a single synchronous tool call the agent doesn't control mid-flight. A tighter
poll loop (as proposed in the original doc, and as already used elsewhere in this same flow —
turns 16-17) changes how *quickly the agent notices* the page is ready, but can't shrink
server-side auth latency it's blocked on inside one call. The "18s → 3s" projection in the
original doc is not grounded in the turn breakdown and should be treated as speculative, not a
committed target.

**Not yet acted on.** If pursued, the credible lever is a pre-PHASE-0 Okta session/cookie
freshness check to avoid entering Recovery 1 at all on some runs — not a faster poll inside it.

---

## 5. "No Script Created" Requirement — Compliance

The goal states: **"không được tạo script mới khi chạy"** (don't create new scripts during run).

**Violation:** Turn 33 created `tmp_extract.mjs` (4,085 tokens) as a workaround after the
Section 3 bug made extraction look unfixable from inside the run.

**Status: fixed as a side effect of Section 3, not as a separate rule.** The workaround script
existed only because `--stdin` was broken and undebuggable turn-by-turn. With `eval -b` as the
canonical extraction path, there's no failure to work around, so there's no motive to create a
throwaway script. The stray `tmp_extract.mjs` left in the repo root from this run has been
deleted.

---

## Status

| Item | Status |
|------|--------|
| Turn 6/7 PowerShell wrap (`-NoProfile -Command`) | Already correct pattern in SKILL.md pre-existing; confirmed, no change needed |
| Turn 23/24/28/30 — `--stdin` → `eval -b` base64 | **Fixed, verified live** |
| BOM-free raw-JSON write | **Fixed, verified live** (`[IO.File]::WriteAllText` + `UTF8Encoding($false)`) |
| Turn 33 — rogue `tmp_extract.mjs` | **Fixed** (root cause removed; stray file deleted) |
| Turns 31-32 — mid-run file reads | Resolved as a consequence of the above, no separate change needed |
| Section 2 — skill activation token bloat (~15.6k) | Not acted on — separate, lower-priority task |
| Section 4 — auth wait (turn 15, 18s) | Not acted on — savings estimate unverified, see correction above |

---

## Reference: Flow Report Links
- **Full report:** `temp/1784759542159/1784759542159_flow_report.md`
- **Error turns:** 6, 9, 23, 29, 30
- **Bottleneck phases:** Phase 11 (extraction, 78s), Phase 3 (auth, 95s)
- **Files changed by this fix:** `.claude/skills/qualcomm-case-agent/SKILL.md`,
  `.claude/skills/qualcomm-case-agent/scripts/readiness.js`,
  `.claude/skills/qualcomm-case-agent/scripts/extract_case.js`
