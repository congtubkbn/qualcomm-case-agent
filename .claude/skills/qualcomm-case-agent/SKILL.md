---
name: qualcomm-case-agent
description: "Qualcomm Case Management Agent. Given ONE Qualcomm case code, drive agent-browser to sign in (Qualcomm ID SSO + email OTP) and extract the COMPLETE case from the Qualcomm Support portal (support.qualcomm.com) — full metadata plus every comment (timestamp, company, author, comment text + full detail, analysis logs/attachments). Enrich as a Qualcomm / Protocol / 3GPP / RF expert engineer: per-comment analysis (role + key points + 3GPP citations + answered/unanswered) plus a case-level overview, analysis flow, root cause, current status, and open questions. Persist to the access-qualcomm project cache newest-first in JSON (machine), Markdown + single-file HTML + TXT + PDF (human review). Deep analysis can also be run/redone standalone via the sibling `qualcomm-enrich` skill (no re-scrape). Incremental: unchanged cases report 'no update'. Triggers: 'qualcomm case <code>', 'pull qualcomm case', 'access qualcomm case', 'lấy case qualcomm', 'phân tích case qualcomm', 'qualcomm case agent', 'extract qualcomm case code'. Use whenever the user provides a Qualcomm case code/number and wants the full case captured and summarized."
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*), Bash(node:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Senior Qualcomm support engineer with deep **Protocol (L1/L2/L3, NAS/RRC)**,
**RF (TX/RX, sensitivity, desense, ACLR, EVM)** and **3GPP** expertise. Given one **case code**,
autonomously retrieve the entire case from the Qualcomm Support portal, analyze it, and produce
engineer-grade artifacts in the local project cache.

**Input contract.** One Qualcomm case code = **exactly 8 digits** (e.g. `08460319`). A leading `CASE-` prefix is accepted and stripped. Anything else → intake fails, ask user, STOP.

**Design principle.** PHASE 0 attaches to the **persistent-profile Chrome** (`data\chrome-profile` on
CDP 9222) *before* any navigation. This is mandatory and non-skippable: if agent-browser is not
explicitly connected to that CDP endpoint, its daemon silently auto-spawns its own throwaway Chrome on
an ephemeral `%TEMP%\agent-browser-chrome-<uuid>` profile — zero cookies, zero Okta session, forcing a
full login + OTP on **every** run. A successful `open` does NOT imply the persistent session is in use.
PHASE 0 is the ~1s insurance that makes the saved session ("Keep me signed in", ~30 days) actually
load, so the common run skips Recovery 1 entirely. Auth (Recovery 1) is still reactive — triggered only
when the *persistent* session has genuinely lapsed.

**Harness-agnostic.** Works under Claude Code, Cline (VS Code), or any agent with terminal + file access.

---

## Configuration

All `data\...` paths are relative to the workspace root (access-qualcomm project = CWD).
Scripts and references live under `.claude\skills\qualcomm-case-agent\` (skill dir).

| Key | Value |
|-----|-------|
| Portal | `https://support.qualcomm.com` |
| SSO | `https://account.qualcomm.com/...` (Okta — identifier-first two-step) |
| Qualcomm ID | `the.thoi@samsung.com` |
| Password store | `data\.secrets\qid.bin` — DPAPI ProtectedData (CurrentUser), git-ignored |
| MFA | **Email OTP** — 6-digit code to Samsung mailbox, expires ~5 min. Always human-pasted |
| Browser | **real Google Chrome** on CDP `9222` via `scripts\connect_chrome.ps1` |
| Session store | `data\chrome-profile\` — persistent `--user-data-dir`; git-ignored |
| Case cache | per-case folder `data\cases\<CODE>\`: `case.json` · `case.report.md` · `case.md` · `case.html` · `case.txt` · `case.pdf` |
| Sync index | `data\cases\_index.json` |
| Scripts | skill dir `scripts\`: `intake.mjs` (Intake guard — validate code + prep dirs), `connect_chrome.ps1`, `okta_login.ps1`, `capture_password.ps1`, `readiness.js` (PHASE 1 readiness probe, run via `eval --stdin`), `extract_case.js` (PHASE 2 extractor, run via `eval --stdin`), `scrape_case.mjs` (finalizer; `--merge` = incremental update run), `render_case.mjs` |
| Enrich skill | `qualcomm-enrich` — standalone analyst pass (no browser, no re-scrape) |
| References | skill dir `references\`: `login-flow.md`, `extraction.md`, `workflow.md`, `consumer-guide.md` |

> Use forward slashes in agent-browser/Node args. Convert `<CODE>` to safe filename (strip `\ / : * ? " < > |`).

---

## Intake (no browser — run first, always)

Before any browser action:

1. **Load agent-browser reference (once per session, not per-case):**
   Invoke the `agent-browser` Skill tool — skip if already loaded this session.
   Only fall back to `agent-browser skills get core --full` when you need the
   full CLI selector reference and the Skill tool is unavailable.

2. **Validate + prep (no browser):** run the bundled intake guard. Trims the
   code, strips an optional `CASE-` prefix, rejects anything that is not exactly
   8 digits, creates `data\cases\`, seeds `data\cases\_index.json = {}` if absent,
   and fails loud on a corrupt index. **Use the 8-digit code it echoes**
   (`intake OK <CODE>`) for all downstream navigation. Regex lives in the script
   (not the command line), so it behaves identically under PowerShell and the Bash tool:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/intake.mjs" "<CODE>"
   ```

3. **Cache check — already saved? Ask before re-pulling (no browser):**
   If `_index.json` has an entry for `<CODE>` and `data/cases/<CODE>/case.json` exists, the case
   was already captured. Do NOT silently re-scrape. Tell the user what is cached and ask:

   > Case `<CODE>` is already saved (synced `<syncedAt>`, N comments). Update it from the portal now?

   Under Claude Code use the AskUserQuestion tool; under Cline use the `ask_followup_question`
   tool (never a bare chat message — Cline's ACT mode requires a tool call every turn, and plain
   text alone will error the turn); under other harnesses use their equivalent ask-user tool.

   | Answer / situation | Action |
   |--------------------|--------|
   | User's request already said update/sync/refresh/re-pull ("update case", "sync lại", "check for new comments") | skip the question → **update run** |
   | User's request already said report-only ("show what we have", "xem lại case") | skip the question → report from cache (PHASE 5 on existing files), STOP — no browser |
   | Asked, user says **yes** | **update run** — PHASE 0 → 1 as usual, then PHASE 1.5B (incremental expand) + PHASE 2 `--merge` |
   | Asked, user says **no** | report from cache, STOP — no browser, no login |

   No index entry → **new case** → full flow (PHASE 0 → 1 → 1.5A full expand → PHASE 2 full finalize).
   Before an update run, read the anchor from the cache (used by PHASE 1.5B):
   ```bash
   node -e "const j=JSON.parse(require('fs').readFileSync('data/cases/<CODE>/case.json','utf8')); const c=j.comments[0]; console.log(JSON.stringify({displayed:j.displayedCommentCount, cachedCount:j.comments.length, newestAuthor:c.author, newestBodyStart:c.body.replace(/\s+/g,' ').slice(0,80), syncedAt:j.extractedAt}))"
   ```

---

## PHASE 0 — Attach to persistent-profile Chrome *(mandatory, before any navigation)*

**Goal:** guarantee agent-browser is driving the **`data\chrome-profile`** Chrome on CDP 9222 — the only
browser that carries the saved Okta session. Skipping this is the root cause of "logs in every run":
the daemon otherwise auto-spawns a temp-profile Chrome and `open` succeeds against an empty session.

```powershell
# Launch (or reuse) real Chrome on CDP 9222 bound to the persistent profile.
# Idempotent: if 9222 is already listening it just prints the ws:// URL and exits 0.
powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"
```

```bash
# Attach to the ws:// URL the helper printed (NOT bare `connect 9222` — IPv6 ::1 mismatch → 10060).
agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
```

> **Slow / harness timeout is normal, not a bug.** Chrome cold-start + CDP handshake can exceed a
> host tool's default command timeout (e.g. Cline's `execute_command` ~30s). If the harness reports
> "timed out, running in background" — that is the *harness's* timeout, not `agent-browser`'s. Do
> NOT treat it as a failure or retry Recovery 0. Just proceed to the verify step below; if it reports
> connected, the background run already succeeded.

**Verify the right profile is attached** (cheap guard — catches a stale temp-profile daemon):

```bash
agent-browser eval "(function(){ return new URL(location.href).hostname; })()"   # any value = connected OK
```
```powershell
# Confirm the CDP-9222 Chrome uses the persistent --user-data-dir, not a %TEMP% throwaway.
# NOTE: a single Chrome launch has many chrome.exe subprocesses (renderer/GPU/utility) that all
# inherit --remote-debugging-port=9222 on their command line — that is normal, not multiple
# instances. Reduce to ONE verdict line so the agent doesn't have to scan N near-identical lines:
$procs = Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.CommandLine -match '--remote-debugging-port=9222' }
if ($procs | Where-Object { $_.CommandLine -match 'agent-browser-chrome-' }) {
  Write-Host 'WRONG: attached to TEMP profile — run Recovery 0 to reset daemon, then re-attach'
} elseif ($procs) {
  Write-Host 'OK: persistent profile attached'
} else {
  Write-Host 'WRONG: no chrome.exe on 9222 — run Recovery 0'
}
```

If the guard prints `WRONG` (or 9222 never came up) → **[Recovery 0]** to reset the daemon, then redo PHASE 0 ONCE.

---

## PHASE 1 — Locate Case *(entry point)*

**Goal:** open the exact case page and capture its real URL. PHASE 0 has already attached the
persistent-profile Chrome, so the common path (valid saved session) goes straight through with one `open`.

```bash
agent-browser open "https://support.qualcomm.com/s/global-search/<CODE>"
```

**If `open` itself errors / times out** → **[Recovery 0: Chrome/CDP]**, redo PHASE 0, then retry PHASE 1 ONCE.

**Otherwise poll for readiness — do NOT blind-`wait` then snapshot.** The portal is a
Salesforce Lightning SPA: right after `open`, the accessibility tree can be empty while the DOM
is still hydrating. A bare `snapshot -c` returning `(empty page)` does NOT mean "no results" — it
conflates *loading*, *zero-results*, *auth-bounce*, and *dead-blank*. The `readiness.js` probe
classifies them into one `state` field (runs `eval --stdin`; regex + selectors live in the file to
avoid Bash/PowerShell quote-hell):

```bash
# poll readiness on the SAME url, max 6 rounds x 2s = 12s ceiling
for i in 1 2 3 4 5 6; do
  R=$(agent-browser eval --stdin < .claude/skills/qualcomm-case-agent/scripts/readiness.js)
  echo "$R"
  echo "$R" | grep -q '"state":"READY"' && break   # → continue (click result)
  echo "$R" | grep -q '"state":"EMPTY"' && break   # → STOP: wrong code / no access
  echo "$R" | grep -q '"state":"AUTH"'  && break   # → Recovery 1
  echo "$R" | grep -q '"state":"BLANK"' && break   # → Recovery 2
  agent-browser wait 2000
done
```

**Interpret the final `state`:**

| `state` | Meaning | Action |
|---------|---------|--------|
| `READY` | search-result rows present | continue below ↓ |
| `AUTH` | bounced to `account.qualcomm.com` | → **[Recovery 1: Auth]** then retry PHASE 1 ONCE |
| `EMPTY` | load finished, genuinely zero results | **STOP** — code wrong or no access |
| `BLANK` | DOM essentially empty (dead/blank page) | → **[Recovery 2: Empty/Stuck Page]** ONCE |
| `LOADING` after 6 rounds | never hydrated within 12s | → **[Recovery 2: Empty/Stuck Page]** ONCE |

If the retry after Recovery 0 / 1 / 2 still fails → report the final probe `{state,url,host,nodes,rows,title}` and STOP.

**On `READY` — navigate into case:**

```bash
agent-browser snapshot -c          # rows are loaded now — read search results
# click the result matching <CODE> (use the @ref)
agent-browser eval --stdin < .claude/skills/qualcomm-case-agent/scripts/readiness.js   # re-probe after click
# state=AUTH → Recovery 1 → retry click ONCE; state=READY/other → proceed
agent-browser eval "(function(){ return location.href; })()"   # capture the real case URL
```

Store the captured URL as `url` in the case JSON.

> **Do NOT guess alternate URLs.** `/s/case/<CODE>` is always a bad route — the case page needs a
> Salesforce 18-char record id (`<SFID>`), obtainable ONLY by clicking the search result, never built
> from the case number. See the **URL discipline** guardrail.

---

## Recovery 0 — Chrome/CDP Not Available

Run when `agent-browser open` errors or times out. The daemon may have a stale PID pointing at a
dead Chrome — clean that up first, then launch fresh:

```powershell
# 1. Clear any stale daemon state (safe: path-filtered, never touches user's personal Chrome)
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -like "*\.agent-browser\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process agent-browser-win32-x64 -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "$env:USERPROFILE\.agent-browser\default.pid",
            "$env:USERPROFILE\.agent-browser\default.port",
            "$env:USERPROFILE\.agent-browser\default.stream" -Force -ErrorAction SilentlyContinue
```

```bash
# 2. Launch real Chrome + attach (idempotent: reuses CDP 9222 if already up after cleanup)
powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"
# The helper prints the exact ws:// connect command — run it:
#   agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
# Do NOT use bare `connect 9222` — Windows resolves localhost to IPv6 ::1, Chrome binds IPv4 only → timeout
```

After attaching, retry PHASE 1 once. If `open` errors again → report and STOP.

**Why real Chrome?** The bundled Playwright Chromium can ship a broken build whose CDP handshake
times out on every `open`. Real Chrome is stable and OS-trusted. See Troubleshooting if needed.

---

## Recovery 1 — Auth Required

Run when PHASE 1 `open` or a post-click navigation shows `account.qualcomm.com`. Full flow +
failure handling: **`references\login-flow.md`**.

The session is stored in `data\chrome-profile\` (persistent `--user-data-dir`). When valid, no
login or OTP is needed. This recovery only triggers when the Okta session token has lapsed.

**Step 1 — Try profile auto-fill first (preferred, no script needed) — MANDATORY, do not skip to OTP**

Chrome password manager pre-fills credentials when the profile is intact. Just click through.
**Do NOT ask the user for an OTP before completing every sub-step below** — the OTP screen may
never appear if "Keep me signed in" restores the session at the Verify step:

```bash
agent-browser snapshot -i
# Expected: textbox "Username" pre-filled with the.thoi@samsung.com
# Check "Keep me signed in" to extend session duration (~30 days):
agent-browser check @<keep-me-signed-in-ref>
agent-browser click @<next-ref>
agent-browser wait 3000
agent-browser snapshot -i
# Expected: textbox "Password" pre-filled (shown as ••••••••)
agent-browser click @<verify-ref>
agent-browser wait 5000
agent-browser snapshot -i
```

Only once this snapshot shows an OTP screen (or Step 1 failed per the decision table) is asking
the user for anything justified. A username-only snapshot is NOT a stopping point.

**Decision after Verify click:**

| Outcome | Signal | Action |
|---------|--------|--------|
| Dashboard loads | nav shows Cases/Projects links | session established → retry PHASE 1 |
| OTP screen appears | heading "Enter a verification code" | go to Step 3 (OTP) |
| Still on password screen / error | password field still visible, error text | → Step 2 (okta_login.ps1) |
| Username NOT pre-filled | blank textbox | → Step 2 (okta_login.ps1) |

**Step 2 — Fallback: okta_login.ps1 (only if Step 1 failed)**

`data\.secrets\qid.bin` exists → run the DPAPI-decrypted two-step helper:
```bash
powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/okta_login.ps1"
```

`qid.bin` missing → ask user to run in a **real PowerShell terminal** (NOT cmd, NOT chat):
```
powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\capture_password.ps1
```
Wait for "Saved … bytes", then run `okta_login.ps1`.

After okta_login.ps1, check snapshot again with the same decision table above.

**Step 3 — OTP (only if presented)**

Drive OTP screens by snapshot: **"Send me an email"** → **"Enter a verification code instead"** →
then ask the user for the 6-digit code via the harness's ask-user tool (AskUserQuestion / Cline
`ask_followup_question` — see Intake step 3; never a bare chat message) → **"Verify"**. Selectors
in `references\login-flow.md`.

**Failure table:**

| Situation | Action |
|-----------|--------|
| Wrong password (never advanced past password screen) | delete `qid.bin`; ask user to re-run capture script; retry ONCE. Fails again → STOP. |
| OTP rejected/expired | OTP problem — do NOT delete `qid.bin`. User requests fresh code and re-pastes. |
| Email unavailable + session expired | cannot authenticate — report and STOP. |

**Never** echo the password or OTP. The only durable secret is `qid.bin` (DPAPI-encrypted).

> **Why "Keep me signed in":** Okta default session is ~2h; checking this box extends to ~30 days,
> dramatically reducing how often Recovery 1 triggers. Always check it when the checkbox is present.

---

## Recovery 2 — Empty/Stuck Page

Run when PHASE 1 polling ends in `state=BLANK`, or `state=LOADING` after the 6-round (12s) ceiling —
the page is on the right URL but never rendered results. **Diagnose in place; never navigate to a
guessed URL.** Runs at most ONCE.

```bash
# 1. Auth bounce that the probe's host check may have raced? Re-confirm host directly.
agent-browser eval "(function(){ return location.hostname; })()"
#    = account.qualcomm.com → go to Recovery 1 (Auth) instead.

# 2. Reload the SAME url once (transient SPA hydration failure), then re-poll readiness.
agent-browser open "https://support.qualcomm.com/s/global-search/<CODE>"   # SAME link — not a different route
for i in 1 2 3 4 5 6; do
  R=$(agent-browser eval --stdin < .claude/skills/qualcomm-case-agent/scripts/readiness.js)
  echo "$R"
  echo "$R" | grep -qE '"state":"(READY|EMPTY|AUTH)"' && break
  agent-browser wait 2000
done
```

Decision after the reload poll:

| Result | Action |
|--------|--------|
| `READY` | recovered → return to PHASE 1 (click the result) |
| `EMPTY` | genuinely zero results → STOP (wrong code / no access) |
| `AUTH` | → Recovery 1 |
| still `BLANK`/`LOADING` | portal down or render broken → **STOP**, report final probe `{state,url,host,nodes,rows,title}` |

**Hard ceiling:** Recovery 2 runs once. Do not loop it, do not escalate to other URLs. A persistently
blank page is reported, not worked around.

---

## PHASE 1.5 — DOM Expansion *(run before extraction)*

**Goal:** ensure the DOM content needed for extraction is visible. The Salesforce Chatter feed hides
data behind pagination and collapsed bodies. These are `agent-browser click` steps — the accessibility
tree exposes them as named controls, no JS eval needed. **This is the only expansion step** — PHASE 2
extracts from the DOM exactly as this phase leaves it; nothing re-opens or re-expands the page.

Two variants: **1.5A (full)** for a new case — expand everything; **1.5B (incremental)** for an
update run on a cached case — expand only down to the newest cached comment.

### PHASE 1.5A — Full expansion (new case)

**Step A — Pagination: click "View More Posts" until gone**

```bash
agent-browser snapshot -i   # look for button/link with text matching "View More"
# while visible:
agent-browser click @<ref>  # click it
agent-browser wait 2000
agent-browser snapshot -i   # re-check; stop when button absent
```

The button appears as `button "View More Posts"` or `button "View More"` near the bottom of the Feed
region. Repeat until it no longer appears in the snapshot.

**Step B — Expand all "Expand Post" links**

After all posts are loaded, collect every `link "Expand Post"` ref and click each:

```bash
agent-browser snapshot -c | grep "Expand Post"  # identify refs (e.g. e107, e110, e115, e118, e128)
agent-browser click @<ref1> && agent-browser wait 1000
agent-browser click @<ref2> && agent-browser wait 1000
# ... repeat for all refs
agent-browser snapshot -c | grep "Expand Post"  # confirm: no remaining "Expand Post" links
```

Note: nested Chatter comments (sub-articles inside a listitem) also have their own "Expand Post" — include them.

**Step C — Expand "Description" section if collapsed**

```bash
# In the snapshot look for: button "Description" [expanded=false]
# If found:
agent-browser click @<description-ref>
agent-browser wait 1000
```

**Confirm DOM complete:**

```bash
agent-browser snapshot -c | grep -E "Expand Post|View More"
# Expected output: (empty) — proceed to PHASE 2
```

> **Lesson from case 08550063 (2026-06-22):** 8 posts initially visible, "View More Posts" clicked once
> to reveal 9th post. 6 "Expand Post" links across posts + 1 nested comment. Description was
> collapsed. All resolved by sequential click → wait → verify.

### PHASE 1.5B — Incremental expansion (update run on a cached case)

Full expansion re-loads and re-expands every old post just to throw the bytes away in the merge.
On an update run, the newest CACHED comment (the **anchor** from the Intake cache check —
`newestAuthor` + `newestBodyStart`) is the stop line:

**Step 0 — Fast no-update probe** (first snapshot, before any clicking):

```bash
agent-browser snapshot -c   # read: `status "N Chatter Feed Items"` + the top post
```

If **N equals** the cached `displayed` AND the **top post matches the anchor** (same author, body
starts with `newestBodyStart`) → nothing new → report **"no update since `<syncedAt>`"** and STOP
(skip PHASE 2 entirely).

> Caveat: a new nested reply under an old post does not move the top post and may not change N.
> If the user says there IS an update (they saw a notification), skip this probe and run Steps 1–2 —
> the `--merge` finalize is the definitive check.

**Step 1 — Paginate only until the anchor is visible.** Click "View More Posts" and re-snapshot;
STOP clicking as soon as a post matching the anchor appears. Do NOT paginate to the end of the feed.

**Step 2 — Expand only the NEW posts.** Click "Expand Post" only on posts ABOVE the anchor
(and their nested replies). Old posts stay collapsed — the merge dedupes their truncated bodies
away and keeps the cached verbatim ones. Description is already cached → do not re-expand.

**Confirm:** every post above the anchor shows no remaining "Expand Post". Then PHASE 2 with `--merge`.

---

## PHASE 2 — Extract *(agent-driven)*

**Goal:** extract all raw case data from the **already-expanded live DOM** (no re-open, no re-expand),
then finalize to `data/cases/<CODE>/case.json` (+ root `_index.json`).

> **Layout:** every artifact for a case lives in its own folder `data/cases/<CODE>/` —
> `case.json` (source of truth) · `case.report.md` · `case.md` · `case.html` · `case.txt` · `case.pdf`.
> Only `_index.json` (the cross-case sync index) sits at `data/cases/` root.

Full reference: **`references\extraction.md`** (the three eval rules + selector lock-in table).

1. Read existing `_index.json` to get the old hash for `<CODE>` (incremental check).
2. Confirm expansion done. **Full run:** `agent-browser snapshot -c | grep -E "Expand Post|View More"`
   → empty. **Update run:** leftovers are EXPECTED on old posts below the anchor — only confirm the
   posts above the anchor are expanded (PHASE 1.5B).
3. Make the case folder, then run the bundled extractor via `--stdin` (multi-line JS reaches the browser
   intact) and redirect the result into the folder's raw scratch file. The script returns the OBJECT
   (agent-browser serializes it once — do NOT `JSON.stringify` inside, that double-encodes; and the
   shell `>` avoids the PowerShell BOM):
   ```bash
   mkdir -p data/cases/<CODE>
   agent-browser eval --stdin < .claude/skills/qualcomm-case-agent/scripts/extract_case.js \
     > data/cases/<CODE>/case.raw.json
   ```
   If the live DOM differs and fields come back empty, edit `extract_case.js` in place (it is the
   canonical extractor, not a throwaway). Header fields (title/status/priority) aren't on the Feed view —
   pass them to `scrape_case.mjs` as flags (next step). **Do NOT Read+Edit `case.raw.json` to backfill
   the title** — that re-ingests every comment body to set 3 fields; let the script merge them in code.
4. Sanity-check, then finalize (rejects 0 comments → assert count → backfill header flags → SHA-256
   hash → write JSON + index). Pass the title/status/priority you already hold from the PHASE 1 search
   row as flags — the script fills them only where the Feed extractor left them blank:
   ```bash
   node -e "const j=JSON.parse(require('fs').readFileSync('data/cases/<CODE>/case.raw.json','utf8')); console.log(j.caseNumber, j.comments.length, j.displayedCommentCount)"
   node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE> "data/cases/<CODE>/case.raw.json" --title "<TITLE>" --status "<STATUS>" --priority "<PRIORITY>"
   ```
   On exit 0, delete the `case.raw.json` scratch file.

   **Update run — finalize with `--merge` instead.** The raw file is a PARTIAL capture (new posts
   fully expanded, old posts possibly collapsed/truncated). Run the SAME extractor, then:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE> "data/cases/<CODE>/case.raw.json" --merge --status "<STATUS>" --priority "<PRIORITY>"
   ```
   The script keeps every cached comment (bodies, logs, timestamps) VERBATIM, prepends only comments
   not already cached (dedup: author + normalized body prefix — relative-timestamp drift and
   collapsed truncation don't break it), preserves `enrichment` untouched, refreshes
   `url`/`displayedCommentCount`, lets fresh `--status`/`--priority` flags override the cache
   (they're the current truth from the PHASE 1 row), and recomputes the hash. `--title` is not
   needed — the cached title survives. Branch on the emitted JSON:

   | Emitted (exit 0, merge) | Meaning | Action |
   |------------------------|---------|--------|
   | `newComments > 0` | new comments merged (ids in `newCommentIds`) | PHASE 3 (enrich ONLY those ids) → PHASE 4 |
   | `newComments: 0, headerChanged: true` | no new comments, but status/priority changed | skip PHASE 3 → PHASE 4 (re-render outputs) |
   | `newComments: 0, headerChanged: false, changed: false` | nothing new | report "no update since `<syncedAt>`", STOP |

**Exit codes:**

| Code | Meaning | Action |
|------|---------|--------|
| 0 | OK | Full run: compare new hash vs old — identical → "No update since `<syncedAt>`", STOP; changed → PHASE 3. Update run: branch on `newComments`/`headerChanged` (table above). |
| 2 | Bad args / bad raw JSON / `--merge` without a cached `case.json` | Fix invocation; ensure `raw.comments` is an array (clean single-encoded JSON, no BOM). `--merge` without cache → run a full extraction instead. |
| 5 | Incomplete — 0 comments, or merged/captured `comments.length < displayedCommentCount` | 0 comments = wrong page / session lapsed / Feed not loaded → re-check you're on the case page, finish PHASE 1.5, re-extract. Short = expand more (update run: paginate further past the anchor) or, if virtualized, progressive extraction (extraction.md). STOP if still 5. |

Auth redirect / "case not found" are caught earlier by the PHASE 1 hostname guard — PHASE 2 no longer
navigates, so it never re-triggers them.

---

## PHASE 3 — Enrich

**Trigger:** PHASE 2 exit 0 AND hash changed (update run: `newComments > 0` — the ids to analyze
are handed to you in `newCommentIds`; header-only changes skip straight to PHASE 4).
**Delegation:** same work as standalone `qualcomm-enrich` skill. Hand off to it or run inline — both use the same schema and `render_case.mjs`.

**Goal:** engineer-grade per-comment analysis + case-level synthesis in `data.enrichment`. Raw fields and `hash` are NEVER mutated.

**Incremental logic:**

1. Read `data/cases/<CODE>/case.json`.
2. New comment ids = those in `raw.comments[].id` NOT yet in `enrichment.commentAnalyses`.
3. Per new comment → analysis object:
   - `summary` (2–4 sentences), `role` (Symptom/Question/Hypothesis/Data-Log/Analysis/Request/Resolution/Info),
     `keyPoints[]` (band/EARFCN, dBm, ms, QXDM/error codes), `citations[]` (exact 3GPP clause e.g. `TS 38.331 §5.3.7`),
     `answered` (false if Question/Request has no later resolving comment).
   - Thin comment → `summary: "Insufficient detail"`.
4. Re-generate case-level fields from ALL comments:
   - `engineerSummary` (5–8 sentences), `currentStatus` (1–2 sentences), `rootCause` (hypothesis + reasoning or `"Unresolved"`),
     `caseFlow[]` (debug narrative oldest→newest: `{step, phase, date, by, what, refComments[]}`),
     `openQuestions[]`, `recommendedActions[]`, `tags[]`, `timeline[]` newest-first.
5. Write back to JSON under `enrichment` key. Update `_index.json["<CODE>"].enrichedAt`.

```json
{
  "enrichment": {
    "engineerSummary": "...", "currentStatus": "...", "rootCause": "...",
    "caseFlow": [{ "step": 1, "phase": "Symptom", "date": "...", "by": "...", "what": "...", "refComments": ["<id>"] }],
    "openQuestions": ["..."], "recommendedActions": ["..."], "tags": ["..."],
    "timeline": [{ "date": "...", "event": "..." }],
    "commentAnalyses": { "<id>": { "summary": "...", "role": "...", "keyPoints": ["..."], "citations": ["..."], "answered": false } },
    "enrichedAt": "<ISO-8601>"
  }
}
```

(Older caches: flat `commentSummaries: { <id>: string }` — renderer reads both; new runs write `commentAnalyses`.)

**Re-enrich** (keywords: "re-enrich", "redo analysis", "improve summary"): ask for optional custom prompt; re-run Stage 2. Case-level always re-generated; only new comment ids added to `commentAnalyses`. Or hand off to `qualcomm-enrich`.

**Rule:** analyses interpret source data only — never add facts absent from the case.

---

## PHASE 4 — Persist

All artifacts go in the case folder `data\cases\<CODE>\` (created by `scrape_case.mjs` in PHASE 2).

1. **`data\cases\<CODE>\case.json`** — full object (source of truth), comments newest-first:
   ```
   { caseNumber, title, status, priority, severity, product, customer, created, updated,
     description, url, displayedCommentCount, commentCount, hash, extractedAt,
     comments: [{ id, timestamp, company, author, role, body, analysisLog[], attachments[] }],
     enrichment?: { engineerSummary, currentStatus, rootCause, caseFlow[], openQuestions[],
                    recommendedActions[], tags[], timeline[],
                    commentAnalyses: { <id>: { summary, role, keyPoints[], citations[], answered } },
                    enrichedAt } }
   ```

2. **Render files** (output dir + stem follow the input path → all written beside `case.json`):
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/render_case.mjs" "data/cases/<CODE>/case.json"
   ```
   Writes: `case.report.md` (concise summary, ⚠ if captured < displayed), `case.md` + `case.html` + `case.txt` (full verbatim).

3. **PDF (mandatory)** — Chrome is always attached (PHASE 0 is non-skippable), so the PDF is a
   required artifact, NOT optional. On Windows, build the `file://` URL from the Windows path
   (`pwd -W`); a bare `$(pwd)` is Git-bash `/e/...` → Chrome `ERR_FILE_NOT_FOUND`:
   ```bash
   agent-browser open "file:///$(pwd -W)/data/cases/<CODE>/case.html"
   agent-browser pdf "data/cases/<CODE>/case.pdf"
   ```
   **Verify it landed** — `case.pdf` must exist and be non-zero before PHASE 4 is done:
   ```bash
   test -s "data/cases/<CODE>/case.pdf" && echo "PDF OK" || echo "PDF MISSING — retry"
   ```
   If missing: the `file://` URL was malformed (re-check `pwd -W`) or Chrome lost its attach
   (→ **[Recovery 0]**, re-attach, redo this step). Only after two failed attempts may PHASE 4
   finish without it — and then PHASE 5 must report the PDF as failed, not silently omit it.

4. **Update `_index.json`** (at `data/cases/` root): `"<CODE>": { "syncedAt": "<ISO>", "commentCount": N, "hash": "<sha256>" }`.

---

## PHASE 5 — Report

Tell the user: case number + title + status, comments captured **vs displayed** (update run: **how
many NEW comments were merged**, or **"no update"**),
current status, root cause, # open questions, top recommended actions, file paths
(`data/cases/<CODE>/`: `case.json` · `case.report.md` · `case.html` · `case.txt` · `case.pdf`). Attach `case.report.md` and `case.html`. If the PDF failed both attempts (PHASE 4 step 3), say so explicitly — never drop it from the list silently.

---

## Agent Guardrails

- **Load agent-browser reference first** before any browser action.
- **Session = persistent Chrome profile** at `data\chrome-profile`. Never close between phases. The profile persists across all phases and runs — Chrome closed unexpectedly → Recovery 0 on next action.
- **URL discipline.** PHASE 1 `open`s exactly ONE url: `/s/global-search/<CODE>`. Once `location.href` confirms you are on it, **never `open` a different URL to "try"**. The real case URL is `/s/case/<SFID>/<slug>` where `<SFID>` is a Salesforce 18-char record id obtainable ONLY by clicking the search result — **never** construct `/s/case/<case-number>` (always a bad route). A blank/empty page is diagnosed in place (poll → Recovery 2), not escaped by navigating elsewhere.
- **Secrets:** `qid.bin` (DPAPI, CurrentUser) is the only durable password copy. Never in chat, outputs, or plaintext. OTP never stored.
- **Confidentiality:** case content is Qualcomm NDA. Keep in `data\cases\` (git-ignored). Never paste to external services.
- **Fidelity:** capture comment bodies and logs VERBATIM. Never truncate. Analyses are a separate field.
- **No fabrication:** absent field/URL/log → say so.
- **Incremental:** cached case → ASK the user before re-pulling (Intake cache check) unless their
  request already decided it. Update run = PHASE 1.5B + `--merge`: only the NEW comments are
  expanded, extracted and enriched — cached comments, logs and `enrichment` are never re-fetched or
  rewritten; outputs are re-rendered from the merged `case.json`. Unchanged case → "no update".
- **Scope:** one case per invocation.
- **ToS:** extract only cases the signed-in account is authorized to view.

---

## Running Under Other Agents (Cline / VS Code)

Cline auto-reads `.clinerules/qualcomm-case-agent.md`. Use `execute_command` for every `powershell`/`agent-browser`/`node` line. Do NOT use Cline's `browser_action` — this skill attaches to real Chrome over CDP.

**Asking the user anything (OTP, cache-check yes/no) MUST use the `ask_followup_question` tool.**
Cline's ACT mode requires a tool call on every turn — a plain assistant text reply with no tool
use errors the turn (`"You did not use a tool in your previous response!"`) and drops the task.
Printing the question as chat text and waiting is not sufficient; call `ask_followup_question`.

---

## Setup on New Windows Machine

1. Install Node.js (≥18) + `npm i -g agent-browser`. Install real Google Chrome (bundled Chromium not needed).
2. Copy project folder — skill travels in `.claude/skills/qualcomm-case-agent/`.
3. Do NOT copy `data/chrome-profile/`, `data/.secrets/`, `data/cases/` — DPAPI `qid.bin` is machine/user-bound. All git-ignored.
4. First run: try PHASE 1 → Recovery 0 launches Chrome → Recovery 1 handles first login + OTP + DPAPI capture. Run `capture_password.ps1` in a real PowerShell terminal (needs interactive `Read-Host`).

---

## Troubleshooting

**`os error 10060` on `agent-browser connect 9222`**

`connect 9222` uses `http://localhost:9222`. Windows resolves `localhost` to IPv6 `::1` first; Chrome binds only IPv4 `127.0.0.1`. Fix: use the explicit ws:// URL from `connect_chrome.ps1` output:
```bash
agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
```
Diagnose: `curl -s http://127.0.0.1:9222/json/version` → HTTP 200 means Chrome is fine; 10060 is pure IPv6 mismatch.

Recovery 0 already handles the stale-daemon case (clears pid/port/stream files before re-launching). If Recovery 0 ran but `connect_chrome.ps1` still fails, check Chrome installation path and run the script manually to see its output.

**"Input redirection is not supported" (Windows)**

Chrome must launch via `Start-Process` (not `&` operator) — avoids inheriting redirected stdin. `connect_chrome.ps1` handles this. agent-browser auto-denies prompts on non-TTY stdin — do NOT add `< /dev/null` (bash-only; fails in PowerShell/cmd).

**PowerShell syntax in Bash tool**

`if (...) { ... }` is PowerShell — errors in Git-Bash. Use PowerShell tool or `powershell -File …` for PS snippets; Bash tool for POSIX one-liners.
