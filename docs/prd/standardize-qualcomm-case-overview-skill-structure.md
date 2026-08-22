# PRD: Standardize qualcomm-case-overview Skill Structure

## 1. Problem Statement
In the current repository architecture:
- `qualcomm-case-agent` and `qualcomm-case-summary` follow the standard self-contained Agent Skill pattern where scripts live inside `.claude/skills/<skill-name>/scripts/`.
- `qualcomm-case-overview` had its implementation placed in `tools/cases_overview.mjs`, while its `SKILL.md` was merely an external pointer without an encapsulated `scripts/` directory.
- Additionally, an isolated copy existed under `.agents/skills/qualcomm-case-overview/` without scripts, creating inconsistency with the canonical skill location in `.claude/skills/`.

This violates the self-contained Deep Skill design principle and makes skill discovery and maintenance non-uniform across Qualcomm skills.

## 2. Solution
- Move `tools/cases_overview.mjs` to `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs`.
- Remove the redundant folder `.agents/skills/qualcomm-case-overview/` to maintain exact parity with `qualcomm-case-agent` and `qualcomm-case-summary`.
- Update `package.json` script definitions (`cases:overview` and `cases:dashboard`) to point to `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs`.
- Update `SKILL.md` inside `.claude/skills/qualcomm-case-overview/` to reference the new script path.
- Update `tools/gen_design.mjs` to scan `.claude/skills/qualcomm-case-overview/scripts` for design documentation.
- Update all corresponding test files (`tests/cases_overview_data.test.mjs`, `tests/cases_overview_render.test.mjs`, `tests/cases_overview_e2e.test.mjs`) to import from the new script path.
- Preserve 100% of CLI interfaces, arguments, and public exports.

## 3. User Stories & Definition of Done (DoD)

### US-1: Skill Structure Standardization
- As an AI agent or developer, I can discover and execute `cases_overview.mjs` directly inside `.claude/skills/qualcomm-case-overview/scripts/`.
- **DoD**:
  - `tools/cases_overview.mjs` is moved to `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs`.
  - `.agents/skills/qualcomm-case-overview/` is cleaned up.
  - `.claude/skills/qualcomm-case-overview/SKILL.md` is updated with accurate script commands.

### US-2: Build & CLI Compatibility
- As a developer, I can run `npm run cases:overview` and `npm run cases:dashboard` without broken script references.
- **DoD**:
  - `package.json` scripts execute cleanly using the new path.
  - CLI arguments (`--filter`, `--open`, `--json`, `--rebuild`) function identically.

### US-3: Automated Test Verification & Doc Regeneration
- As a developer, all unit, integration, and E2E tests pass cleanly.
- **DoD**:
  - `tests/cases_overview_data.test.mjs`, `tests/cases_overview_render.test.mjs`, `tests/cases_overview_e2e.test.mjs` pass.
  - `node tools/gen_design.mjs` runs and updates `docs/DESIGN.md` with zero missing symbols.

## 4. Deep Modules Map
| File | Change | Role / Interface |
|---|---|---|
| `.claude/skills/qualcomm-case-overview/scripts/cases_overview.mjs` | **NEW LOCATION** (Moved from `tools/`) | Core aggregation engine, CLI renderer, HTML dashboard generator. |
| `.claude/skills/qualcomm-case-overview/SKILL.md` | **MODIFY** | Updated command snippets and agent instructions. |
| `package.json` | **MODIFY** | Updated `cases:overview` and `cases:dashboard` scripts. |
| `tools/gen_design.mjs` | **MODIFY** | Added `.claude/skills/qualcomm-case-overview/scripts` to pipeline scripts indexer. |
| `tests/cases_overview_data.test.mjs` | **MODIFY** | Updated import path and usage assertions. |
| `tests/cases_overview_render.test.mjs` | **MODIFY** | Updated import path. |
| `tests/cases_overview_e2e.test.mjs` | **MODIFY** | Updated import path. |
| `.agents/skills/qualcomm-case-overview/` | **DELETE** | Remove duplicate folder. |
| `tools/cases_overview.mjs` | **DELETE** | Removed after move. |

## 5. Testing Decisions
- Execute test runner: `npm test` covering all test suites.
- Verify documentation generator: `npm run docs:check` or `npm run docs`.
