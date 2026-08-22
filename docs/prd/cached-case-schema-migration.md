# PRD: Cached Case Schema Migration & Health Verification

## 1. Problem Statement
Historical cases captured and saved to local cache (`data/cases/<caseNumber>/case.json`), such as case `08637663`, still conform to the legacy schema prior to the optimization in PRD `qualcomm-case-json-schema-optimization.md`:
1. **Garbage Timestamps**: Tooltip strings (`"Click for single-item view of this post."`, `"Expand Post"`, etc.) remain in `timestamp` fields.
2. **Obsolete Attributes**: `analysisLog: []` is still present in comment objects.
3. **Missing Intent Summaries**: Comment objects lack the `summary` preview field.
4. **Out-of-sync Rendered Markdown & Index**: `case.md` and `_index.json` hashes are out of date relative to the optimized schema contract.

## 2. Shared Solution & Architectural Approach
Build a robust, idempotent migration and verification tool (`scripts/migrate_case.mjs`) that upgrades existing local case caches without altering ground-truth comment bodies or author identities:
- **Sanitize Comments**:
  - Filter tooltip strings from `timestamp` (`"Click for single-item view..."`, `"Expand Post"`, `"Chatter Feed Item"`) -> set to `""` or valid timestamp.
  - Delete `analysisLog` field from each comment object.
  - Generate deterministic rule-based `summary` preview (stripping greetings like "Dear QC", "Dear Customer", "Hello") for each comment if missing.
- **Recompute & Synchronize**:
  - Re-compute case `hash` using the canonical `computeHash` function from `scrape_case.mjs`.
  - Update `data/cases/_index.json` with the updated comment count, hash, and sync timestamp.
  - Re-render `case.md` via `render_case.mjs` logic.
- **Health Verification**:
  - Verify upgraded files using `verify_case.mjs`.

## 3. User Stories & Definition of Done (DoD)
- [ ] **US-1**: As an engineer/agent, I can run `node .claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs 08637663` (or `all`) to migrate cached cases to the new schema cleanly.
- [ ] **US-2**: Migrated `case.json` files have zero tooltip timestamps, no `analysisLog` fields, and valid `summary` previews for all comments.
- [ ] **US-3**: `data/cases/_index.json` is automatically updated with correct hashes.
- [ ] **US-4**: `case.md` is re-rendered with clean chronological flow and summary quotes.
- [ ] **US-5**: `npm test` has 100% passing tests for the migration module and full test suite regression.

## 4. Deep Modules Map
- [NEW] [tools/migrate_case.mjs](file:///e:/the.thoi/Project/access-qualcomm/tools/migrate_case.mjs): Core migration tool handling case schema sanitization, hashing, index update, and markdown regeneration.
- [NEW] [scripts/migrate_case.mjs](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs): Skill wrapper script delegating to `tools/migrate_case.mjs`.
- [MODIFY] [tests/migrate_case.test.mjs](file:///e:/the.thoi/Project/access-qualcomm/tests/migrate_case.test.mjs): Comprehensive unit tests covering single case migration, bulk migration, idempotency, and hash updates.

## 5. Testing Decisions
- Unit tests in `tests/migrate_case.test.mjs` against synthetic legacy case fixtures containing tooltip timestamps, `analysisLog`, and missing `summary`.
- Verification that running migration twice (idempotency) produces identical content and hash.
- Full suite verification with `npm test`.
