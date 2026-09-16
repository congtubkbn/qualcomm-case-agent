# 0007. Remove the Summarize workflow entirely

Date: 2026-09-16
Status: Accepted

ADR 0002 added case summarization (`qualcomm-case-summary`) as a separate downstream skill,
later folded into `qcomm` by ADR 0006. In practice the Summarize workflow (`run_summary.mjs`
and its prepare/finalize CLI, `summary.json`/`summary.md`, and the dashboard's AI-summary
column) went unused: nobody ran it, and it added maintenance surface — a second comment
ordering to keep straight, a second persisted schema, a second set of tests — without value.
This reverses ADR 0002/0006's Summarize consolidation, not the consolidation itself: capture
(`run_case.mjs`), delete (`delete_case.mjs`), and overview (`cases_overview.mjs`) still live
together under `qcomm`.

## Decision

Delete the Summarize workflow completely rather than leave it dormant:

- `run_summary.mjs` and its `qcomm_summary_*.test.mjs` tests.
- `SKILL.md`'s Summarize section and its `references/workflow.md` (entirely about Summarize).
- `references/consumer-guide.md`'s `summary.json` schema rows and its `run_summary.mjs`
  cross-reference.
- `overview_store.mjs`'s `extractAiSummary` and the `aiSummary`/`hasSummary` overview fields;
  the dashboard's corresponding AI-summary block/CSS and the CLI table's `Summary:` line.
- Any existing `data/cases/<CODE>/summary.json`/`summary.md` cache files, gated by the same
  explicit-chat-confirmation pattern as case Delete (ADR 0003) — since it destroys local,
  git-ignored, NDA-protected data. (At the time this ADR was written, no cached case carried
  either file, so this ran as a no-op check rather than a live deletion.)
- The domain terms this workflow alone motivated — **Comment Summary**, **Case Flow**, and
  **Delta (comments)** in `CONTEXT.md` — since a term for a deleted capability is worse than no
  term: a future reader who finds it will look for the code that no longer exists.

`qcomm`'s `getStatusCategory`'s `ballInCourt` parameter is explicitly kept, not removed by this
ADR: neither this ticket nor its parent authorizes touching the `pending_qualcomm`/
`pending_customer` status-badge behavior it drives, and removing it would be its own,
undiscussed behavior change. Its only producer (`summary.json`'s `executive.ballInCourt`) is
gone, so it reads as `null` for every case going forward — `getStatusCategory` falls through to
status-text matching, same as it already does for any case without a summary today. This is a
known, accepted follow-up gap, not an oversight: a future ticket should either wire a new
producer for `ballInCourt` or remove the parameter along with the dead read path in
`overview_store.mjs`'s `extractCaseOverview`.

## Considered Options

- **Leave `run_summary.mjs` in place, unwired from any runbook.** Rejected: dead code that still
  runs (via `npm run case:summary`) is worse than dead code that is gone — it invites a future
  contributor to "fix" and re-wire something the team already decided not to maintain, and it
  still has to be read and reasoned about during every unrelated refactor of the modules it
  imports (`overview_store.mjs`, `finalize_case.mjs`, `comment_tree.mjs`).
- **Keep `summary.json`/`summary.md` as a passive, never-written schema for potential future
  reuse.** Rejected: nothing currently produces it, so every reader of `consumer-guide.md` or
  `case.json`'s neighborhood would be pointed at a file that never exists — the exact
  "documented capability that silently yields nothing" trap `docs/DESIGN.md`'s I5 already warns
  against for a different field.
- **Remove `ballInCourt` along with `aiSummary`/`hasSummary`, since its only data source is
  gone too.** Rejected here: out of scope for this ticket (see Decision above); tracked as a
  follow-up instead of bundled into an unrelated removal.

## Consequences

- `qcomm` exposes exactly 3 workflows going forward: Fetch/Sync, Delete, Overview.
- `getStatusCategory(status, ballInCourt)` keeps a parameter whose only real-world value is now
  always `null`; a future reader should not assume `ballInCourt` is reachable without first
  checking whether a new producer for `summary.json`'s `executive.ballInCourt` shape exists.
- The `_Avoid_` guidance CONTEXT.md carried for the terms this ADR deletes (**Comment Summary**,
  **Case Flow**, **Delta (comments)**) is not itself deleted — it moves here: do not resurrect
  the words "Comment Summary", "Case Flow", or "Delta" for a new feature without first reading
  this ADR, the same way "enrichment" was retired by ADR 0001 and never reused.
