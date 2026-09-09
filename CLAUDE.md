# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Project: access-qualcomm

Local workspace that drives real Chrome (via the `agent-browser` CLI) to capture Qualcomm Support
(support.qualcomm.com) cases — full metadata plus every comment, verbatim — and caches the result
locally per case. Incremental: an unchanged case reports "no update". Capture-only: given a case
code, search the portal, save the data. Nothing else.

**Windows only.** Auth helpers use PowerShell + DPAPI. Use PowerShell syntax for shell commands
(no `mkdir -p`, `rm -rf`, `cat`, etc. — see `.clinerules/windows-environment.md`).

### Commands

```bash
npm test                          # unit tests (node --test, no build step)
node --test tests/finalize_case.test.mjs   # run a single test file
npm run case -- 08603854          # capture one case (the main pipeline entry point)
npm run docs                      # regenerate docs/DESIGN.md §7 (module/API ref) from source
npm run docs:check                # fail if that generated section is stale (CI runs this)
npm run docs:hook                 # install pre-commit hook that keeps docs/DESIGN.md current
```

No build/lint/typecheck step — plain Node ESM (`.mjs`), `engines.node >= 22.3.0`. CI
(`.github/workflows/ci.yml`) runs `npm test` then `npm run docs:check` on push/PR to `main`.

`data/` (cases and the Chrome profile) is entirely git-ignored — case content is Qualcomm NDA
material and must stay local. Never paste case content to an external/remote service.

### Architecture: capture is code, no model in the loop

The load-bearing decision of this codebase: retrieval (sign in, resolve case URL, paginate, expand
posts, read DOM, hash, merge, render) is a deterministic, decision-free procedure implemented in
plain Node — **zero model tokens**. Full rationale in [`docs/DESIGN.md`](docs/DESIGN.md); this is
generated/curated, not hand-summarized — read it directly for anything beyond this overview.

**Layers** (`docs/DESIGN.md` §3.2), each with a narrow, non-overlapping responsibility (§3.3):

```
Runbooks (SKILL.md, .clinerules, references/*)
  → Orchestration (run_case.mjs)
    → Browser adapter (browser.mjs: argv-array spawn, eval -b, CDP attach)
      → Page scripts (login_fill.js, expand_step.js, extract_case.js, switch_tab.js, check_collapsed.js — run INSIDE the tab)
    → Persistence + integrity (intake.mjs, finalize_case.mjs, lock.mjs, _paths.mjs)
      → Presentation (render_case.mjs → case.md)
```

Two invariants worth preserving when touching this layer stack:
- **Nothing crosses a shell.** `browser.mjs` spawns `agent-browser` with an argv array; page
  scripts cross as base64 — no quoting, no shell dialect issues.
- **Page scripts return counters, never DOM dumps.** e.g. `expand_step.js` clicks inside the page
  in a loop and returns `{articles, displayed, anchorIdx, clicked…}`, not a snapshot.

**Entry point:** `node .claude/skills/qcomm/scripts/run_case.mjs <8-digit-code>`
prints exactly one JSON verdict line on stdout (`status`: `created`/`updated`/`no-update`/
`auth-required`/`not-found`/`blocked`/`busy`/`error`) and sets a matching exit code. Callers must
branch on the `status` field in stdout, never on the shell exit-code label alone — several
non-success statuses are deliberate, expected outcomes, not crashes. Full contract in
`.claude/skills/qcomm/SKILL.md`.

**One Claude Code skill** lives under `.claude/skills/`: `qcomm` — intake → login →
finalize → render.

**Session/auth:** Okta OAuth with email OTP, persisted in `data/chrome-profile/` (a real Chrome
`--user-data-dir` attached over CDP 9773, not bundled Chromium). A lapsed session surfaces as
`auth-required` and must be re-authenticated by a human in the browser window — this cannot be
automated. The port is deliberately off the well-known 9222-9230 range, and `ensureChrome()`
verifies the owning process's `--user-data-dir` before trusting/reusing a connection — an external
tool scanning that range once attached to our Chrome and corrupted the session (issue #104); a
mismatch surfaces as `port-conflict` instead of silently misusing the wrong browser.

**Tests** (`tests/*.test.mjs`, run via `node --experimental-test-module-mocks --test`) mock
`browser.mjs` at the module level rather than driving a real browser — see
`node --test tests/run_case.test.mjs` for the pattern before adding pipeline tests.
`npm test` globs `tests/*.test.mjs` — a new test file is picked up automatically, no registration
needed.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `congtubkbn/qualcomm-case-agent`. See
`docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See
`docs/agents/domain.md`.

### Grilling

- When grilling, ask one question at a time.
