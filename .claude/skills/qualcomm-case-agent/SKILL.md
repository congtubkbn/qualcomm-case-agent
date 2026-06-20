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

All paths below are **relative to the workspace root** (the access-qualcomm project = the current
working directory / VS Code workspace folder). No absolute or machine-specific paths — portable
across PCs and agents.

| Key | Value |
|-----|-------|
| Project root | the workspace root / CWD (run from the access-qualcomm folder) |
| Portal | `https://support.qualcomm.com` (formerly CreatePoint) |
| SSO | `https://account.qualcomm.com/...` (Okta — user signs in manually) |
| Qualcomm ID | `the.thoi@samsung.com` (login id only — NEVER the password) |
| MFA | **Email OTP** — 6-digit code to the Samsung mailbox, expires ~5 min. User pastes it; Claude cannot read the mailbox |
| Session store | `data\chrome-profile\` (persistent Chrome profile via agent-browser `--profile`; git-ignored — sign in ONCE) |
| Case cache | `data\cases\<CODE>.json` (full) · `<CODE>.report.md` (summary) · `<CODE>.md` + `<CODE>.html` (full review) |
| Sync index | `data\cases\_index.json` (`<CODE> → { syncedAt, commentCount, hash }`) |
| Render script | `.claude\skills\qualcomm-case-agent\scripts\render_case.mjs` — `node <that> data\cases\<CODE>.json` writes `.report.md` + `.md` + `.html` |
| References | `references\workflow.md` (+`workflow.svg`), `references\login-flow.md`, `references\extraction.md` |

> Use forward slashes in agent-browser/Node args on Windows. Convert `<CODE>` to a safe filename
> (uppercase alpha, strip path-illegal chars).

---

## PHASE 0 — Intake & environment

- **Goal:** validate input; prepare the workspace.
- **Action:**
  1. Load the agent-browser reference: run `agent-browser skills get core --full` (mandatory).
  2. Validate + normalize the case code (trim; uppercase alpha; reject if it contains path-illegal
     chars `\ / : * ? " < > |`).
  3. Ensure cache dirs exist: `data\cases\`. Create `data\cases\_index.json` = `{}` if absent.
- **Guard:** no case code → ask the user and STOP.

## PHASE 1 — Authenticate (session reused; email OTP is human-in-the-loop)

Full step-by-step + failure handling: **`references\login-flow.md`**. Summary:

- **Goal:** an authenticated Qualcomm Support session by reusing the persistent Chrome profile.
- **Action (profile-first):** always launch with the SAME `--profile` directory. The profile holds
  cookies/tokens and persists between runs automatically — there is no separate "save" step.
  ```bash
  P="data/chrome-profile"     # relative to the workspace root
  # Headed so the user can sign in if the profile session has lapsed.
  agent-browser --headed --profile "$P" open "https://support.qualcomm.com"
  agent-browser snapshot -c
  ```
- **Decision:**
  - Dashboard loads (profile session still valid) → continue to Phase 2. **No login, no OTP.** Normal path.
  - Redirected to `account.qualcomm.com` (Okta) → **STOP and tell the user to sign in** in the open
    browser: they enter the Qualcomm ID password, then **paste the 6-digit email OTP**. Wait, then
    re-`snapshot` to confirm the dashboard. The profile stores the new session automatically — nothing
    else to do. Re-login on expiry is expected and accepted (no notification).
  - **Email unavailable:** a fresh login REQUIRES the email OTP. If the profile session has expired
    AND the user can't reach the mailbox, you cannot authenticate — report plainly and STOP. Do not
    loop. (A still-valid profile bypasses OTP entirely, so this only bites after expiry.)
- **Never** type the Qualcomm ID password or the OTP. Never write either to disk or output.

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
- **Auth:** never type the Qualcomm ID password or email OTP. Human signs in ONCE; the persistent
  Chrome profile (`data\chrome-profile\`, used via `--profile`) keeps the session across runs so no
  re-login/OTP until it expires. On expiry, the human simply signs in again in the same profile (no
  notification). See `references\login-flow.md`.
- **Secrets:** password/OTP never stored in this skill, in outputs, or any plaintext file. The
  `data\chrome-profile\` directory (and any `*.session.json`) is git-ignored.
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
- Use Cline's **execute_command** for every `agent-browser` / `node` line, and its file tools for
  read/write. Do **not** use Cline's built-in `browser_action` — this skill drives the standalone
  `agent-browser` CLI (its own Chromium + persistent `--profile`), which `browser_action` cannot do.
- `AGENTS.md` at the project root is a generic pointer for any other agent.

## Setup on a new Windows machine

1. Install Node.js (≥18) + the CLI: `npm i -g agent-browser`, then `agent-browser install`
   (downloads the bundled Chromium — NOT system Chrome).
2. Copy the **whole project folder** to the new PC. The skill travels inside
   `.claude/skills/qualcomm-case-agent/`. (For Claude Code use outside this project, also copy the
   skill to `~/.claude/skills/`.)
3. Do **not** copy `data/chrome-profile/` or `data/cases/` — the profile cookies are DPAPI-encrypted
   to the old Windows user (won't decrypt → must re-login anyway); case content is NDA. Both are
   git-ignored.
4. First run: the headed SSO login + email OTP must be done in a **real terminal** (browser launch
   hangs in a redirected/automation shell — see Troubleshooting). After that the profile persists.
5. If the Qualcomm ID differs, update it in the Configuration table + `references/login-flow.md`.

## Troubleshooting

**"Input redirection is not supported"** (Windows). The skill ran in a non-interactive shell whose
stdin is redirected; a console app waiting on stdin is blocked. Fixes: run agent-browser
non-interactively (it auto-denies confirmation prompts when stdin is not a TTY — do not pass
`--confirm-interactive`); do one-time interactive setup (`agent-browser install`, first SSO login)
in a REAL terminal. Full notes in `references\login-flow.md`.
