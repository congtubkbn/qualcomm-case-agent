# Qualcomm case capture — agentic 2-stage pipeline (design)

- Date: 2026-06-20
- Status: approved design, pending implementation plan
- Component: `qualcomm-case-agent` skill (`.claude/skills/qualcomm-case-agent/`) + project `access-qualcomm`

## 1. Context & problem

The skill captures a Qualcomm support case (portal `support.qualcomm.com`) and writes a local cache
used as **input for downstream indexing** (RAG / search / other skills and workflows). The user
manages many cases and syncs an arbitrary case on demand.

Today the skill is only *partly* agentic: the LLM drives the mechanical loop (it reads each
`agent-browser eval` result and decides whether to keep expanding). That burns tokens per pass and is
nondeterministic. Because the captured data is a *product* consumed by other systems, it must be
reproducible and have a stable schema — which the current LLM-in-the-loop design does not guarantee.

## 2. Goals / non-goals

Goals:
- Deterministic, reproducible **raw capture** (same case → same `raw` JSON + same hash).
- Stable, documented **output schema** that downstream indexers can rely on.
- Keep LLM enrichment (engineer summaries, root cause, tags) available, but **decoupled** so it never
  blocks or perturbs raw capture, and can be re-run without re-scraping.
- On-demand single-case sync; incremental (unchanged case → skip).
- Run under Claude Code and Cline/VS Code; Windows; paths relative to workspace root.

Non-goals (YAGNI for v1):
- Bulk/all-case crawler or scheduler (single case per invocation; an orchestrator may loop later).
- The downstream index itself (this spec produces its *input* only).
- macOS/Linux support.
- Auto-reading the Qualcomm mailbox / automating the email OTP.

## 3. Design overview

A **2-stage pipeline** with the LLM only at the edges:

```
case code
  │
  ▼  [LLM] selector discovery (once / when DOM changes) → writes selector config
  ▼
Stage 1  scrape_case.mjs  (deterministic, NO LLM)
  • reuse Chrome --profile session
  • expand-all loop → fixpoint
  • extract by selectors → raw object; assert count == displayedCommentCount
  • write data/cases/<CODE>.json (raw + hash + extractedAt); update _index.json
  • exit code signals ok / auth-needed / not-found / incomplete / config-missing
  │
  ▼  (only if exit ok AND case changed)
Stage 2  enrich  ([LLM] agent step)
  • read raw <CODE>.json → produce enrichment{} (summaries, rootCause, tags, timeline)
  • write enrichment into the SAME file under a separate `enrichment` key (raw + hash untouched)
  │
  ▼
render_case.mjs  (deterministic) → <CODE>.report.md + <CODE>.md + <CODE>.html
```

The agent (LLM) orchestrates: it runs Stage 1 via the terminal, reads the exit code + raw JSON, does
Stage 2 itself, then runs render. The LLM is invoked only for: selector discovery, enrichment, and
exception handling.

## 4. Components

### 4.1 Selector config — `.claude/skills/qualcomm-case-agent/config/selectors.json`
Versioned map of the real CSS selectors for the case page (container, fields, expander controls,
displayed-comment-count badge, case-URL pattern). Produced by **LLM selector discovery** on first run
or when Stage 1 reports a selector mismatch. Stage 1 reads it; no LLM at scrape time.

### 4.2 Stage 1 — `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs` (NEW, deterministic)
- Input: `<CODE>` (argv), reads `config/selectors.json`, uses `data/chrome-profile` via agent-browser.
- Drives the page by shelling out to `agent-browser` (`open`, `eval`, `wait`, `snapshot`, `get`).
- Runs the expand-all `expandPass()` loop to a true fixpoint (clicked==0 && stable count && stable
  scrollHeight, two consecutive passes; guard ~25). Pierces shadow DOM + same-origin iframes; scrolls
  for lazy-load. Falls back to progressive scroll-extract for virtualized lists.
- Extracts via the configured selectors into a `raw` object; asserts
  `comments.length === displayedCommentCount`.
- Writes `data/cases/<CODE>.json` (raw fields + `hash` over raw + `extractedAt`); updates `_index.json`.
- Emits a machine-readable result line (JSON) and an exit code (see §7).
- Contains NO Qualcomm-domain judgement and NO summaries.

> Browser-launching steps require a real terminal/TTY (browser launch hangs in a piped/automation
> shell). The script is invoked through the agent's terminal (Claude Code Bash / Cline execute_command).

### 4.3 Stage 2 — enrichment (LLM agent step, no script)
- Trigger: Stage 1 exit ok AND case is new/changed (hash differs from `_index.json`).
- The agent reads `data/cases/<CODE>.json`, writes an `enrichment` object back into the same file:
  per-comment summaries keyed by comment `id`, plus case-level `engineerSummary`, `rootCause`,
  `recommendedActions`, `tags`, `timeline`, `enrichedAt`. **Raw fields and `hash` are never mutated.**
- Default: enrichment ON. Raw-only mode (skip Stage 2) runs when the user/orchestrator explicitly
  asks for a fast/raw sync; render then uses raw alone and `enrichment` is absent.

### 4.4 render_case.mjs (existing, extend)
- Read raw + `enrichment` (if present), merge for display. Emits `<CODE>.report.md` (summary),
  `<CODE>.md` + `<CODE>.html` (review). Already strips BOM and flags `count < displayedCommentCount`.

### 4.5 Index — `data/cases/_index.json`
- `"<CODE>": { syncedAt, commentCount, hash, enrichedAt? }`. Drives incremental skip on the RAW hash.

## 5. Data flow (one sync)

1. Agent receives a case code.
2. Ensure `config/selectors.json` exists; if missing/stale → LLM selector discovery populates it.
3. Run `node .../scripts/scrape_case.mjs <CODE>`.
4. On exit `auth-needed` → ask user to sign in + email OTP in the browser, retry. On `not-found` →
   report & stop. On `incomplete` → report what was captured vs displayed & stop (or re-discover
   selectors). On `config-missing` → run selector discovery, retry.
5. On `ok`: if hash unchanged vs `_index.json` → report "no update", stop. Else continue.
6. Stage 2 enrichment (unless raw-only mode).
7. `node .../scripts/render_case.mjs data/cases/<CODE>.json`.
8. Report: counts (captured vs displayed), root cause, output paths.

## 6. Data schema (stable contract for indexers)

`data/cases/<CODE>.json`:

```jsonc
{
  // ---- raw (Stage 1, deterministic) ----
  "caseNumber": "string", "title": "string",
  "status": "string", "priority": "string", "severity": "string",
  "product": "string", "customer": "string",
  "created": "string", "updated": "string",
  "url": "string", "description": "string",
  "displayedCommentCount": 0, "commentCount": 0,
  "hash": "sha256 over raw", "extractedAt": "ISO-8601",
  "comments": [
    { "id": "stable id/permalink", "timestamp": "string", "company": "string",
      "author": "string", "role": "string", "body": "verbatim",
      "analysisLog": ["verbatim"], "attachments": [ { "name": "string", "href": "string" } ] }
  ],
  // ---- enrichment (Stage 2, LLM; absent in raw-only mode) ----
  "enrichment": {
    "engineerSummary": "string", "rootCause": "string",
    "recommendedActions": ["string"], "tags": ["string"],
    "timeline": [ { "date": "string", "event": "string" } ],
    "commentSummaries": { "<comment id>": "string" },
    "enrichedAt": "ISO-8601"
  }
}
```

Indexers consume: raw `comments[].body` / `analysisLog` for semantic text; `enrichment.tags`,
`rootCause`, `engineerSummary`, `timeline` as metadata/filters. Comments are newest-first.

## 7. Incremental & hashing

- `hash` = SHA-256 over a canonical projection of RAW only: `displayedCommentCount` + each comment's
  `id|timestamp|author|body|analysisLog`. Excludes enrichment, `extractedAt`, `syncedAt`.
- Same hash in `_index.json` → skip scrape/enrich/render, report "no update".
- Improving the enrichment prompt re-runs Stage 2 over the cached raw — no portal hit, hash unchanged.

## 8. Error handling — Stage 1 exit codes

| Code | Meaning | Agent action |
|------|---------|--------------|
| 0 | ok | continue (incremental check → enrich → render) |
| 2 | bad/missing args | fix invocation |
| 3 | auth-needed (redirected to Okta) | ask user to sign in + email OTP, retry |
| 4 | case not found / no access | report & stop |
| 5 | incomplete (count < displayed after fixpoint) | report captured-vs-displayed; re-discover selectors or stop |
| 6 | selector config missing/invalid | run LLM selector discovery, retry |

No silent failures: Stage 1 prints what it captured and why it stopped.

## 9. LLM usage points (and why)

1. **Selector discovery** — messy/changing DOM → CSS selectors. Judgement over unstructured input;
   run once and lock to config.
2. **Enrichment** — raw data → engineer summaries / root cause / tags. Domain knowledge (Protocol/RF/3GPP).
3. **Exceptions** — interpret auth state, not-found vs no-access, unexpected pages; decide next step.

Everything else (launch/restore, expand loop, scroll, extract, assert, hash, incremental, render) is
deterministic code: cheaper, reproducible, testable.

## 10. Agent orchestration (cross-harness)

- Claude Code: project skill at `.claude/skills/qualcomm-case-agent/`; Bash runs the scripts.
- Cline/VS Code: `.clinerules/qualcomm-case-agent.md` points to the runbook; `execute_command` runs the
  scripts; file tools read/write JSON. Not Cline's `browser_action`.
- All paths relative to the workspace root.

## 11. Testing

- `scrape_case.mjs`: unit-test the pure parts (fixpoint decision, hash canonicalization, count assert,
  exit-code selection) with synthetic DOM/eval-result fixtures. End-to-end against a saved HTML capture
  of a real case page once available.
- `render_case.mjs`: already tested (BOM, completeness banner, 3 outputs); extend with an
  `enrichment`-present fixture.
- Determinism check: scrape the same fixture twice → identical raw + hash.

## 12. Migration from current skill

- Add `scrape_case.mjs` + `config/selectors.json`; move the expand/extract logic out of the SKILL.md
  prose loop into the script. SKILL.md Phase 3 becomes "run scrape_case.mjs, read exit code".
- Phase 4 (enrichment) stays LLM but writes the `enrichment{}` object instead of mutating comments.
- `render_case.mjs` extended to read `enrichment`.
- Keep both skill copies (project canonical + global) in sync.

## 13. Open questions / risks

- Stage 1 driving the page via repeated `agent-browser` CLI calls vs an embedded Playwright/CDP client:
  start with CLI calls (simplest, matches existing patterns); revisit if too slow.
- Virtualized-list path needs a real case page to finalize selectors/keys.
- Selector config drift: detect via the count assert; re-discovery is cheap and bounded.

## 14. Not in scope

Bulk crawler, scheduler/cron, the downstream index, non-Windows, OTP automation.
