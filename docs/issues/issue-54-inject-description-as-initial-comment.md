---
ID: #54
Status: AFK
Blocked by: []
Type: Tracer Bullet
---

# Issue #54: scrape_case.mjs: Inject Case Description as Initial Comment

## Parent
- PRD: #53

## What to build

Update `scrape_case.mjs` so that when processing raw case data:
1. If `raw.description` has non-empty text and is not already present in the comments list, synthesize an initial comment:
   - `author`: `raw.customer || "Reporter"`
   - `timestamp`: `raw.created || ""`
   - `summary`: `extractSummary(raw.description)`
   - `body`: `raw.description`
   - `attachments`: `[]`
2. Integrate this comment into `assignIds()` and `sortCommentsChronological()` so it receives a stable content-derived ID and naturally sorts to the start of the timeline.
3. Ensure `--merge` and deduplication logic (`mergeComments`) treat this comment as standard and idempotent, preventing duplicate entries across repeated scrapes.

## Acceptance criteria

- [ ] Non-empty `description` is injected as a comment in `case.json`.
- [ ] Comment metadata (`author`, `timestamp`, `summary`, `body`) is populated accurately.
- [ ] Stable content hash ID is generated via `assignIds()`.
- [ ] Repeated `--merge` invocations do not duplicate the description comment.
- [ ] Empty or whitespace-only descriptions do not create blank comments.

## Blocked by

- None (can start immediately).
