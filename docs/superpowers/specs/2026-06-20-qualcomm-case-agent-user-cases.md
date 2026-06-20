# qualcomm-case-agent — User Cases

- Date: 2026-06-20
- Status: review
- Related: [2026-06-20-qualcomm-case-agentic-pipeline-design.md](2026-06-20-qualcomm-case-agentic-pipeline-design.md)

## UC-1: First-time setup (new machine)

**Actor:** User  
**Trigger:** Clone repo, never run before  
**Steps:**
1. Install agent-browser, Node
2. Open REAL terminal → `agent-browser open <profile>` → login Okta → paste email OTP
3. Session saved to `data/chrome-profile/`

**Success:** Profile exists, next run skips login  
**Failure:** No email access → blocked (OTP expires ~5 min)

---

## UC-2: Sync case — happy path (session valid)

**Actor:** User (Claude Code or Cline)  
**Trigger:** "sync case CASE-01234567"  
**Steps:**
1. Agent receives case code
2. Stage 1: `node .claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs CASE-01234567` → exit 0
3. Hash differs from `_index.json` → Stage 2 enrichment
4. `render_case.mjs` → 3 files
5. Report: counts, root cause, paths

**Success:** `data/cases/CASE-01234567.json` + `.report.md` + `.md` + `.html`

---

## UC-3: Sync case — session expired

**Actor:** User  
**Trigger:** "sync case ..." → Stage 1 exits code 3 (auth-needed)  
**Steps:**
1. Agent: "Session expired. Open browser at `data/chrome-profile/`, login Okta, paste OTP."
2. User logs in
3. Agent retry Stage 1

**Success:** Continue UC-2  
**Failure:** User has no email access → stop

---

## UC-4: Incremental sync — case unchanged

**Actor:** User  
**Trigger:** "sync case CASE-01234567" (second run, case not updated)  
**Steps:**
1. Stage 1 runs, extract → hash == `_index.json` hash
2. Agent: "No update. Last synced [timestamp], [N] comments."

**Success:** Skip enrich/render, report "no update"

---

## UC-5: Case updated (new comments)

**Actor:** User  
**Trigger:** "sync case ..." → hash differs  
**Steps:**
1. Stage 1 ok, new hash
2. Stage 2: enrich all comments (including old ones)
3. Re-render → overwrite 3 files
4. `_index.json` updated

**Decision:** Enrich only new comments (ids not yet in `enrichment.commentSummaries`).  
Case-level fields (`engineerSummary`, `rootCause`, `tags`, `timeline`) re-generated each time new comments arrive — they synthesize the full case, so must reflect latest state.  
Existing comment summaries preserved (not re-run).

---

## UC-6: Raw-only sync (skip enrichment)

**Actor:** User or orchestrator  
**Trigger:** "sync case CASE-01234567 --raw-only" or "fast sync"  
**Steps:**
1. Stage 1 ok
2. Skip Stage 2
3. `render_case.mjs` runs with raw only (no `enrichment` key)
4. `.report.md` shows placeholder for engineer summary

**Use case:** Fast, token-efficient; useful when only raw data needed for downstream indexer

---

## UC-7: Re-run enrichment (no re-scrape)

**Actor:** User  
**Trigger:** "re-enrich case CASE-01234567" (improved prompt, no portal hit needed)  
**Steps:**
1. Read `data/cases/CASE-01234567.json` (raw already cached)
2. Stage 2 runs again → overwrite `enrichment{}` key
3. Re-render

**Success:** Raw + hash unchanged; only `enrichment` + `enrichedAt` updated

**Decision:** Agent detects intent from user message (e.g. "re-enrich", "redo analysis", "improve summary", "update enrichment").  
Before running, agent asks: "Do you want to customize the enrichment prompt? (Enter to keep default)"  
User can paste custom instructions → agent uses them for this run only (not persisted).  
If user skips → default prompt.

---

## UC-8: Case not found / no access

**Actor:** System  
**Trigger:** Stage 1 → exit code 4  
**Steps:**
1. Agent: "Case CASE-XXXXXXXX not found or not accessible with current account."
2. STOP

---

## UC-9: Incomplete capture (count mismatch)

**Actor:** System  
**Trigger:** Stage 1 → exit code 5 (`comments.length < displayedCommentCount` after ALL fallbacks exhausted)  
**Requirement:** Full capture is mandatory — partial is NOT acceptable.

**Stage 1 internal flow (before emitting exit 5):**
1. Fixpoint expand loop → assert count
2. If `count < displayedCommentCount` → switch to progressive scroll fallback (scroll step-by-step, extract + merge into `Map` keyed by stable id)
3. If Map still incomplete → exit code 5

**Agent steps on exit 5:**
1. Report: "Captured N/M comments after all fallbacks. Selector mismatch likely."
2. Trigger LLM selector re-discovery (same as UC-10)
3. Retry Stage 1
4. If still exit 5 after re-discovery → STOP, report to user for manual investigation

**Decision:** Never accept partial. Exit 5 = technical failure → fix selectors.

---

## UC-10: Selector config missing/stale

**Actor:** System  
**Trigger:** Stage 1 → exit code 6 (no `config/selectors.json` or schema mismatch)  
**Steps:**
1. Agent: LLM selector discovery (snapshot real DOM)
2. Write `config/selectors.json`
3. Retry Stage 1

---

## UC-11: Multi-case sync (orchestrator)

**Actor:** Orchestrator workflow  
**Trigger:** Loop over a list of case codes  
**Steps:**
1. Call agent per case code sequentially (single-instance browser profile lock)
2. Collect per-case results

**Note:** Not built-in to this skill; orchestrator loops by calling agent once per case
