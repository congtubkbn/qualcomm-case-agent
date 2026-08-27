# 0002. Add case-summary as a separate skill instead of reopening ADR 0001

Date: 2026-08-22
Status: Accepted, partially superseded 2026-08-27 (see Addendum)

ADR 0001 dropped all model-in-the-loop analysis from `qualcomm-case-agent`'s capture pipeline. A
later need arose — Case Status visibility, per-comment Comment Summaries, and a Case Flow narrative
for an engineer reviewing a case — that resembles what ADR 0001 removed. Rather than reopening ADR
0001, this is built as `qualcomm-case-summary`: a separate, read-only downstream skill that only
reads `case.json`/`case.md` (per the existing `references/consumer-guide.md` consumer pattern),
writes its own `summary.json`/`summary.md`, and never modifies `qualcomm-case-agent`'s capture
pipeline, comment storage order, or merge logic.

## Considered Options

- **Reopen ADR 0001** and put analysis back into the capture pipeline. Rejected: capture's "zero
  model tokens, deterministic" invariant is load-bearing and tested; re-coupling analysis to
  capture would also re-couple their token-cost and failure characteristics.
- **A configurable summarization skill** with a caller-selectable scope (single comment / several /
  all) and multiple summary "styles". Rejected as premature flexibility (CLAUDE.md's "Simplicity
  First"); replaced by an always-delta model (summarize whatever is new since the last run) with
  one fixed summary shape.
- **Reverse `case.json`/`case.md`'s stored comment order to newest-first**, to make the latest
  comment visible immediately. Rejected: that order is load-bearing for `qualcomm-case-agent`'s
  merge/dedup tie-break logic, has a dedicated PRD (`docs/prd/case-comment-flow-sorting.md`) and
  test file (`tests/chronological_sort.test.mjs`), and existing cached cases already use it. The
  actual need — see the latest state first — is a presentation concern, satisfied by `summary.md`
  rendering newest-first without touching the source of truth.

## Consequences

- `qualcomm-case-summary` duplicates none of ADR 0001's removed code, but does reintroduce the
  underlying idea (Case Flow, Comment Summary) in a new, isolated file (`summary.json`) that
  `qualcomm-case-agent` never reads or carries forward — so a future re-capture cannot resurrect
  stale analysis the way the old `enrichment` field did.
- Two independently-evolving comment orderings now exist in this repo: `case.json`/`case.md`
  (Oldest → Newest, canonical) and `summary.md` (newest-first, presentation-only). Anyone reading
  comment order must check which file they're in.

## Addendum (2026-08-27): the rejected option, adopted after all

Reversed on explicit user request (case 08516422 review): `case.json`/`case.md` now persist
comments **newest-first**, with each Reply grouped immediately after its parent Post (also
newest-first among siblings) — `scrape_case.mjs`'s `orderCommentsForPresentation`, applied as a
final pass after the internal merge/dedup engine (`sortCommentsChronological`, unchanged, still
ascending — that engine's ordering is still load-bearing for tie-break/interpolation, just no
longer what gets persisted). This supersedes PRD #105-109's "Variant A" (strict Oldest → Newest,
no renumbering by thread) and the "rejected" bullet above.

Consequence: the "two independently-evolving orderings" problem above is gone — `summary.md`
(via `qualcomm-case-summary`'s `merge.mjs`/`render_summary.mjs`) now simply mirrors `case.json`'s
order (new batch prepended, no reverse needed) instead of independently reversing it. See
`CONTEXT.md`'s Capture/Reply entries for the current contract.
