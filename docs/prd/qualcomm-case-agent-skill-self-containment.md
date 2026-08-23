# PRD: Qualcomm Case-Agent Skill Self-Containment & Close `case:delete` CLI Bypass

## Problem Statement

Two related gaps found while auditing `qualcomm-case-agent`, `qualcomm-case-overview`, and
`qualcomm-case-summary` for self-containment (each is shared standalone with other engineers, so
every script a skill needs at runtime must live under its own `.claude/skills/<name>/scripts/`):

1. **`case:delete` bypasses the ADR 0003 confirmation gate.** ADR 0003
   (`docs/adr/0003-case-delete-is-cli-only-confirmed-in-chat.md`) states deletion has
   "no direct-delete affordance anywhere else" beyond the agent-mediated chat flow — `--yes` is
   documented as defense-in-depth, not the primary gate. But `package.json` exposes:
   ```
   "case:delete": "node .claude/skills/qualcomm-case-agent/scripts/delete_case.mjs"
   ```
   Running `npm run case:delete -- <code> --yes` from a bare terminal deletes a case's entire
   local cache with zero agent confirmation — exactly the direct-delete affordance the ADR says
   does not exist.

2. **Two scripts `qualcomm-case-agent` depends on live outside its skill folder.**
   - `tools/migrate_case.mjs` holds the real migration logic; the skill only has a thin wrapper
     (`.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs`) that does
     `export * from '../../../../tools/migrate_case.mjs'` and spawns that external file. Sharing
     the skill folder alone (without the rest of the repo) breaks this wrapper.
   - `tools/migrate_case_detail.mjs` has **no** presence in any `.claude/skills/` folder at all —
     not wrapped, not referenced from `run_case.mjs`, `SKILL.md`, or `package.json`. It is not
     dead code: it is the backfill utility required by
     `docs/prd/qualcomm-case-detail-tab-extraction.md` ("Provide utilities to refresh/re-sync
     cached cases with full Detail metadata", delivered in #70) for cases captured before
     Detail-tab extraction existed. It is actively tested
     (`tests/migrate_case_detail.test.mjs`) but simply was never packaged into the skill.

   `qualcomm-case-overview` already fixed the same class of problem for `cases_overview.mjs`
   (PRD `docs/prd/standardize-qualcomm-case-overview-skill-structure.md`, issue #62): the real
   script was moved fully into `.claude/skills/qualcomm-case-overview/scripts/` and the `tools/`
   copy was deleted outright — no wrapper left behind. This PRD applies the same pattern to the
   two migration scripts, for consistency across all three skills.

## Depends on

**#79** ("Dashboard shows orphan cases: delete flow gives up early, migration tools leak fixture
data into real cache") has an implemented, tested fix **not yet committed** that edits these
exact three files (`delete_case.mjs`, `tools/migrate_case.mjs`, `tools/migrate_case_detail.mjs`).
This work must start only after #79's fix is committed, to avoid clobbering or conflicting with
that uncommitted diff.

## Solution

1. **Remove `case:delete` from `package.json`.** The agent already invokes
   `node .claude/skills/qualcomm-case-agent/scripts/delete_case.mjs <code> --yes` directly when
   the user confirms in chat; no npm script is needed for that path, and removing it closes the
   bypass without losing any functionality. `docs/DESIGN.md`'s npm-scripts table is
   machine-generated (`npm run docs`) and will drop the row on regeneration.

2. **Move `migrate_case.mjs` and `migrate_case_detail.mjs` fully into
   `.claude/skills/qualcomm-case-agent/scripts/`.** The real logic (currently in `tools/`) moves
   into the skill folder; `tools/migrate_case.mjs` and `tools/migrate_case_detail.mjs` are
   deleted outright (nothing outside tests calls them at their `tools/` path, and tests are
   updated to import from the new location) — matching the no-wrapper-left-behind precedent set
   by `cases_overview.mjs`.

## User Stories & Definition of Done (DoD)

### US-1: No terminal-only delete path
- As a repo maintainer, I want deleting a case to be reachable only through the agent-mediated
  chat flow, matching what ADR 0003 already documents.
- **DoD**: `package.json` has no `case:delete` script. `node .claude/skills/qualcomm-case-agent/scripts/delete_case.mjs <code> --yes` still works unchanged (the agent's own invocation path is untouched).

### US-2: `qualcomm-case-agent` is self-contained
- As an engineer who receives only the `qualcomm-case-agent` skill folder (not the whole repo), I
  want every script the skill uses at runtime to be inside that folder.
- **DoD**:
  - `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs` and
    `.claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs` contain the real
    migration logic (not a wrapper pointing outside the skill folder).
  - `tools/migrate_case.mjs` and `tools/migrate_case_detail.mjs` no longer exist.
  - CLI usage (`node .../migrate_case.mjs [path|caseCode|all]`,
    `node .../migrate_case_detail.mjs [path|caseCode|all] [--flags]`) and all exported functions
    (`sanitizeComment`, `migrateCaseData`, `migrateCaseJson`, `classifyRole`, `isBlacklistedTs`,
    `extractSummary`, `synthesizeDescriptionComment`, `hasDescriptionComment`,
    `parseDetailFlags`, `migrateCaseDetailData`, `migrateCaseDetailJson`,
    `SUPPORTED_DETAIL_FLAGS`, `migrateCaseDetail`) keep identical signatures and behavior.

### US-3: Tests and docs stay accurate
- As a developer, I want `npm test` and `npm run docs:check` to pass cleanly after the move.
- **DoD**:
  - `tests/migrate_case.test.mjs` and `tests/migrate_case_detail.test.mjs` import from
    `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs` /
    `.claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs`.
  - `tools/gen_design.mjs`'s "Pipeline scripts" group in `docs/DESIGN.md` lists both files (it
    already scans `.claude/skills/qualcomm-case-agent/scripts`); the "Doc tooling" group no
    longer lists them.
  - `npm test` and `npm run docs:check` both pass.

## Deep Modules Map

| File | Change | Role / Interface |
|---|---|---|
| `package.json` | **MODIFY** | Remove `case:delete` script. |
| `.claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs` | **REPLACE CONTENT** (real logic moves in, wrapper removed) | Re-sort comments, re-classify roles, sanitize schema, recompute hash, re-render `case.md`. |
| `.claude/skills/qualcomm-case-agent/scripts/migrate_case_detail.mjs` | **NEW FILE** (moved from `tools/`) | Backfill Salesforce Detail-tab metadata into cached cases captured before that feature existed. |
| `tools/migrate_case.mjs` | **DELETE** | Superseded by the skill-folder copy. |
| `tools/migrate_case_detail.mjs` | **DELETE** | Superseded by the skill-folder copy. |
| `tests/migrate_case.test.mjs` | **MODIFY** | Update import path. |
| `tests/migrate_case_detail.test.mjs` | **MODIFY** | Update import path. |
| `docs/DESIGN.md` | **REGENERATE** | Via `npm run docs`; no hand edits. |

## Testing Decisions

- `npm test` (full suite) must pass with zero changes to test *assertions* — only import paths
  move.
- `npm run docs:check` must pass after regenerating with `npm run docs`.
- Manually verify `node .claude/skills/qualcomm-case-agent/scripts/migrate_case.mjs all` and the
  `migrate_case_detail.mjs` equivalent still run against `data/cases/` unchanged in behavior.

## Out of Scope

- Any change to `delete_case.mjs`'s own logic (covered by #79).
- Any change to the dashboard's "Delete" button (ADR 0003, unchanged — clipboard-copy only).
- Adding a delete-case runbook section to `SKILL.md` (flagged separately in #79's Further Notes
  as its own follow-up).
