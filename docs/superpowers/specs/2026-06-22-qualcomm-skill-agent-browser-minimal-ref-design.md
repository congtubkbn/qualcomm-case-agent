# Design: qualcomm-case-agent — Minimal Agent-Browser Reference

**Date:** 2026-06-22  
**Scope:** `qualcomm-case-agent` SKILL.md only — no script changes, no flow changes.

---

## Problem

Current Intake step loads the full agent-browser reference:
```
agent-browser skills get core --full
```
Plus invokes the `agent-browser` Skill tool in Claude Code.

This is wasteful because:
- All 6 agent-browser commands used in this skill are already documented inline in the phase blocks
- Loading the full skill consumes tokens on every invocation
- The flow is deterministic — no undocumented commands needed

---

## Goal

Remove all external agent-browser reference loading. Replace with a minimal inline command table covering only the 6 commands actually used. Skill becomes 100% self-contained.

---

## Changes

### 1. Intake section rewrite

**Remove** the "Load agent-browser reference" step (currently step 1 of Intake):
```
agent-browser skills get core --full
(Claude Code: also invoke the agent-browser Skill tool.)
```

**Add** an "Agent-Browser Commands" section above Intake with inline table:

```markdown
## Agent-Browser Commands (inline — do NOT load external skill)

| Command | Purpose |
|---------|---------|
| `agent-browser open "<url>"` | Navigate to URL |
| `agent-browser wait <ms>` | Pause N milliseconds |
| `agent-browser snapshot -c` | Read page DOM (compact) |
| `agent-browser eval "return <expr>"` | Run JS, return value |
| `agent-browser connect "ws://127.0.0.1:9222/..."` | Attach to CDP |
| `agent-browser pdf "<path>"` | Print current page to PDF |
```

Intake steps renumber: validate/normalize code becomes step 1, prepare cache dirs step 2.

### 2. Agent Guardrails patch

**Remove:** `"Load agent-browser reference first before any browser action."`

**Add:** `"Do NOT load agent-browser full reference — all commands documented in the inline table above."`

---

## Unchanged

- PHASE 1 flow: `global-search/<CODE>` open → hostname check → click first result → `eval location.href`
- Recovery 0 (Chrome/CDP restart)
- Recovery 1 (Auth / Okta login)
- PHASE 2–5 and all scripts
- `allowed-tools` frontmatter

---

## Command Inventory (verification)

Commands used across entire SKILL.md:

| Command | Used in |
|---------|---------|
| `agent-browser open` | PHASE 1, PHASE 4 (PDF) |
| `agent-browser wait` | PHASE 1 |
| `agent-browser snapshot -c` | PHASE 1, PHASE 2 selector discovery |
| `agent-browser eval` | PHASE 1 (hostname + href checks) |
| `agent-browser connect` | Recovery 0 |
| `agent-browser pdf` | PHASE 4 |

6 commands total. Inline table covers 100%.
