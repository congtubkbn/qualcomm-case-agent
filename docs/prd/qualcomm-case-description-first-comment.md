# PRD: Qualcomm Case Description as Initial Comment

## Problem Statement

When engineers and AI agents analyze a Qualcomm case:
1. **Missing Initial Context in Timeline**: The case `Description` (which contains the customer's initial problem report, reproduction logs, test conditions, and SW build details) is stored solely as a static root attribute or rendered in a detached section.
2. **Disconnected Narrative Flow**: In the case timeline (`## Chronological Timeline of Comments`) and AI summary (`qualcomm-case-summary`), the chronological history begins with Comment #1 (often a triage or follow-up response like *"I will check and update"*), leaving the AI summary and engineer missing the foundational problem statement in the timeline.
3. **Redundant UI Duplication**: In `case.md`, `Description` was rendered both as an isolated header and disconnected from subsequent discussions, leading to duplicate or disjointed context.

## Solution

1. **Inject `Description` as Comment #0 / Comment #1 in `case.json`**:
   - Extract `description` from the case page and, if non-empty, synthesize an initial comment representing the problem statement.
   - Assign deterministic metadata:
     - `author`: Case submitter / `customer` (fallback to `"Reporter"`).
     - `timestamp`: Case creation date (`created`), ensuring it sorts to the beginning of the timeline.
     - `id`: Stable content-derived SHA-256 hash.
     - `summary`: Deterministic 1–2 sentence preview via `extractSummary(description)`.
2. **Keep Root `description` for Backward Compatibility**:
   - Retain `case.description` at the root of `case.json` for compatibility with existing tools and metadata headers.
3. **Unified Timeline & Summary Rendering**:
   - In `render_case.mjs`: Remove the standalone `## Description` block; allow the description to appear naturally as the first comment in the chronological timeline.
   - In `qualcomm-case-summary`: The AI summarization pipeline seamlessly treats this initial comment as `kind: "Problem Statement"`, integrating it into `## Case Flow` and the executive root cause analysis.
4. **Idempotent Ingestion & Migration**:
   - Handle deduplication in `scrape_case.mjs` so incremental `--merge` runs never duplicate the description comment.
   - Provide a migration path in `tools/migrate_case.mjs` to upgrade existing cached cases.

## User Stories

1. As an engineer reviewing a case markdown file (`case.md`), I want the case description to appear as the very first entry in the chronological timeline of comments, so that I can read the problem report in natural sequence before the engineer responses.
2. As a support engineer or triage lead, I want the description comment to reflect the case submitter/customer as the author and the case creation timestamp, so that the metadata accurately reflects who reported the issue and when.
3. As an AI summarization agent (`qualcomm-case-summary`), I want the initial description to be part of the `comments` list, so that the generated `## Case Flow` captures the initial symptoms, reproduction steps, and baseline SW build without special-case logic.
4. As an automated updater running `scrape_case.mjs --merge`, I want the description comment injection to be idempotent, so that running repeated merges does not create duplicate comments or overwrite existing chatter data.
5. As a maintainer with existing cached cases, I want `tools/migrate_case.mjs` to seamlessly backfill description comments into existing `case.json` files, so that all legacy cases adhere to the new unified timeline structure.

## Implementation Decisions

### 1. Data Contract & Schema (`case.json`)
- `case.description`: Retained as a string at root.
- `case.comments`: Array of comment objects. If `case.description` is non-empty and not already present in `comments`, a comment is prepended:
  ```json
  {
    "id": "<content-hash>",
    "timestamp": "<case.created>",
    "author": "<case.customer || 'Reporter'>",
    "summary": "<extractSummary(description)>",
    "body": "<case.description>",
    "attachments": []
  }
  ```

### 2. Ingestion & Merge Layer (`scrape_case.mjs`)
- `scrape_case.mjs` inspects `raw.description`. If present, it injects the synthetic comment into the comments candidate list before `assignIds()` and `sortCommentsChronological()`.
- When `--merge` is executed, content-hash deduplication (`mergeComments`) prevents duplicate entries.

### 3. Rendering Layer (`render_case.mjs` & `render_summary.mjs`)
- `render_case.mjs`: Drop the standalone `## Description` section so `case.md` avoids redundant text, rendering the description directly in `## Chronological Timeline of Comments`.
- `render_summary.mjs`: Continues rendering `comments` as provided, naturally showing the problem statement in the summary timeline.

### 4. Migration Tooling (`tools/migrate_case.mjs`)
- Update `migrateCase()` to check if `description` exists at root but is absent from `comments`, injecting it and re-sorting chronologically.

## Testing Decisions

- Test pure units without network or browser dependencies:
  - `scrape_case.mjs`: Verify synthetic description comment generation with correct author, timestamp, ID, and preview summary.
  - `scrape_case.mjs --merge`: Verify idempotency when merging multiple times.
  - `render_case.mjs`: Verify `case.md` omits standalone `## Description` and renders Comment #1 properly.
  - `migrate_case.mjs`: Verify legacy cases are upgraded accurately without clobbering existing chatter posts.
- Ensure all existing test suites (`tests/extract_case.test.mjs`, `tests/chronological_sort.test.mjs`, `tests/render_case.test.mjs`, `tests/scrape_case.test.mjs`) remain 100% passing.

## Out of Scope

- Modifying Salesforce portal Chatter or DOM rendering logic.
- Synthesizing placeholder descriptions for cases where the portal description is empty.
- Fetching external attachments mentioned only inside description plaintext.
