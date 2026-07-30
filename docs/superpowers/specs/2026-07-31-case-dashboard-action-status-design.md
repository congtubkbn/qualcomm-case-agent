# Design: dashboard action-status (waitingOn / nextAction)

**Date:** 2026-07-31
**Status:** approved by user, pending implementation plan
**Scope:** `web/app.html`, `web/server.mjs`, `enrich_local.mjs`, `SKILL.md` PHASE 3, `render_case.mjs`.

## Problem

A manager tracking ~10 Qualcomm cases via the existing dashboard (`npm run web`) can see per-case
metadata and a run-status tag, but has to open each case's Details to answer three questions that
matter every day:

1. Which cases have a new update since I last looked?
2. Which cases are waiting on **me** to respond, vs waiting on Qualcomm?
3. If I open a case, what's the one thing to do next?

Today `enrichment` already carries `engineerSummary`, `currentStatus`, `rootCause`,
`openQuestions[]`, `recommendedActions[]`, `tags[]` (see `enrich_local.mjs` `normalizeCaseLevel`
and `SKILL.md` PHASE 3). None of that distinguishes "whose turn it is" or ranks one next step
above the rest, and the list view has no unread/seen tracking at all.

## Explicitly out of scope

- A Qualcomm RAG / document-search system — raised in the same conversation, but the user
  redirected: that's a separate subsystem to be designed later, not part of this spec.
- Choosing or changing the LLM/embedding backend — enrichment keeps calling through the existing
  `enrich_local.mjs` (local server) / cloud PHASE 3 path unchanged; only the schema it must return
  grows by two fields.
- Push/desktop notifications on case update. Not requested; the badge-based unread signal below is
  sufficient for a ~10-case list checked by opening the dashboard.
- Any change to capture (`run_case.mjs`, `scrape_case.mjs`) — this is enrichment + dashboard only.

## Design

### 1. Data model — two new `enrichment` fields

Added alongside the existing case-level fields, produced by the same synthesis step that already
re-generates `engineerSummary` etc. on every enrich pass:

- `waitingOn`: `"qualcomm" | "us" | "none"` — whose turn it is. Derived from the latest comments
  and `openQuestions`: if the newest substantive comment is a request/question directed at us with
  no later reply, `"us"`; if we're waiting on a Qualcomm reply, `"qualcomm"`; if the case is
  resolved/idle with nothing outstanding, `"none"`.
- `nextAction`: one sentence, the single highest-priority next step — distinct from
  `recommendedActions[]` (which stays a fuller list). Empty string if `waitingOn` is `"none"`.

Both are optional/best-effort like the rest of `enrichment` — a missing value renders as nothing,
never an error.

### 2. Schema + prompt changes (both enrichment paths)

- `enrich_local.mjs`:
  - `normalizeCaseLevel()` gains `waitingOn` (coerced to one of the three enum values, default
    `"none"` if the model returns anything else) and `nextAction` (`str()`, same as other free-text
    fields).
  - `casePrompt()`'s "Return JSON exactly like" block gains
    `"waitingOn":"qualcomm|us|none","nextAction":"..."`.
- `SKILL.md` PHASE 3 (step 4 + the JSON example block): same two fields added to the instruction
  list and the example JSON, worded the same way as `enrich_local.mjs`'s prompt so both paths
  produce consistent values.

### 3. Render output — surface the new fields

`render_case.mjs` prints each enrichment field explicitly per format; the two new fields need the
same treatment in all four render paths (`case.md`, `case.report.md`, `case.html`, `case.txt`),
placed near `currentStatus`/`rootCause` since they're similarly case-level status. `nextAction`
renders only when non-empty; `waitingOn` renders as a labeled line (e.g. "Waiting on: Qualcomm").

### 4. List view (`web/app.html`, collapsed card)

- A `waitingOn === "us"` case gets a prominent badge (reuse the existing `.tag.warn`/`.tag.bad`
  style) reading "waiting on you", visible without opening Details.
- A case whose `syncedAt` is newer than the locally-remembered `lastSeenAt` for that code gets a
  "NEW" badge (see §5).
- Default sort order changes from "most recently synced first" to: `waitingOn === "us"` first,
  then unseen (`NEW`), then the rest by `syncedAt` descending — same as today within each group.
  This is purely a client-side sort in `render()`; `server.mjs`'s `/api/overview` ordering is
  unchanged (client re-sorts what it receives).

### 5. Read/unread tracking — client-side only

- On Details open, `app.html` writes `localStorage['qc-seen:<code>'] = c.syncedAt`.
- `NEW` badge shows when `localStorage['qc-seen:<code>']` is absent or older than `c.syncedAt`.
- No server/API change — `/api/overview` already returns `syncedAt` per case.

### 6. Detail view (`web/app.html`, expanded card)

- New "Next action" callout, placed above "Summary", styled distinctly (left border in accent
  color) so it reads as the one-line takeaway.
- `waitingOn` badge repeated here next to `currentStatus`, so the reason is visible alongside the
  status text already shown.

## Testing

- Unit: extend `enrich_local.mjs`'s existing coercion tests (`normalizeCaseLevel`) with cases for
  each `waitingOn` value and an invalid enum value falling back to `"none"`.
- Unit/manual: `render_case.mjs` output for all four formats includes the new fields when present
  and omits them cleanly when absent (existing pattern for optional fields).
- Manual: `npm run web`, confirm sort order and badges against a couple of cached cases with
  different `waitingOn` values (can hand-edit a cached `case.json`'s `enrichment` for this rather
  than waiting on a live enrich pass).
