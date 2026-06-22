---
name: qualcomm-case-agent
description: "Qualcomm Case Management Agent. Given ONE Qualcomm case code, drive agent-browser to sign in (Qualcomm ID SSO + email OTP) and extract the COMPLETE case from the Qualcomm Support portal (support.qualcomm.com) — full metadata plus every comment (timestamp, company, author, comment text + full detail, analysis logs/attachments). Enrich each comment with an expert summary written as a Qualcomm / Protocol / 3GPP engineer, then persist to the access-qualcomm project cache newest-first in three formats: JSON (machine), Markdown (review), and a single-file HTML (easiest human reading). Incremental: unchanged cases report 'no update'. Triggers: 'qualcomm case <code>', 'pull qualcomm case', 'access qualcomm case', 'lấy case qualcomm', 'phân tích case qualcomm', 'qualcomm case agent', 'extract qualcomm case code'. Use whenever the user provides a Qualcomm case code/number and wants the full case captured and summarized."
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*), Bash(node:*), Bash(powershell:*), PowerShell, Read, Write, Glob
---

# Qualcomm Case Management Agent

**Role.** Senior Qualcomm support engineer with deep **Protocol (L1/L2/L3, NAS/RRC)**,
**RF (TX/RX, sensitivity, desense, ACLR, EVM)** and **3GPP** expertise. Given one **case code**,
autonomously retrieve the entire case from the Qualcomm Support portal, analyze it, and produce
engineer-grade artifacts in the local project cache.

**Input contract.** One Qualcomm case code (e.g. `CASE-01234567`, `00123456`, or the numeric
id in the case URL). If missing → ask the user, then STOP.

**Operating principle.** Each PHASE has a goal, action, and guard. Surface to the user only on:
auth (SSO / email OTP), case-not-found, or ambiguous input. Never guess credentials or fabricate data.

**MANDATORY prerequisite — load agent-browser reference FIRST.** Before ANY browser action:

```bash
agent-browser skills get core --full
```

---

## Configuration

All paths are **relative to the workspace root** (access-qualcomm project = CWD).
Scripts and references live under `.claude\skills\qualcomm-case-agent\` (abbreviated as skill dir below).

| Key | Value |
|-----|-------|
| Portal | `https://support.qualcomm.com` |
| SSO | `https://account.qualcomm.com/...` (Okta — identifier-first two-step) |
| Qualcomm ID | `the.thoi@samsung.com` |
| Password store | `data\.secrets\qid.bin` — DPAPI ProtectedData (CurrentUser), git-ignored |
| MFA | **Email OTP** — 6-digit code to Samsung mailbox, expires ~5 min. Always human-pasted |
| Browser | **real Google Chrome** on CDP port `9222` via `scripts\connect_chrome.ps1` |
| CDP port | `9222` |
| Session store | `data\chrome-profile\` — persistent `--user-data-dir`; git-ignored |
| Case cache | `data\cases\<CODE>.json` · `<CODE>.report.md` · `<CODE>.md` · `<CODE>.html` |
| Sync index | `data\cases\_index.json` |
| Scripts | skill dir `scripts\`: `connect_chrome.ps1`, `okta_login.ps1`, `capture_password.ps1`, `scrape_case.mjs`, `render_case.mjs` |
| References | skill dir `references\`: `login-flow.md`, `extraction.md`, `workflow.md`, `consumer-guide.md` |

---

## Session Health Check

**Run this before any browser action in every phase:**

```bash
agent-browser eval "return document.title + ' | ' + location.href"
```

If the result shows `account.qualcomm.com` in the URL → session expired, go back to **PHASE 1** re-auth flow immediately. Do NOT proceed with browser actions on a logged-out session.

---

## PHASE 0 — Intake & Environment

**Goal:** validate input; prepare workspace; attach to real Chrome.

1. Invoke the `agent-browser` skill (Claude Code `Skill` tool). Then: `agent-browser skills get core --full`.
2. Validate + normalize the case code: trim, uppercase alpha, reject path-illegal chars `\ / : * ? " < > |`.
3. Ensure `data\cases\` exists. Create `data\cases\_index.json = {}` if absent.
4. Launch Chrome + attach:

   ```bash
   powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"
   # Helper prints the exact ws:// URL — run that command:
   #   agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
   ```

   Why real Chrome: bundled Chromium can fail CDP handshake → `os error 10060`. Real Chrome is stable.
   Why `connect_chrome.ps1`: auto-detects Chrome path, resolves profile from project root (not CWD), handles IPv4 vs IPv6 mismatch. Never use `Start-Process` inline unless debugging.

**Guard:** no case code → ask user, STOP. Connect fails → see Troubleshooting.

---

## PHASE 1 — Authenticate

**Full reference: `references\login-flow.md`**

**Goal:** authenticated Qualcomm Support session. Primary path is silent (persistent profile). Fallback is re-login with DPAPI password + human OTP.

**Action:**

```bash
agent-browser open "https://support.qualcomm.com"
agent-browser snapshot -c
```

**Decision:**

| Result | Action |
|--------|--------|
| Dashboard loads | Session valid. Continue to PHASE 2. No login/OTP/DPAPI needed. |
| Redirected to `account.qualcomm.com` | Forced re-login (session lapsed). See below. |
| Wrong password (stayed on password screen) | Delete `qid.bin`, ask user to re-capture, retry ONCE. |
| OTP rejected/expired | OTP problem — do NOT delete `qid.bin`. User requests fresh code and re-pastes. |
| Email unavailable + session expired | Cannot authenticate. Report and STOP. |

**Forced re-login flow:**

- `qid.bin` exists → run two-step helper (fills username→Next→password→Verify; email OTP stays human):
  ```bash
  powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/okta_login.ps1"
  ```
  Then drive OTP screens by snapshot: click **"Send me an email"** → **"Enter a verification code instead"** → user pastes 6-digit code → click **"Verify"**.

- `qid.bin` missing → tell user to run this in a **real PowerShell terminal** (NOT chat, NOT cmd.exe):
  ```
  powershell -ExecutionPolicy Bypass -File .claude\skills\qualcomm-case-agent\scripts\capture_password.ps1
  ```
  Wait for "Saved … bytes". Then run the login helper.

After OTP: re-snapshot to confirm dashboard. The persistent profile stores the new session automatically.

**Session rule:** the `data\chrome-profile\` directory IS the session. Never close/restart Chrome between phases unless there's an explicit error. The profile persists across all phases and across runs.

---

## PHASE 2 — Locate Case

**Goal:** open the exact case page for `<CODE>` and capture its real URL.

**Action — always use the global-search URL:**

```bash
# Navigate directly to search results for this case code
agent-browser open "https://support.qualcomm.com/s/global-search/<CODE>"
agent-browser wait 2000
agent-browser snapshot -c
```

From the search results snapshot: identify the case entry matching `<CODE>` and click it (use the @ref from snapshot). Then immediately capture the actual URL after navigation:

```bash
agent-browser wait 2000   # let the case page load
agent-browser eval "return location.href"
```

Store this exact URL as the `url` field in the case JSON. The URL will differ from the search URL (it resolves to the actual case page path).

**Session check:** before clicking, verify the snapshot is not the Okta login page. If it is, go to PHASE 1 re-auth.

**Guard:** search returns no results for `<CODE>` → the code may be wrong or not visible to this account. Report and STOP.

---

## PHASE 3 — Scrape

**Goal:** capture all raw case data; write `data/cases/<CODE>.json`; update `_index.json`.

**Full reference: `references\extraction.md`**

1. Read existing `data/cases/_index.json` to get the old hash for `<CODE>` (for incremental check).
2. Run Stage 1 scraper:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE>
   ```

**Exit codes:**

| Code | Meaning | Action |
|------|---------|--------|
| 0 | OK | Compare new hash with old. If identical → "No update since `<syncedAt>`", STOP. Else → PHASE 4. |
| 2 | Bad args | Fix invocation. |
| 3 | Auth needed | User signs in + pastes OTP in browser, then retry. |
| 4 | Case not found / no access | Report, STOP. |
| 5 | Incomplete — count < displayed | Run LLM selector re-discovery (below), retry. STOP if still exit 5. |
| 6 | selectors.json missing | Run LLM selector discovery (below), retry. |

**Selector Discovery (exit 5 or 6):**
1. `agent-browser snapshot -c` — inspect live case DOM.
2. Identify CSS selectors for all fields in `config/selectors.json`.
3. Write discovered selectors (update `_discoveredAt`, keep `_version`).
4. Retry scraper.

---

## PHASE 4 — Enrich

**Trigger:** PHASE 3 exit 0 AND hash changed.

**Goal:** per-comment summaries + case-level synthesis in `data.enrichment` of `<CODE>.json`. Raw fields never mutated.

**Incremental logic:**
1. Read `data/cases/<CODE>.json`.
2. New comment ids = those in `raw.comments[].id` NOT yet in `enrichment.commentSummaries`.
3. Per new comment → `summary` (2–4 sentences): technical point, root-cause/hypothesis, band/RAT/feature, action. Cite 3GPP clause if referenced. Include key numbers. Thin comment → `"Insufficient detail"`.
4. Re-generate case-level fields from ALL comments:
   - `engineerSummary` (5–8 sentences)
   - `rootCause` (best hypothesis or `"Unresolved"`)
   - `recommendedActions[]`
   - `tags[]` (e.g. `["NR","n78","desense","RRC reestablishment","TS 38.331"]`)
   - `timeline[]` newest-first
5. Write back to JSON under `enrichment` key. Raw fields unchanged.
6. Update `_index.json["<CODE>"].enrichedAt`.

**Re-enrich intent** (keywords: "re-enrich", "redo analysis", "improve summary"): ask for optional custom prompt, then re-run Stage 2. Case-level fields always re-generated; only NEW comment ids added to `commentSummaries`.

**Rule:** summaries interpret source data only — never add technical facts absent from the case.

---

## PHASE 5 — Persist

1. **`data\cases\<CODE>.json`** — full object (source of truth). Comments newest-first.
   ```
   { caseNumber, title, status, priority, severity, product, customer, created, updated,
     description, url, displayedCommentCount, commentCount, hash, extractedAt,
     comments: [ { id, timestamp, company, author, role, body, analysisLog[], attachments[] } ],
     enrichment?: { engineerSummary, rootCause, recommendedActions[], tags[], timeline[],
                    commentSummaries: { <id>: string }, enrichedAt } }
   ```
2. **Render human-review files:**
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/render_case.mjs" "data/cases/<CODE>.json"
   ```
   Writes: `<CODE>.report.md` (concise summary), `<CODE>.md` + `<CODE>.html` (full, every comment verbatim).
3. **Update `data\cases\_index.json`:** `"<CODE>": { "syncedAt": "<ISO>", "commentCount": N, "hash": "<sha256>" }`.

---

## PHASE 6 — Report

Tell the user: case number + title + status, comments captured **vs displayed** (or **"no update"**),
root cause, top recommended actions, output paths (`<CODE>.json` · `<CODE>.report.md` · `<CODE>.html`).
Attach `<CODE>.report.md` and `<CODE>.html`.

---

## Agent Guardrails

- **Load agent-browser reference first** before any browser action.
- **Session = persistent Chrome profile** at `data\chrome-profile`. Never close between phases. Check session health before each phase's browser actions.
- **Secrets:** password's only durable copy is `data\.secrets\qid.bin` (DPAPI, CurrentUser). Never in chat, never plaintext. OTP never stored.
- **Confidentiality:** case content is Qualcomm NDA. Keep in `data\cases\` (git-ignored). Never paste to external services.
- **Fidelity:** capture comment bodies and logs VERBATIM. Never truncate. Expert summaries are a separate field.
- **No fabrication:** absent field/URL/log → say so.
- **Incremental:** unchanged case → "no update"; do not rewrite or re-enrich.
- **Scope:** one case per invocation.
- **ToS:** extract only cases the signed-in account is authorized to view.

---

## Running Under Other Agents (Cline / VS Code)

Cline auto-reads `.clinerules/qualcomm-case-agent.md`. Use `execute_command` for every `powershell`/`agent-browser`/`node` line. Do NOT use Cline's built-in `browser_action` — this skill attaches to real Chrome over CDP.

---

## Setup on New Windows Machine

1. Install Node.js (≥18) + CLI: `npm i -g agent-browser`. Install real Google Chrome (bundled Chromium not needed, can break).
2. Copy the project folder — skill travels in `.claude/skills/qualcomm-case-agent/`.
3. Do NOT copy `data/chrome-profile/`, `data/.secrets/`, or `data/cases/` — DPAPI `qid.bin` is machine/user-bound. All three are git-ignored.
4. First run: `scripts/connect_chrome.ps1` → login + email OTP + DPAPI capture (`references/login-flow.md` → "First-time capture") in a real terminal.

---

## Troubleshooting

### `os error 10060` on `agent-browser connect 9222`

**Cause A (most common) — localhost → IPv6 mismatch.** `connect 9222` targets `http://localhost:9222`. Windows resolves `localhost` to IPv6 `::1` first, but Chrome `--remote-debugging-port` binds only IPv4 `127.0.0.1`. Fix: use the explicit IPv4 ws:// URL that `connect_chrome.ps1` prints:
```bash
agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
```
Diagnose: `curl -s http://127.0.0.1:9222/json/version` returns 200 → Chrome is fine; 10060 is the IPv6 issue.

**Cause B (legacy) — stale bundled Chromium daemon.** Clear it:
```powershell
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -like "*\.agent-browser\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process agent-browser-win32-x64 -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "$env:USERPROFILE\.agent-browser\default.pid","$env:USERPROFILE\.agent-browser\default.port","$env:USERPROFILE\.agent-browser\default.stream" -Force -ErrorAction SilentlyContinue
```
Then `connect_chrome.ps1` + attach.

### "Input redirection is not supported"

Chrome must launch via `Start-Process` (NOT `&` operator) — avoids inheriting redirected stdin. `connect_chrome.ps1` handles this. agent-browser auto-denies prompts on non-TTY stdin — do NOT add `< /dev/null` (bash-only; fails in PowerShell/cmd). Full notes in `references\login-flow.md`.

### PowerShell syntax in Bash tool

`if (...) { ... }` is PowerShell — errors in Git-Bash. Run PowerShell snippets via PowerShell tool or `powershell -File …`. POSIX one-liners via Bash tool.
