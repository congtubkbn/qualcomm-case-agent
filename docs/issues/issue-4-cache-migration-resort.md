---
ID: #4
Status: Done
Blocked by: [#1, #2, #3]
Type: Refactor
---

# Issue #4: Cache Data Migration & Re-sorting for Existing Cases

## Goal
Provide a migration script/command to re-sort comments and re-render `case.json` and `case.md` for cached cases (e.g. `data/cases/08637663/case.json`).

## Acceptance Criteria
- Running the re-sort on `data/cases/08637663/case.json` places opening comments (Kyungnam Ken Lee, Seunghoon Lee) at the beginning and latest responses (Aiden An, CS Lee) at the end.
- `case.md` reflects the true chronological dialogue flow.
