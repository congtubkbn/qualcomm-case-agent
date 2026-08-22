# PRD: Qualcomm Case Comment Extraction & Chronological Flow Sorting

## 1. Problem Statement
In Qualcomm Salesforce Chatter, comments and nested replies are rendered in DOM order (typically newest at the top, or nested threads). Currently:
1. `extract_case.js` misses timestamps for some comments/replies (e.g., when timestamps are in `<span>`, `<time>`, or non-link elements), leaving `timestamp: ""`.
2. `scrape_case.mjs` sorts comments using `parseTimestamp(c.timestamp)`. Unparsed or empty timestamps return `0`, causing the newest comments (which lacked timestamps) to be pushed to the very top (index 1..10) as if they were the oldest.
3. Role classification in `extract_case.js` occasionally misclassifies Qualcomm engineers as "Customer" when company metadata is omitted from DOM tags.
4. `render_case.mjs` outputs a timeline that does not clearly distinguish between Qualcomm engineers and Customers, making it hard to follow the case progress flow.

## 2. Solution Architecture
1. **DOM Extractor Upgrade (`extract_case.js`)**:
   - Improve timestamp extraction selector to check `a.cuf-timestamp`, `span.cuf-timestamp`, `time`, `uiOutputDateTime`, `[class*='timestamp']`, and relative text patterns before falling back to `""`.
   - Improve role classification (`classifyRole`) by checking author affiliations, email patterns, badges, and contextual greetings.
2. **Robust Chronological Sorting with Relative Interpolation (`scrape_case.mjs`)**:
   - If a comment lacks a valid timestamp, do not assign epoch `0`.
   - Instead, interpolate or anchor its relative position based on adjacent sibling comments in the DOM sequence.
   - Maintain strict Oldest -> Newest timeline ordering for all comments.
3. **Enhanced Flow-Oriented Markdown Rendering (`render_case.mjs`)**:
   - Render clear visual badges for participant roles (e.g., `[Qualcomm Engineer]` vs `[Customer / OEM]`).
   - Output structured, easily scannable timeline headers.
4. **Data Cache Migration**:
   - Provide a migration/re-sort routine to fix and re-render existing cases (such as `08637663/case.json` and `08637663/case.md`).

## 3. User Stories & Definition of Done (DoD)
- **US1 (Extraction)**: As an engineer, when I capture a Qualcomm case with nested or modern Chatter replies, all timestamps and author roles are accurately extracted.
  - *DoD*: `extract_case.js` extracts valid timestamps for all Chatter articles where timestamps exist on page.
- **US2 (Sorting & Timeline)**: As an analyst, when reading `case.json`, the comments array is strictly ordered from Oldest to Newest, preserving the true conversational flow.
  - *DoD*: Comments with missing timestamps are anchored logically to adjacent thread comments, never dumped at index 0.
- **US3 (Markdown Flow Visualization)**: As a user reading `case.md`, I can immediately follow the case flow, identify who is speaking (Qualcomm vs Customer), and understand the progression of the discussion.
  - *DoD*: `case.md` renders clear role indicators and sequential timeline steps.
- **US4 (Cache Repair)**: As a maintainer, existing cached cases can be repaired and re-rendered without data loss.
  - *DoD*: Running the migration re-sorts `data/cases/08637663/case.json` and produces an accurate `case.md`.

## 4. Out of Scope
- AI LLM case flow summarization / automatic enrichment changes (kept for a separate milestone).
- Modifying Salesforce portal DOM or interacting with external network services outside the headless capture workflow.

## 5. Deep Modules Map
- [extract_case.js](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/extract_case.js): DOM extraction logic for timestamps, roles, and comments.
- [scrape_case.mjs](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs): Timestamp parser, relative interpolation fallback, and chronological comment sorter.
- [render_case.mjs](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/render_case.mjs): Markdown timeline generator with role formatting.
- `tests/sorting.test.mjs`: Unit and integration tests for sorting, interpolation, and role rendering.

## 6. Testing Decisions
- **Unit Tests**: Test `parseTimestamp`, `sortCommentsChronological` with various edge cases (mixed timestamps, all empty, relative dates, tie-breaking).
- **Integration Tests**: Verify `mergeComments` and re-sorting against real fixture cases (e.g. `08637663`).
- **Regression Suite**: Run `npm test` to ensure all existing test suites continue to pass.
