---
name: qualcomm-issue-precedent
description: "Search already-captured Qualcomm cases for precedent matching a free-text tester-reported issue, cross-check verbatim technical signatures against the new issue's own decoded log, and persist a per-candidate verdict report. Triggers: 'has this been seen before', 'precedent check <issue>', 'qualcomm precedent search'."
allowed-tools: Bash(node:*), Read, Write
---

# Qualcomm Issue Precedent Check

**Role.** Given a free-text tester-reported issue (title + repro), find already-captured Qualcomm cases with a confirmed root cause that resemble it, verbatim-extract technical signatures from those cases, cross-check the new issue's own decoded log for those signatures, and persist a per-candidate verdict as a Markdown report the engineer can reference while writing up the new issue's own RCA.

**Downstream, read-only, additive.** Reads `case.json`/`summary.json` the same way `qualcomm-case-summary`/`qualcomm-case-overview` do (ADR 0002's read-only-downstream-skill pattern). Never writes to `data/cases/<CODE>/`, `_index.json`, or `_overview.json` — the only output is a new Markdown file under `data/cases/_precedent/`.

**Input Contract.** Free-text issue `title` + `repro` description. No case code required. Optionally a `session` reference to the new issue's own decoded log (an opaque value — a path, id, or handle the `log_query` tool understands); omit it if no decoded log is available yet.

**Never fabricates.** No root cause or fix is invented. Every reported signature is a verbatim substring already present in a candidate's own stored text (via #182's extraction); every verdict comes from #183's `log_query` cross-check, never a guess.

**References** (`references/` — load on demand):
- [`references/workflow.md`](references/workflow.md): Flowchart, step breakdown, output contract.

---

## Execution Workflow

Six steps: deterministic CLI calls for search/verdict/persist, agent judgment for signature selection and result synthesis in between.

### Step 1 — Search Candidates (Deterministic CLI)
Run `precedent_search.mjs` with the issue's title + repro as the free-text query:
```bash
node ".claude/skills/qualcomm-issue-precedent/scripts/precedent_search.mjs" <title + repro text>
```
Optional flags: `--cases-dir=<dir>` (testing), `--limit=<n>` (default 10).

Parse the stdout JSON line: `{ status, query, candidates }`. Each candidate carries `caseNumber, title, rootCause, resolution, flow, product, url, signatures: [{signature, source}], score`.

- `candidates` empty → note "no precedent found" for Step 6; still run Step 5 to persist a report documenting the empty result.
- Otherwise proceed to Step 2 for each candidate worth checking (all of them, or the agent's top picks).

*Completion Criterion:* one JSON line parsed with `status: "ok"`.

### Step 2 — Select Signatures (Agent Judgment — Verbatim Only)
For each candidate, look at its `signatures` list (already extracted verbatim in Step 1 — see #182). Choose which of *those exact strings* are worth cross-checking against the new issue's log, and which table (`signalling` or `trace`) each belongs to.

**Hard rule:** never invent, paraphrase, or guess a signature — only strings that appear character-for-character in that candidate's own `signatures` list may be selected. A candidate with an empty `signatures` list has nothing to select. The same applies whenever no signature is worth testing even though some exist (e.g. none look relevant to the repro) — in both cases, skip Step 3 for that candidate and carry `verdict: "insufficient technical data to check"`, `checks: []` straight into Step 4 (this matches Step 3's own behavior: an empty `selections` array resolves to the same verdict, so skipping is just short-circuiting a call that would come back the same way).

### Step 3 — Get a Verdict (Deterministic CLI, once per candidate with a selection)
Write `{ candidate, selections, session }` to a temp JSON file and run:
```bash
node ".claude/skills/qualcomm-issue-precedent/scripts/run_precedent.mjs" verdict --input <temp.json>
```
- `candidate`: the Step 1 candidate object (must include its `signatures` list).
- `selections`: `[{ signature, table }]` from Step 2 — every `signature` must be verbatim-present in `candidate.signatures`; the script enforces this itself and errors (exit 1) otherwise, rather than silently testing an invented string.
- `session`: the opaque log reference from the Input Contract, or omit if unavailable.

Output: `{ status: "ok", caseNumber, verdict, checks }`, `verdict` one of `"matched known cause"`, `"does not match"`, `"insufficient technical data to check"`.

*Note:* until the real `log_query.py` contract is supplied (see #181), every check resolves as `unavailable`, so verdicts land on `"insufficient technical data to check"` today — the workflow is fully wired and starts returning real matches the moment that contract lands, with no other change needed here.

*Completion Criterion:* one verdict object collected per candidate that had a Step 3 run.

### Step 4 — Synthesize the Full Result (Agent Judgment — Assembly Only)
Assemble one JSON object combining each Step 1 candidate's fields with its verdict step output (or the Step 2 `insufficient` default for candidates with no signatures):
```json
{
  "issueTitle": "<the issue's title>",
  "issueRepro": "<the issue's repro description>",
  "query": "<the Step 1 query text>",
  "candidates": [
    {
      "caseNumber": "...", "title": "...", "url": "...", "product": "...",
      "rootCause": "...", "resolution": "...", "flow": "...",
      "signatures": [ /* Step 1's full extracted list, for record-keeping */ ],
      "selections": [ /* Step 2's chosen subset */ ],
      "verdict": "...",
      "checks": [ /* Step 3's per-signature results */ ]
    }
  ]
}
```
This step is assembly, not new analysis — do not add, remove, or reword any field's content from Steps 1-3.

### Step 5 — Persist the Report (Deterministic CLI)
Write Step 4's object to a temp JSON file and run:
```bash
node ".claude/skills/qualcomm-issue-precedent/scripts/run_precedent.mjs" finalize --input <temp.json>
```
Output: `{ status: "ok", reportPath }`. `reportPath` is a new Markdown file under `data/cases/_precedent/`, named `<slug-of-issueTitle>-<timestamp>.md`.

*Completion Criterion:* `status: "ok"` with a `reportPath` that exists.

### Step 6 — Report to User
- **Candidates found**: count and top matches (case number + title).
- **Verdicts**: one line per candidate — case number, verdict, and the evidence/signature behind it (if matched/unmatched) or the "no extractable signature" note (if insufficient).
- **Artifact Link**: pointer to the saved report, e.g. `[report](file:///data/cases/_precedent/<file>.md)`.

---

## Operational Guardrails

- **Read-only, additive:** Reads `case.json`/`summary.json` through `precedent_store.mjs`; the only write this skill ever performs is a new file under `data/cases/_precedent/`. Never touches `data/cases/<CODE>/`, `_index.json`, or `_overview.json`.
- **No fabrication:** Every signature is verbatim from #182's extraction; every verdict comes from #183's `log_query` cross-check. No root cause, fix, or signature is invented at any step.
- **No case code required:** Input is free text; this tool runs before a new Qualcomm case may even exist.
- **`log_query` placeholder awareness:** The real `log_query.py` contract is pending (issue #181) — verdicts are honest about that (`"insufficient technical data to check"` today), never silently faked as a match.
- **Local confidentiality:** All case data and precedent reports stay inside the local workspace (`data/cases/`).
