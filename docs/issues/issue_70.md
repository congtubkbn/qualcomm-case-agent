---
ID: #70
Status: AFK
Blocked by: [#68, #69]
Type: Polish
---

## What to build
Provide migration / refresh capability for existing cached cases and verify full pipeline:
- Add a migration or batch refresh tool `tools/migrate_case_detail.mjs` to allow re-extracting / updating cached cases with Detail metadata.
- Run full test suite (`npm test`) across all modules (`qualcomm-case-agent`, `qualcomm-case-overview`, etc.).
- Verify against sample case `08316063`.

## Acceptance criteria
- [ ] Existing cached cases can be upgraded with Detail metadata
- [ ] All unit tests pass cleanly across `tests/`
- [ ] End-to-end verification confirms accurate opener `Mai Ngoc` for case `08316063`
