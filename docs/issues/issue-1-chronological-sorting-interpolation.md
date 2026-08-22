---
ID: #1
Status: Done
Blocked by: []
Type: Critical Bug
---

# Issue #1: Chronological Sorting with Relative Interpolation Fallback

## Goal
Fix `sortCommentsChronological` in [scrape_case.mjs](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs) so that comments with missing/unparseable timestamps (`timestamp: ""`) are not assigned epoch `0` and pushed to the top of the timeline. Instead, interpolate their position based on their DOM sequence and adjacent sibling timestamps.

## Acceptance Criteria
- Unit tests covering missing timestamps, mixed timestamps, and tie-breaking.
- Comments with empty timestamps maintain conversational flow relative to adjacent comments.
- `npm test` passes without regression.
