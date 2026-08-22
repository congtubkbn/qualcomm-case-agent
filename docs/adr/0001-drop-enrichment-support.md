# 0001. Drop enrichment support

Date: 2026-08-22
Status: Accepted

## Context

The pipeline used to have a second phase beyond capture: a model (cloud, via `SKILL.md` PHASE 3,
or a local LLM via `enrich_local.mjs`) read the freshly captured comments and wrote a per-comment
and case-level analysis into `case.json`'s `enrichment` field — root cause, open questions,
recommended actions, a chronological case flow. `scrape_case.mjs` treated that field as
model-produced and unrecoverable, so it carried it forward across every re-capture (full or
incremental), and `migrateIds` re-keyed its comment-id references whenever a legacy cache was
migrated onto content-derived ids.

`scheduler.mjs`, `web/server.mjs`, and `enrich_local.mjs` — the scheduled sync, the dashboard, and
the local-model enrichment runner — were already removed from the working tree before this
decision was written down; so was the `qualcomm-enrich` skill that offered enrichment as a
standalone analyst pass over an already-scraped case. What remained was dead weight: the
enrichment-preservation and id-remapping logic in `scrape_case.mjs`, and every doc that still
described PHASE 3 enrich, the scheduler, and the dashboard as if they were live.

## Decision

Drop enrichment support entirely, not just the already-removed runners. Specifically:

- `scrape_case.mjs` no longer carries a cached `enrichment` field forward across a re-capture, on
  either the `--merge` or the full-capture path. `migrateIds` now strips `enrichment` outright
  instead of re-keying its `commentAnalyses` / `commentSummaries` / `caseFlow[].refComments` onto
  new comment ids.
- `_index.json` no longer carries an `enrichedAt` per case.
- Every operational doc (`CLAUDE.md`, `README.md`, `docs/DESIGN.md`'s hand-written sections, the
  skill's `references/workflow.md` and `references/consumer-guide.md`) describes only the capture
  pipeline: given a case code, search the portal, save `case.json` + `case.md`. Historical decision
  records (`docs/prd/*`, `docs/superpowers/*`) are left untouched — they document past decisions,
  not current behavior.
- This is a removal, not a deprecation: no flag gates it, and the code path does not exist to be
  re-enabled without writing it again.

## Consequences

- **A case re-captured after this change loses any `enrichment` it previously held.** If a case's
  `case.json` still carries an `enrichment` blob from before this decision, the next full or
  incremental capture of that case drops the field — a full re-capture already goes through
  `migrateIds`, which strips it outright. This is a one-way, per-case data loss on next touch, not
  reversible without re-running whatever analysis produced it in the first place.
- Comment identity (`commentId` = hash of author + body prefix, assigned in the finalizer) and its
  legacy-id migration (`migrateIds`) are unaffected in their core purpose — id stability still
  matters for merge/dedup across a full re-capture, independent of enrichment ever existing.
- Simplicity/less-surface-area is traded for losing an analysis capability: nothing in this repo
  interprets a case any more. Anything reading `case.json` next (an agent, a downstream skill) is
  now solely responsible for that judgement, same as it always was for anything the enrichment
  phase itself needed beyond the raw comments.
