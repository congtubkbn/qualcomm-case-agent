---
ID: #37
Status: Done
Blocked by: [#36]
Type: Refactor
---

# Issue #37: [Refactor Slice 2] Add migration entrypoint wrapper in .claude/skills/qualcomm-case-agent/scripts/ and align docs

## What to build
Add entrypoint wrapper and align PRD documentation paths:
- Add entrypoint wrapper script `scripts/migrate_case.mjs` under `.claude/skills/qualcomm-case-agent/scripts/` delegating to `tools/migrate_case.mjs`.
- Ensure both paths (`node tools/migrate_case.mjs` and `node .claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs`) function identically.
- Align `docs/prd/cached-case-schema-migration.md` with both executable paths.

## Acceptance criteria
- [ ] `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs` exists and forwards CLI invocations
- [ ] `docs/prd/cached-case-schema-migration.md` matches implementation paths
- [ ] Integration tests verify CLI execution through both paths

## Blocked by
- #36
