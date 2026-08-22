---
ID: #33
Status: Done
Blocked by: []
Type: Tracer Bullet
---

# Issue #33: [Migration Slice 1] Implement Core Case Migration Transformation Logic in migrate_case.mjs

## Goal
Implement the core pure transformation functions in `migrate_case.mjs`:
1. `sanitizeComment(comment)`:
   - Filter out tooltip garbage from `timestamp` (e.g. `"Click for single-item view of this post."`, `"Expand Post"`).
   - Remove `analysisLog` key.
   - Generate deterministic `summary` preview if missing or equal to raw body.
2. `migrateCaseData(caseData)`:
   - Sanitize all comments in `caseData.comments`.
   - Recompute canonical `hash` via `computeHash`.
   - Return updated case object without mutating unwanted fields.

## Verification
- Unit test in `tests/migrate_case.test.mjs` validating comment sanitization, summary extraction, hash computation, and idempotency on duplicate runs.
