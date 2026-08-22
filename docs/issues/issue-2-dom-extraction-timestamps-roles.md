---
ID: #2
Status: Done
Blocked by: [#1]
Type: Tracer Bullet
---

# Issue #2: Robust DOM Extraction for Timestamps and Roles

## Goal
Update [extract_case.js](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/extract_case.js) to extract timestamps from all Chatter elements (`a.cuf-timestamp`, `span.cuf-timestamp`, `time`, `uiOutputDateTime`, relative text) and improve role classification (`classifyRole`) to accurately detect Qualcomm engineers vs OEM/Customer.

## Acceptance Criteria
- Nested Chatter replies and inline timestamp spans have their timestamps extracted.
- Qualcomm authors (like Aiden An, Hoon Lee, etc.) are classified as `Qualcomm` rather than `Customer`.
- Extractor tests in `tests/extract_case.test.mjs` pass.
