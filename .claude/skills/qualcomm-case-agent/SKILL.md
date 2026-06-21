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

**Operating principle.** Agent loop: each PHASE has a goal, an action, and a decision/guard.
Stop and surface to the user only on auth (SSO / email OTP), case-not-found, or ambiguous
input — never guess credentials or fabricate data.

**Harness-agnostic.** This is a plain runbook — it works under Claude Code, Cline (VS Code), or any
agent that can run a terminal and read/write files. Wherever it says "run", use your terminal /
execute-command tool; "write/read" = your file tools. The YAML frontmatter above is Claude-Code
metadata, ignored elsewhere. See **Running under other agents** below.

**MANDATORY prerequisite — load the agent-browser command reference FIRST.** Before ANY browser
action, run in the terminal:

```bash
agent-browser skills get core --full
```

(In Claude Code you may additionally invoke the `agent-browser` Skill; under Cline/others the CLI
command above is the portable equivalent.) The verbs used below are confirmed for **v0.27.x**; if
the installed version differs, that reference is authoritative.

---

## Configuration

Data paths below (`data\...`) are **relative to the workspace root** (the access-qualcomm project =
the current working directory / VS Code workspace folder). No absolute or machine-specific paths —
portable across PCs and agents.

> **`references\…` and the skill's own `scripts\…` live UNDER the skill base dir**, i.e.
> `.claude\skills\qualcomm-case-agent\references\…` and `…\scripts\…` — NOT at the workspace root.
> When this doc writes `references\login-flow.md` as shorthand, read it as
> `.claude\skills\qualcomm-case-agent\references\login-flow.md` (use that full path with file tools).

| Key | Value |
|-----|-------|
| Project root | the workspace root / CWD (run from the access-qualcomm folder) |
| Portal | `https://support.qualcomm.com` (formerly CreatePoint) |
| SSO | `https://account.qualcomm.com/...` (Okta — user signs in manually) |
| Qualcomm ID | `the.thoi@samsung.com` (login id) |
| Password store | `data\.secrets\qid.bin` — DPAPI ProtectedData (CurrentUser), git-ignored. Captured ONCE by the user in their terminal; auto-fills on forced re-login. See `references\login-flow.md` |
| MFA | **Email OTP** — 6-digit code to the Samsung mailbox, expires ~5 min. Always human-pasted; Claude cannot read the mailbox. A stored password does NOT bypass it |
| Browser | **real Google Chrome** launched detached with a CDP port, then `agent-browser connect 9222`. NOT agent-browser's bundled Chromium (a broken bundled build caused `os error 10060` — see Troubleshooting). Launch helper: `scripts\connect_chrome.ps1` |
| CDP port | `9222` (real Chrome `--remote-debugging-port`) |
| Session store | `data\chrome-profile\` (persistent Chrome `--user-data-dir`; git-ignored — sign in ONCE). A SEPARATE Chrome instance — the user's personal Chrome is never touched/closed |
| Case cache | `data\cases\<CODE>.json` (full) · `<CODE>.report.md` (summary) · `<CODE>.md` + `<CODE>.html` (full review) |
| Sync index | `data\cases\_index.json` (`<CODE> → { syncedAt, commentCount, hash }`) |
| Render script | `.claude\skills\qualcomm-case-agent\scripts\render_case.mjs` — `node <that> data\cases\<CODE>.json` writes `.report.md` + `.md` + `.html` |
| References | under `.claude\skills\qualcomm-case-agent\references\`: `workflow.md` (+`workflow.svg`), `login-flow.md`, `extraction.md`, `consumer-guide.md` (API contract for OTHER agents reading `data\cases\`) |
| Login helper | `.claude\skills\qualcomm-case-agent\scripts\okta_login.ps1` — drives Okta identifier-first username→Next→password→Verify, password from DPAPI; email OTP stays human |

> Use forward slashes in agent-browser/Node args on Windows. Convert `<CODE>` to a safe filename
> (uppercase alpha, strip path-illegal chars).

---

## PHASE 0 — Intake & environment

- **Goal:** validate input; prepare the workspace; attach to a signed-in **real Chrome**.
- **Action:**
  1. **FIRST: invoke the `agent-browser` skill** (Claude Code: `Skill` tool → `agent-browser`).
     Mandatory before any browser command. Then load its core guide:
     `agent-browser skills get core --full`.
  2. Validate + normalize the case code (trim; uppercase alpha; reject if it contains path-illegal
     chars `\ / : * ? " < > |`).
  3. Ensure cache dirs exist: `data\cases\`. Create `data\cases\_index.json` = `{}` if absent.
  4. **Launch real Chrome with a CDP port + dedicated profile, then attach agent-browser.** Use the
     helper (idempotent — if `9222` is already up it just reuses it; it never kills the user's
     personal Chrome):
     ```bash
     powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1"
     # Attach via the IPv4 ws:// URL the helper prints, NOT bare `connect 9222`.
     # On Windows `connect 9222` -> http://localhost:9222 -> resolves IPv6 ::1 first,
     # but Chrome binds only IPv4 127.0.0.1 -> SYN timeout -> "os error 10060".
     # The helper prints the exact command; run it (no stdin redirect needed —
     # agent-browser auto-denies prompts when stdin is not a TTY):
     #   agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
     ```
     To derive the URL yourself: `curl -s http://127.0.0.1:9222/json/version` → use its
     `webSocketDebuggerUrl` (already `ws://127.0.0.1:9222/...`).
     Equivalent without the helper (real Chrome, detached — `Start-Process`, NOT the `&` call
     operator, which inherits the automation shell's redirected stdin and throws *"Input redirection
     is not supported"*):
     ```powershell
     # Separate --user-data-dir = separate instance; do NOT kill the user's personal Chrome.
     Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList @(
       '--remote-debugging-port=9222',
       "--user-data-dir=$((Get-Location).Path)\data\chrome-profile")
     ```
     Why real Chrome and not the bundled Chromium: a freshly-downloaded bundled build can fail its
     CDP handshake → `os error 10060` on every `open`. Real Chrome is stable and OS-trusted. See
     **Troubleshooting**.
- **Guard:** no case code → ask the user and STOP. If `agent-browser connect 9222` fails, see
  Troubleshooting (stale daemon / port not up).

## PHASE 1 — Authenticate (session reused; password auto-fills; email OTP human-in-the-loop)

Full step-by-step + failure handling: **`references\login-flow.md`**. Summary:

- **Goal:** an authenticated Qualcomm Support session. Two layers: (1) reuse the persistent Chrome
  profile — silent, no login; (2) on forced re-login, auto-fill the DPAPI-stored password, human
  pastes the OTP.
- **Action (attach-to-Chrome, profile-persistent):** Phase 0 already launched real Chrome on CDP
  `9222` with the SAME `--user-data-dir` (`data\chrome-profile`) and ran `agent-browser connect 9222`.
  That profile dir holds cookies/tokens and persists between runs automatically — no separate "save"
  step, no `--profile` flag (we attach, not launch a bundled browser). Now drive the attached tab:
  ```bash
  agent-browser open "https://support.qualcomm.com"
  agent-browser snapshot -c
  ```
  The Chrome window is visible (real Chrome), so the user can paste the OTP if the session lapsed.
- **Decision:**
  - **Dashboard loads** (profile session valid) → continue to Phase 2. **No login, no OTP, no DPAPI
    read.** Normal path.
  - **Redirected to `account.qualcomm.com` (Okta)** → forced re-login. Okta is **identifier-first
    (two-step)**: username→Next→password→Verify→email-OTP. Do NOT use the single-page `auth save/login`
    vault conduit — it cannot span the two screens.
    - `data\.secrets\qid.bin` exists → run the **two-step login helper** (decrypts DPAPI, fills
      username→Next→password→Verify; password never echoed):
      ```bash
      powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/okta_login.ps1"
      ```
      Then drive the email-OTP screens by snapshot: click **"Send me an email"** → **"Enter a
      verification code instead"** → the user pastes the 6-digit code → click **"Verify"**. Full
      flow + selectors in `.claude\skills\qualcomm-case-agent\references\login-flow.md`.
    - `qid.bin` missing → **ask the user to run the one-time DPAPI capture snippet in their own
      PowerShell terminal** (`references\login-flow.md` → "First-time capture"; must `Set-Location`
      to the workspace root, run in PowerShell not cmd.exe, and `Add-Type -AssemblyName
      System.Security`). The password is typed into their terminal, NEVER into the chat. Wait, then
      run the helper.
    - After OTP, re-`snapshot` to confirm the dashboard. The profile stores the new session
      automatically. Re-login on expiry is expected.
  - **Wrong password** (after Verify, still on the password screen with a credential error, or it
    never advanced to the email-OTP step) → delete `qid.bin`, ask the user to re-run the capture
    snippet, retry the helper **once**. Fails again → report and STOP. Only path that re-prompts for
    the password.
  - **OTP rejected/expired** (form reached the OTP step but failed) → an OTP problem, not a password
    problem: do NOT delete `qid.bin`; user requests a fresh code and re-pastes.
  - **Email unavailable:** a fresh login REQUIRES the email OTP. If the profile session has expired
    AND the user can't reach the mailbox, you cannot authenticate — report plainly and STOP. Do not
    loop. (A still-valid profile bypasses OTP entirely, so this only bites after expiry.)
- **Never** echo the password or OTP to output or write either as plaintext. The only durable secret
  is the DPAPI `qid.bin`; the agent-browser vault entry is transient (deleted right after login).

## PHASE 2 — Locate the case

- **Goal:** open the exact case page for `<CODE>`.
- **Action:** prefer the direct case URL if the pattern is known (record it in
  `references\extraction.md` on first run); otherwise use the dashboard case search:
  ```bash
  agent-browser snapshot -i
  agent-browser fill "input[type='search'], input[placeholder*='Case']" "<CODE>"
  agent-browser press Enter && agent-browser wait 3000
  agent-browser snapshot -c          # click the matching result @ref to open the case
  ```
- **Guard:** zero results / "not found" → the code may be wrong or not visible to this account.
  Report and STOP.

## PHASE 3 — Scrape (Stage 1 — deterministic)

- **Goal:** Capture all raw case data; write `data/cases/<CODE>.json` and update `_index.json`.
- **Action:**
  1. (Optional) Read existing `data/cases/_index.json` to capture the old hash for `<CODE>` (needed for incremental check in step 2).
  2. Run Stage 1:
     ```bash
     node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE>
     ```
     The script emits a machine-readable JSON line on stdout and exits with a code.

- **Exit code handling:**

  | Code | Meaning | Agent action |
  |------|---------|--------------|
  | 0 | ok | Read the emitted JSON (contains new `hash`). Compare with old hash from `_index.json`. If identical → "No update since `<syncedAt>`", STOP. Else → Phase 4. |
  | 2 | bad args | Fix invocation. |
  | 3 | auth-needed | Ask user to sign in + paste email OTP in the browser, then retry. |
  | 4 | case not found / no access | Report to user, STOP. |
  | 5 | incomplete — count < displayed after all fallbacks | Run LLM selector re-discovery (below), retry. STOP if still exit 5. |
  | 6 | selectors.json missing or incomplete | Run LLM selector discovery (below), retry. |

### Selector Discovery (run on exit 5 or 6)

1. `agent-browser snapshot -c` — inspect the live case page DOM.
2. Identify CSS selectors for all fields in `config/selectors.json` (`fields.*`, `comments.*`, `displayedCommentCount`, `expanders.selector`).
3. Write discovered selectors to `config/selectors.json` (update `_discoveredAt`, keep `_version`).
4. Retry `node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CASE_CODE>`.

## PHASE 3.5 — (merged into Phase 3 exit-0 handling above)

The incremental skip is now automatic: compare the `hash` emitted by `scrape_case.mjs` (exit 0) with the old hash stored in `_index.json` before the run. Identical → STOP and report "no update". Changed → continue to Phase 4.

## PHASE 4 — Enrich (Stage 2 — LLM, incremental)

- **Trigger:** Phase 3 exit 0 AND hash changed (new or updated case data).
- **Skip:** If the user/orchestrator requested raw-only sync, skip this phase.

- **Goal:** Produce per-comment summaries + case-level synthesis, written into `data.enrichment`
  in `data/cases/<CODE>.json`. Raw fields and `hash` are NEVER mutated by enrichment.

### Incremental logic (preserve existing summaries, re-synthesize case level)

1. Read `data/cases/<CODE>.json`.
2. Identify new comment ids: those in `raw.comments[].id` NOT already in
   `enrichment.commentSummaries` (keyed by comment id).
3. For EACH NEW comment, produce:
   - `summary` (2–4 sentences): technical point, root-cause/hypothesis, band/RAT/feature, action.
     Cite the exact 3GPP clause (TS 36./38.xxx, RAN1–4, CT) if referenced. Include key numbers
     (band/EARFCN, dBm, ms, error/QXDM codes). Thin comment → `"Insufficient detail"`.
4. Re-generate case-level fields from ALL comments (new comments may change the full picture):
   - `engineerSummary` (5–8 sentences): end-to-end debug narrative + current conclusion.
   - `rootCause` (best current hypothesis, or `"Unresolved"`).
   - `recommendedActions[]` — concrete next steps.
   - `tags[]` — e.g. `["NR","n78","desense","RRC reestablishment","TS 38.331"]`.
   - `timeline[]` — date → key event, newest-first.
5. Merge and write back to `data/cases/<CODE>.json`:
   ```json
   {
     "enrichment": {
       "engineerSummary": "...",
       "rootCause": "...",
       "recommendedActions": ["..."],
       "tags": ["..."],
       "timeline": [{ "date": "...", "event": "..." }],
       "commentSummaries": { "<comment id>": "summary text" },
       "enrichedAt": "<ISO-8601>"
     }
   }
   ```
   Raw fields (`caseNumber`, `comments[].body`, `hash`, `extractedAt`, etc.) are NEVER changed.
6. Update `data/cases/_index.json["<CODE>"].enrichedAt`.

### Re-enrich flow (user requests improved analysis — no re-scrape)

- Detect intent from user message keywords: "re-enrich", "redo analysis", "improve summary",
  "update enrichment", "re-run enrichment".
- Ask: `"Do you want to customize the enrichment prompt? (Enter to keep default)"`
- If user provides custom instructions → use for this run only (not persisted).
- Read existing `data/cases/<CODE>.json` (raw is already cached). Run incremental Stage 2.
  Case-level fields are always re-generated; only new comment ids are added to `commentSummaries`.

**Rule:** Summaries interpret source data — they NEVER add technical facts not present in the case.

## PHASE 5 — Persist (3 formats, newest-first)

1. Write **`data\cases\<CODE>.json`** — full object (source of truth):
   ```
   { caseNumber, title, status, priority, severity, product, customer, created, updated,
     description, url, displayedCommentCount, commentCount, hash, extractedAt,
     comments: [ { id, timestamp, company, author, role, body, analysisLog[], attachments[] } ],
     enrichment?: { engineerSummary, rootCause, recommendedActions[], tags[], timeline[],
                    commentSummaries: { <id>: string }, enrichedAt } }
   ```
   Comments newest-first. `displayedCommentCount` = the case's own "N comments" total (completeness).
2. Render the human-review + summary files deterministically (no hand-built HTML/report):
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/render_case.mjs" "data/cases/<CODE>.json"
   ```
   (Both paths are relative to the workspace root — run from the project folder. No username/drive.)
   Writes three siblings next to the JSON:
   - **`<CODE>.report.md`** — concise SUMMARY (engineerSummary, rootCause, actions, tags, timeline,
     one line per comment). The "report". Shows a ⚠ banner if captured < displayed.
   - **`<CODE>.md`** + **`<CODE>.html`** — FULL render, every comment verbatim with collapsible
     logs/attachments. For deep human review.
3. Update **`data\cases\_index.json`**: `"<CODE>": { "syncedAt": "<ISO>", "commentCount": N, "hash": "<sha256>" }`.

## PHASE 6 — Report

Tell the user: case number + title + status, #comments captured **vs displayed** (or **"no update"**),
root cause, top recommended actions, and the output file paths
(`<CODE>.json` · `<CODE>.report.md` · `<CODE>.html`). Attach `<CODE>.report.md` and `<CODE>.html`.

---

## Agent guardrails

- **Load the agent-browser reference first** (`agent-browser skills get core --full`) before any
  browser action; follow its syntax.
- **Auth:** attach to **real Chrome** over CDP `9222` (launched detached with `--user-data-dir
  data\chrome-profile` via `scripts\connect_chrome.ps1`), then `agent-browser connect 9222`. NOT the
  bundled Chromium (`--profile`) — a broken bundled build caused `os error 10060`. The persistent
  `--user-data-dir` keeps the session across runs — the primary silent path, no re-login until it
  expires. On expiry, the password auto-fills from the DPAPI store (`data\.secrets\qid.bin`); the human
  pastes the **email OTP** (always human — Claude cannot read the mailbox; a stored password does NOT
  bypass MFA). Re-ask the password ONLY when it is wrong. The launch never kills the user's personal
  Chrome (separate `--user-data-dir` = separate instance). See `references\login-flow.md`.
- **Secrets:** the password's only durable copy is `data\.secrets\qid.bin`, **DPAPI-encrypted**
  (CurrentUser) — never in this skill, in outputs, in the chat/transcript, or any plaintext file.
  First capture is a user-run terminal snippet; the agent-browser auth vault is used transiently
  (`auth save`→`login`→`delete`) and never echoes the secret. OTP is never stored. `data\.secrets\`,
  `data\chrome-profile\`, and any `*.session.json` are git-ignored.
- **Confidentiality:** case content is Qualcomm NDA material. Keep it in `data\cases\` (git-ignored);
  never paste full customer logs to external services.
- **Fidelity:** capture comment bodies and logs VERBATIM; never truncate. Expert summaries are a
  separate field and never replace source text.
- **No fabrication:** if a field/URL/log is absent, say so.
- **Incremental:** unchanged case → "no update"; do not rewrite or re-enrich.
- **Scope:** one case per invocation. For many cases, the orchestrator calls this per code.
- **ToS:** only extract cases the signed-in account is authorized to view.

## Running under other agents (Cline / VS Code)

- The VS Code workspace root = this project folder; every relative path above resolves from it.
- Cline auto-reads `.clinerules/` — `.clinerules/qualcomm-case-agent.md` points it here. Trigger by
  asking e.g. "sync Qualcomm case CASE-12345"; Cline then follows this runbook.
- Use Cline's **execute_command** for every `powershell` / `agent-browser` / `node` line, and its file
  tools for read/write. Do **not** use Cline's built-in `browser_action` — this skill attaches the
  standalone `agent-browser` CLI to **real Chrome over CDP** (`connect 9222`), which `browser_action`
  cannot do.
- `AGENTS.md` at the project root is a generic pointer for any other agent.

## Setup on a new Windows machine

1. Install Node.js (≥18) + the CLI: `npm i -g agent-browser`. **Install real Google Chrome** (the
   skill attaches to system Chrome over CDP; the bundled `agent-browser install` Chromium is NOT
   required and a bad build can break it — see Troubleshooting).
2. Copy the **whole project folder** to the new PC. The skill travels inside
   `.claude/skills/qualcomm-case-agent/`. (For Claude Code use outside this project, also copy the
   skill to `~/.claude/skills/`.)
3. Do **not** copy `data/chrome-profile/`, `data/.secrets/`, or `data/cases/` — the profile cookies
   AND the DPAPI `qid.bin` are encrypted to the old Windows user (won't decrypt → must re-capture +
   re-login anyway); case content is NDA. All three are git-ignored.
4. First run: launch Chrome via `scripts/connect_chrome.ps1` then `agent-browser connect 9222`; the
   SSO login + email OTP, and the DPAPI password-capture snippet (`references/login-flow.md` →
   "First-time capture"), are done in the visible Chrome window / a **real terminal** (`Read-Host`
   needs a console). After that the profile + `qid.bin` persist.
5. If Chrome is installed somewhere non-standard, edit the path in `scripts/connect_chrome.ps1`. If
   the Qualcomm ID differs, update it in the Configuration table + `references/login-flow.md`.

## Troubleshooting

**`Failed to read … (os error 10060)` on `agent-browser connect 9222` — TWO distinct causes.**

*Cause A (most common now, real Chrome): localhost → IPv6 mismatch.* `connect <port>` targets
`http://localhost:<port>`. On Windows `localhost` resolves to IPv6 `::1` FIRST, but Chrome
`--remote-debugging-port` binds ONLY IPv4 `127.0.0.1` — no `::1` listener → SYN timeout → 10060.
Diagnose: `curl -s http://127.0.0.1:9222/json/version` returns HTTP 200 (Chrome is fine) yet
`connect 9222` still times out. **Fix:** connect via the explicit IPv4 ws:// URL —
`agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"` (the `webSocketDebuggerUrl`
from `/json/version`). The patched `connect_chrome.ps1` prints this exact command.

*Cause B (legacy, bundled Chromium):* — the symptom that forced the
move to real Chrome. Root cause observed: agent-browser's bundled Playwright Chromium had a
freshly-downloaded build (`chrome-150.x`, dated newer than the working `chrome-149.x`) whose CDP
handshake timed out; every failed `open` also left an **orphaned bundled Chromium** behind (they pile
up) plus a **stale `~/.agent-browser/default.pid` / `default.port`** pointing at a dead daemon (which
makes the next launch report *"daemon already running"* then time out). Fix that is now the default
flow:
1. Stop the dead daemon + orphaned bundled Chromium **only** (path-filtered so the user's real Chrome
   is untouched):
   ```powershell
   Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
     Where-Object { $_.ExecutablePath -like "*\.agent-browser\*" } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   Get-Process agent-browser-win32-x64 -ErrorAction SilentlyContinue | Stop-Process -Force
   Remove-Item "$env:USERPROFILE\.agent-browser\default.pid","$env:USERPROFILE\.agent-browser\default.port","$env:USERPROFILE\.agent-browser\default.stream" -Force -ErrorAction SilentlyContinue
   ```
2. Launch real Chrome + attach: `scripts/connect_chrome.ps1` then `agent-browser connect 9222`
   (Phase 0). This avoids the bundled Chromium entirely.

**"Input redirection is not supported"** (Windows). The skill ran in a non-interactive shell whose
stdin is redirected; a console app waiting on stdin is blocked. Fixes: launch Chrome with
`Start-Process`, NOT the `&` call operator (it inherits the redirected handle); agent-browser
auto-denies confirmation prompts when stdin is not a TTY, so it does NOT block — do not pass
`--confirm-interactive`. Do NOT bolt `< /dev/null` onto agent-browser commands: that is bash-only
and fails in PowerShell/cmd with *"The system cannot find the path specified"* (`/dev/null` is read
as a literal path). If a command truly needs empty stdin, use the right token for the shell —
`< /dev/null` (bash), `< $null` (PowerShell), `< NUL` (cmd). Full notes in
`references\login-flow.md`.

**PowerShell syntax via the Bash tool.** `if (...) { ... }` is PowerShell, not POSIX sh — running it
through a Git-Bash shell errors with `eval: syntax error near unexpected token '{'`. Run PowerShell
snippets with the PowerShell tool (or `powershell -File …`), and POSIX one-liners with Bash.
