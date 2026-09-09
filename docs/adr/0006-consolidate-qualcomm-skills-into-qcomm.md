# 0006. Consolidate qualcomm-case-agent, qualcomm-case-summary, and qualcomm-case-overview into qcomm

Date: 2026-09-10
Status: Accepted

ADR 0002 established `qualcomm-case-summary` as a separate downstream skill alongside `qualcomm-case-agent` and `qualcomm-case-overview`. Over time, maintaining three distinct skill directories created package fragmentation and duplicate runner definitions across `.claude/skills/`.

This decision consolidates `qualcomm-case-agent`, `qualcomm-case-summary`, and `qualcomm-case-overview` into a single standalone skill package location: `qcomm` (`.claude/skills/qcomm/`).

## Supersedes vs. Unchanged

### What is Superseded
- **Three Separate Skill Package Locations → One**: ADR 0002's implicit layout of separate skill packages (`.claude/skills/qualcomm-case-agent/`, `.claude/skills/qualcomm-case-summary/`, `.claude/skills/qualcomm-case-overview/`) is superseded. All entry scripts, helper modules, and runbook definitions are now housed together in `.claude/skills/qcomm/`.

### What Still Holds Unchanged
- **Deterministic-Capture / Agent-in-Loop Execution Boundary**: The load-bearing architectural decision from ADR 0001 and ADR 0002 — that case retrieval and DOM parsing are zero-token, deterministic Node scripts (`run_case.mjs`), while summarization and narrative extraction are downstream, agent-in-the-loop steps (`run_summary.mjs`) — remains strictly unchanged.
- **Read-Only Downstream Separation**: Summarization (`run_summary.mjs`) and multi-case overview aggregation (`cases_overview.mjs`) remain read-only consumers of `case.json`. Only file locations moved; no underlying runtime logic or data ownership boundaries changed.

## Consequences

- Simplified agent skill discovery: agents see `qcomm` as the single primary skill for Qualcomm case capture, summarization, and overview.
- All CLI commands and `package.json` entry scripts (`npm run case`, `npm run case:summary`, `npm run cases:overview`, etc.) target `.claude/skills/qcomm/scripts/`.
