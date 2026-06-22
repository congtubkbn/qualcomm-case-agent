---
name: qualcomm-case-agent
description: "Qualcomm Case Management Agent. Given ONE Qualcomm case code, drive agent-browser to sign in (Qualcomm ID SSO + email OTP) and extract the COMPLETE case from the Qualcomm Support portal (support.qualcomm.com) — full metadata plus every comment (timestamp, company, author, comment text + full detail, analysis logs/attachments). Enrich as a Qualcomm / Protocol / 3GPP / RF expert engineer: per-comment analysis (role + key points + 3GPP citations + answered/unanswered) plus a case-level overview, analysis flow, root cause, current status, and open questions. Persist to the access-qualcomm project cache newest-first in JSON (machine), Markdown + single-file HTML + TXT (human review), and optional PDF. Deep analysis can also be run/redone standalone via the sibling `qualcomm-enrich` skill (no re-scrape). Incremental: unchanged cases report 'no update'. Triggers: 'qualcomm case <code>', 'pull qualcomm case', 'access qualcomm case', 'lấy case qualcomm', 'phân tích case qualcomm', 'qualcomm case agent', 'extract qualcomm case code'. Use whenever the user provides a Qualcomm case code/number and wants the full case captured and summarized."
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*), Bash(node:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Senior Qualcomm support engineer with deep **Protocol (L1/L2/L3, NAS/RRC)**,
**RF (TX/RX, sensitivity, desense, ACLR, EVM)** and **3GPP** expertise. Given one **case code**,
autonomously retrieve the entire case from the Qualcomm Support portal, analyze it, and produce
engineer-grade artifacts in the local project cache.

**Input contract.** One Qualcomm case code (e.g. `CASE-01234567`, `00123456`, or numeric id). Missing → ask user, STOP.

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
| Case cache | `data\cases\<CODE>.json` · `<CODE>.report.md` · `<CODE>.md` · `<CODE>.html` · `<CODE>.txt` · `<CODE>.pdf` (optional) |
| Sync index | `data\cases\_index.json` |
| Scripts | skill dir `scripts\`: `connect_chrome.ps1`, `okta_login.ps1`, `capture_password.ps1`, `extract_case.js` (PHASE 2 extractor, run via `eval --stdin`), `scrape_case.mjs` (finalizer), `render_case.mjs` |
| Enrich skill | `qualcomm-enrich` — standalone analyst pass (no browser, no re-scrape) |
| References | skill dir `references\`: `login-flow.md`, `extraction.md`, `workflow.md`, `consumer-guide.md` |

> Use forward slashes in agent-browser/Node args. Convert `<CODE>` to safe filename (strip `\ / : * ? " < > |`).

---

## Intake (no browser — run first, always)

Before any browser action:

1. **Load agent-browser reference:**
   ```bash
   agent-browser skills get core --full
   ```
   (Claude Code: also invoke the `agent-browser` Skill tool.)

2. **Validate + normalize case code:** trim, reject path-illegal chars `\ / : * ? " < > |`.

3. **Prepare cache dirs:** ensure `data\cases\` exists; create `data\cases\_index.json = {}` if absent.

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

**Verify the right profile is attached** (cheap guard — catches a stale temp-profile daemon):

```bash
agent-browser eval "return new URL(location.href).hostname"   # any value = connected OK
```
```powershell
# Confirm the CDP-9222 Chrome uses the persistent --user-data-dir, not a %TEMP% throwaway:
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.CommandLine -match '--remote-debugging-port=9222' } |
  ForEach-Object { if ($_.CommandLine -match 'agent-browser-chrome-') {
    Write-Host 'WRONG: attached to TEMP profile — run Recovery 0 to reset daemon, then re-attach' }
    else { Write-Host 'OK: persistent profile attached' } }
```

If the guard prints `WRONG` (or 9222 never came up) → **[Recovery 0]** to reset the daemon, then redo PHASE 0 ONCE.

---

## PHASE 1 — Locate Case *(entry point)*

**Goal:** open the exact case page and capture its real URL. PHASE 0 has already attached the
persistent-profile Chrome, so the common path (valid saved session) goes straight through with one `open`.

```bash
agent-browser open "https://support.qualcomm.com/s/global-search/<CODE>"
```

**Interpret the result:**

| Outcome | Signal | Action |
|---------|--------|--------|
| Command errors / times out | CDP dropped since PHASE 0 | → **[Recovery 0: Chrome/CDP]**, redo PHASE 0, then retry PHASE 1 ONCE |
| Opens but snapshot shows `account.qualcomm.com` | persistent session genuinely lapsed | → **[Recovery 1: Auth]** then retry PHASE 1 ONCE |
| Opens, shows search results | Chrome + session OK | continue below ↓ |

If the retry after Recovery 0 or Recovery 1 still fails → report the specific error and STOP.

**On success — navigate into case:**

```bash
agent-browser wait 2000
agent-browser snapshot -c          # read search results
# click the result matching <CODE> (use the @ref)
agent-browser wait 2000
agent-browser eval "return location.hostname"   # guard: confirm not redirected to login
# if hostname = "account.qualcomm.com" → Recovery 1 → retry click ONCE
agent-browser eval "return location.href"       # capture the real case URL
```

Store the captured URL as `url` in the case JSON. Zero results for `<CODE>` → code wrong or no access, STOP.

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

**Step 1 — Try profile auto-fill first (preferred, no script needed)**

Chrome password manager pre-fills credentials when the profile is intact. Just click through:

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
user pastes 6-digit code → **"Verify"**. Selectors in `references\login-flow.md`.

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

## PHASE 1.5 — DOM Expansion *(run before extraction)*

**Goal:** ensure full DOM content is visible before extraction. The Salesforce Chatter feed hides data
behind pagination and collapsed bodies. These are `agent-browser click` steps — the accessibility tree
exposes them as named controls, no JS eval needed. **This is the only expansion step** — PHASE 2 extracts
from the DOM exactly as this phase leaves it; nothing re-opens or re-expands the page.

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

---

## PHASE 2 — Extract *(agent-driven)*

**Goal:** extract all raw case data from the **already-expanded live DOM** (no re-open, no re-expand),
then finalize to `data/cases/<CODE>.json` + `_index.json`.

Full reference: **`references\extraction.md`** (the three eval rules + selector lock-in table).

1. Read existing `_index.json` to get the old hash for `<CODE>` (incremental check).
2. Confirm PHASE 1.5 done: `agent-browser snapshot -c | grep -E "Expand Post|View More"` → empty.
3. Run the bundled extractor via `--stdin` (multi-line JS reaches the browser intact) and redirect the
   result straight to the raw file. The script returns the OBJECT (agent-browser serializes it once —
   do NOT `JSON.stringify` inside, that double-encodes; and the shell `>` avoids the PowerShell BOM):
   ```bash
   agent-browser eval --stdin < .claude/skills/qualcomm-case-agent/scripts/extract_case.js \
     > data/cases/<CODE>.raw.json
   ```
   If the live DOM differs and fields come back empty, edit `extract_case.js` in place (it is the
   canonical extractor, not a throwaway). Header fields (title/status/priority) aren't on the Feed view —
   fill them from the PHASE 1 search row before finalizing.
4. Sanity-check, then finalize (rejects 0 comments → assert count → SHA-256 hash → write JSON + index):
   ```bash
   node -e "const j=JSON.parse(require('fs').readFileSync('data/cases/<CODE>.raw.json','utf8')); console.log(j.caseNumber, j.comments.length, j.displayedCommentCount)"
   node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE> "data/cases/<CODE>.raw.json"
   ```
   On exit 0, delete the `.raw.json` scratch file.

**Exit codes:**

| Code | Meaning | Action |
|------|---------|--------|
| 0 | OK | Compare new hash vs old. Identical → "No update since `<syncedAt>`", STOP. Changed → PHASE 3. |
| 2 | Bad args / bad raw JSON | Fix invocation; ensure `raw.comments` is an array (clean single-encoded JSON, no BOM), then re-extract. |
| 5 | Incomplete — 0 comments, or `comments.length < displayedCommentCount` | 0 comments = wrong page / session lapsed / Feed not loaded → re-check you're on the case page, finish PHASE 1.5, re-extract. Short = expand more or, if virtualized, progressive extraction (extraction.md). STOP if still 5. |

Auth redirect / "case not found" are caught earlier by the PHASE 1 hostname guard — PHASE 2 no longer
navigates, so it never re-triggers them.

---

## PHASE 3 — Enrich

**Trigger:** PHASE 2 exit 0 AND hash changed.
**Delegation:** same work as standalone `qualcomm-enrich` skill. Hand off to it or run inline — both use the same schema and `render_case.mjs`.

**Goal:** engineer-grade per-comment analysis + case-level synthesis in `data.enrichment`. Raw fields and `hash` are NEVER mutated.

**Incremental logic:**

1. Read `data/cases/<CODE>.json`.
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

1. **`data\cases\<CODE>.json`** — full object (source of truth), comments newest-first:
   ```
   { caseNumber, title, status, priority, severity, product, customer, created, updated,
     description, url, displayedCommentCount, commentCount, hash, extractedAt,
     comments: [{ id, timestamp, company, author, role, body, analysisLog[], attachments[] }],
     enrichment?: { engineerSummary, currentStatus, rootCause, caseFlow[], openQuestions[],
                    recommendedActions[], tags[], timeline[],
                    commentAnalyses: { <id>: { summary, role, keyPoints[], citations[], answered } },
                    enrichedAt } }
   ```

2. **Render files:**
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/render_case.mjs" "data/cases/<CODE>.json"
   ```
   Writes: `<CODE>.report.md` (concise summary, ⚠ if captured < displayed), `<CODE>.md` + `<CODE>.html` + `<CODE>.txt` (full verbatim).

3. **Optional PDF** — using Chrome attached in this run:
   ```bash
   agent-browser open "file://$(pwd)/data/cases/<CODE>.html"
   agent-browser pdf "data/cases/<CODE>.pdf"
   ```
   Skip if Chrome not attached.

4. **Update `_index.json`:** `"<CODE>": { "syncedAt": "<ISO>", "commentCount": N, "hash": "<sha256>" }`.

---

## PHASE 5 — Report

Tell the user: case number + title + status, comments captured **vs displayed** (or **"no update"**),
current status, root cause, # open questions, top recommended actions, file paths
(`<CODE>.json` · `<CODE>.report.md` · `<CODE>.html` · `<CODE>.txt`). Attach `<CODE>.report.md` and `<CODE>.html`.

---

## Agent Guardrails

- **Load agent-browser reference first** before any browser action.
- **Session = persistent Chrome profile** at `data\chrome-profile`. Never close between phases. The profile persists across all phases and runs — Chrome closed unexpectedly → Recovery 0 on next action.
- **Secrets:** `qid.bin` (DPAPI, CurrentUser) is the only durable password copy. Never in chat, outputs, or plaintext. OTP never stored.
- **Confidentiality:** case content is Qualcomm NDA. Keep in `data\cases\` (git-ignored). Never paste to external services.
- **Fidelity:** capture comment bodies and logs VERBATIM. Never truncate. Analyses are a separate field.
- **No fabrication:** absent field/URL/log → say so.
- **Incremental:** unchanged case → "no update"; do not rewrite or re-enrich.
- **Scope:** one case per invocation.
- **ToS:** extract only cases the signed-in account is authorized to view.

---

## Running Under Other Agents (Cline / VS Code)

Cline auto-reads `.clinerules/qualcomm-case-agent.md`. Use `execute_command` for every `powershell`/`agent-browser`/`node` line. Do NOT use Cline's `browser_action` — this skill attaches to real Chrome over CDP.

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
