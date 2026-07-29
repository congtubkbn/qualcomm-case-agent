# Workflow — input, processing, output — reference

How the Qualcomm Case Management Agent runs end to end. Companion to `SKILL.md` (phase detail),
`login-flow.md` (auth) and `manual-flow.md` (hand-driven fallback + selector/extraction detail).

**Capture is one command, not an interactive script.** A valid 8-digit code goes straight to
`run_case.mjs` — no "update from portal?" question, no confirmation step. The cache decides
new-vs-update on its own; the model only sees the verdict line.

## Flow

```mermaid
flowchart TD
  IN(["Input — 1 Qualcomm case code"]) --> VALID{"8 digits?<br/>(CASE- prefix stripped)"}
  VALID -->|no| S0(["ask user, STOP"])
  VALID -->|yes| RUN["run_case.mjs &lt;CODE&gt;<br/>attach persistent Chrome (CDP 9222) · open global-search<br/>resolve + open case · expand feed (full new / incremental update)<br/>extract · finalize (hash + index) · verify_case.mjs · render · PDF"]
  RUN --> V{"verdict (one JSON line on stdout)"}
  V -->|created| ENRICH["PHASE 3 · enrich ALL comments"]
  V -->|updated| ENRICHNEW["PHASE 3 · enrich only newCommentIds"]
  V -->|no-update| REPORT_NU["PHASE 5 · report 'no update', STOP"]
  V -->|auth-required| AUTH["Recovery 1 (login-flow.md)<br/>human: Okta password + email OTP<br/>then re-run run_case.mjs"]
  V -->|not-found| S1(["STOP — wrong code / no access"])
  V -->|blocked| MANUAL["manual-flow.md fallback<br/>finish the capture by hand"]
  V -->|busy| RETRY["wait ~30s, retry ONCE<br/>still busy → treat as blocked"]
  AUTH --> RUN
  ENRICH --> REPORT["PHASE 5 · report to user"]
  ENRICHNEW --> REPORT
  MANUAL --> REPORT
  REPORT --> OUT
  subgraph OUT["outputs — data/cases/&lt;CODE&gt;/"]
    O1["case.json — complete data (source of truth)"]
    O2["case.report.md — concise summary"]
    O3["case.md + case.html + case.txt — full human review"]
    O4["case.pdf — printed archive"]
    O5["_index.json (root) — sync state across cases"]
  end
```

## Input

One Qualcomm case code — exactly 8 digits, `CASE-` prefix accepted and stripped. Anything else →
ask the user, STOP. A valid code never triggers a confirmation prompt.

## Processing (per phase)

| Phase | Does | Guard / branch |
|-------|------|----------------|
| Capture (`run_case.mjs`) | attach persistent-profile Chrome · locate case via global-search · expand feed (full for a new case, only down to the newest cached comment for an update) · extract · finalize with hash + index · self-verify (`verify_case.mjs`) · render · PDF | one JSON verdict line on stdout — see status table below |
| 3 Enrich | `created` → all comments; `updated` → only `newCommentIds`; per-comment `summary`/`role`/`keyPoints`/`citations`/`answered`, then re-synthesize case-level fields (`engineerSummary`, `rootCause`, `caseFlow`, `openQuestions`, `recommendedActions`, `tags`, `timeline`) | `no-update` skips this phase entirely |
| 5 Persist + report | write `enrichment` back to `case.json` → `render_case.mjs` → tell user counts (captured vs displayed), root cause, open questions, file paths | PDF failure is reported, never silently dropped |

## Verdict statuses (`run_case.mjs` stdout)

| `status` | exit | Meaning | Next step |
|----------|------|---------|-----------|
| `created` | 0 | new case captured | PHASE 3 (all comments) → PHASE 5 |
| `updated` | 0 | new comments merged | PHASE 3 (`newCommentIds` only) → PHASE 5 |
| `no-update` | 0 | nothing new since `since` | PHASE 5: "no update", STOP |
| `auth-required` | 3 | saved Okta session lapsed | human manual login (`references/login-flow.md`), then re-run |
| `not-found` | 4 | search returned nothing | STOP |
| `blocked` | 5 | page never rendered / capture short | `references/manual-flow.md` fallback |
| `busy` | 6 | another capture holds the lock | wait ~30s, retry once; still busy → treat as blocked |
| `error` | 1 | bad invocation / script failure | fix per `reason`, don't retry blindly |

## Output (per-case folder `data/cases/<CODE>/`)

| File | Producer | Purpose |
|------|----------|---------|
| `case.json` | `run_case.mjs` (capture) + model (enrichment) | complete verbatim data + enrichment — **source of truth** |
| `case.report.md` | `render_case.mjs` | concise summary report |
| `case.md` + `case.html` + `case.txt` | `render_case.mjs` | full render for human review |
| `case.pdf` | `run_case.mjs` (agent-browser `pdf`) | print archive of the HTML |
| `_index.json` (root) | `scrape_case.mjs` | `<CODE> → {syncedAt, commentCount, hash}` for incremental sync |
| `chrome-profile/` | real Chrome `--user-data-dir` | persistent auth profile (one-time login) |

## Logic backbone

1. **Session > password** — log in once, reuse the Chrome `--user-data-dir` (real Chrome via CDP);
   email OTP only when the session lapses, and only ever entered by the human.
2. **One command, no ask** — a valid code always runs; the script itself decides new-vs-update from
   `_index.json`. The only prompts are inside PHASE 3 for a genuinely large enrichment batch.
3. **Expand + count assert** — accessibility-tree clicks reveal every post/reply/body; the
   `displayedCommentCount` assert guarantees nothing is missed or truncated before persisting.
4. **Incremental** — an update run expands/extracts/enriches ONLY the new comments (`--merge`
   prepends them, everything cached is kept verbatim) and re-renders the outputs; an unchanged case
   is not re-enriched or rewritten.
5. **Role split** — the script owns capture + persistence (deterministic, token-cheap); the model
   owns enrichment (judgement) and the user-facing report.
6. **Fail-fast guards** — every non-`created`/`updated`/`no-update` verdict names its own recovery
   path; never guess credentials, never fabricate data.
