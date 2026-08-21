# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Not a software project with a build/test/lint cycle — there is no source code, no
package manifest, no compiler. This repo **is** the specification/config for an
agentic pipeline: a suite of Markdown "skills" and "workflows" for **Cline**
(VS Code extension) that drive a 3GPP UE (mobile handset) Root Cause Analysis
process. Editing this repo means editing `SKILL.md` files, `.clinerules/`
workflow files, and shared reference docs in prose/YAML-frontmatter/JSON-schema
form — there is nothing to `npm install`, build, or unit-test.

Two dependencies referenced throughout the skills are **not present in this
repo** and must not be hunted for locally:
- `<workspace>/3gpp-tools/{spec_query.py,code_search.py,log_query.py}` — Python
  tools invoked via shell that back a spec GraphRAG, a UE codebase semantic
  search, and a DuckDB query helper. They live in the target workspace where
  the pipeline actually runs, not in this repo.
- `evaluation/` (scripts + golden cases + DuckDB store) — referenced by
  `/rca-eval`, also lives in the target workspace, not here.

## Repository layout

```
.clinerules/
  3gpp-rca-collaboration.md   # the ONE always-on rule; architecture summary + invariants
  workflows/
    rca.md                    # /rca — main pipeline dispatcher workflow
    rca-eval.md                # /rca-eval — post-run quality evaluation workflow
.cline/skills/
  3gpp-rca-orchestrator/       # Phase 0 (init) + Phase 4 (finalize) — the only two orchestrator jobs
  3gpp-scoping/                # Phase 1 — IS/IS-NOT scope filter
  3gpp-event-timeline/         # Phase 2 — event timeline, top_event_candidates[]
  3gpp-top-event-confirmation/ # Checkpoint A — user confirms top event
  3gpp-fta-build-tree/         # Phase 3.1 (per iteration) — hybrid fault tree skeleton + code binding
  3gpp-fta-evaluate-branches/  # Phase 3.2+3.3 (per iteration) — Gate A pivot-pruning, Gate B expansion
  3gpp-fta-cross-reference/    # Phase 3.4 (per iteration) — commanded-vs-actual value comparison
  3gpp-fta-root-cause/         # Phase 3.5 (per iteration) — synthesize iteration root cause
  3gpp-fta-iteration-controller/ # Checkpoint B — recommendation + user dig/accept/abort gate
  3gpp-spec-retrieval/         # shared: wraps spec_query.py, invoked by phase skills only
  3gpp-code-retrieval/         # shared: wraps code_search.py, invoked by phase skills only
  3gpp-log-queries/            # shared: wraps log_query.py, invoked by phase skills only
  3gpp-rca-evaluator/          # backs /rca-eval (extract/judge/ingest stages)
  _shared/                     # cross-skill contracts, read these before editing any skill
    state-file-schema.md            # full JSON schema of the run's state file — READ FIRST
    tool-invocation-templates.md    # exact CLI shape + return JSON for all 3 Python tools
    keyword-provenance-rules.md     # anti-hallucination keyword-origin rules, per phase/iteration
    checkpoint-presentation-formats.md # exact ASCII templates for Checkpoint A and B
    rca-report-template.md          # final report template Phase 4 fills in
documents/design-v6/           # PDFs/HTML design-review docs (background reading, not source of truth)
v6-coworker-interaction-model.md # forward-looking design doc (NOT implemented) — see below
```

When editing a skill, the shared files in `.cline/skills/_shared/` are the
contract every skill must honor — read the relevant one(s) before changing a
skill's behavior, since changing e.g. the state file schema in one skill
without updating `_shared/state-file-schema.md` (and every other skill that
reads/writes that section) will break the pipeline.

## Architecture

### Pipeline shape: per-iteration FTA with mandatory user gates

v6's defining change from earlier versions: Fault Tree Analysis (FTA, Phase 3)
runs as a loop of **iterations**, not one flat tree. Each iteration drills into
one base event from the previous iteration and produces its own root cause;
iterations chain into a causal chain. Flow:

```
/rca <description>                          (fresh start)
  → orchestrator init (Phase 0)
  → 3gpp-scoping (Phase 1, IS/IS-NOT)
  → 3gpp-event-timeline (Phase 2, top_event_candidates[])
  → 3gpp-top-event-confirmation → HALT (Checkpoint A)
/rca confirm                                 (user resumes)
  → iteration 1: build-tree → evaluate-branches → cross-reference → root-cause
  → 3gpp-fta-iteration-controller → HALT (Checkpoint B-1)
/rca dig deeper into P2.2                    (user resumes)
  → iteration 2: same 4-skill sequence, seeded from iteration 1's base event
  → HALT (Checkpoint B-2)
/rca accept                                  (user resumes)
  → phase3_root_cause_chain synthesized across all iterations
  → orchestrator finalize (Phase 4) → report written → complete
```

`/rca` is a **dispatcher**, not a linear script: it reads
`meta.current_phase` from the state file and runs only the next step, then
halts. It never guesses the phase from context — always re-derive it from the
state file's `current_phase` state machine (documented in
`_shared/state-file-schema.md`).

### The state file is the single source of truth

Every skill reads and writes one JSON state file
(`/tmp/rca_state_<UTC_ts>.json`, path cached at
`.rca/current_state_path.txt` in the target workspace). No skill holds state
in conversation memory alone — if it's not in the state file, it doesn't
count. Skills are required to **slice-read** only the sections they need
(never eagerly load the whole file — the orchestrator's Phase 4 finalize is
the *only* full-file read in the pipeline).

### Hard invariants (apply to every skill — see `.clinerules/3gpp-rca-collaboration.md`)

1. **Table isolation**, enforced at the tool layer by `log_query.py`:
   Phase 1/2 and FTA Gate A may only query `UE_3gpp_signaling_log`; FTA Gate B
   may only query `UE_Trace_log`. Violating this is a policy error, not a
   style nit.
2. **Keyword provenance**: every keyword (message name, IE name, log literal,
   function name) used in any query must trace back to a prior Python tool
   invocation *in the same iteration* — never from the model's pretrained
   knowledge. Cross-iteration reuse is allowed only for deriving the next
   iteration's top event from the previous iteration's base event. See
   `_shared/keyword-provenance-rules.md`.
3. **Hard termination, no fix generation**: the pipeline's deliverable is a
   verified root cause and causal chain — never a fix, patch, config change,
   test case, or "next step". This is checked mechanically at Phase 4 finalize
   (a forbidden-pattern string scan) and must be preserved in any skill you
   edit or add.
4. **User gates are mandatory**: Checkpoint A (confirm top event) and
   Checkpoint B (per-iteration dig/accept/abort) cannot be skipped or
   fast-mode'd. Overriding the agent's recommendation is allowed but requires
   an explicit `confirm override` round-trip, and both the recommendation and
   the override are recorded in `user_decisions[]` for audit.
5. **Iteration budget** defaults to 5 (`meta.iteration_budget`); the
   iteration-controller forces an `accept_terminal` recommendation once
   near/at budget, though the user can still override.

### Tool invocation pattern

Skills never call retrieval systems directly — they shell out to one of three
Python scripts under `3gpp-tools/` (`spec_query.py`, `code_search.py`,
`log_query.py`), selecting behavior via `--operation`/`--phase-tag` flags. Each
script writes its structured output directly into the state file and prints a
compressed JSON summary to stdout (raw spec/code/log data never round-trips
through stdout). Exit codes 0–4 have specific meanings (success / bad args /
tool unavailable / policy violation / empty result) that calling skills must
branch on — see `_shared/tool-invocation-templates.md` for the full contract
per operation.

### `v6-coworker-interaction-model.md` is a design doc, not implemented behavior

This file at the repo root describes a proposed "engineer as co-worker"
inversion (standalone skill invocation, state seeding, resume-with-injection)
that is **not yet built** into the skills — it explicitly says so in its own
"NOTE ON BASELINE ALIGNMENT" section. Skills as they exist today assume the
`full_workflow` orchestrator-driven mode described in `.clinerules/`. Don't
assume `contract:` blocks, `seed_and_run`, or `ENGINEER_PROVIDED` evidence
tiers exist in the current skills unless you're implementing this design.

## Working in this repo

- There is no build, lint, or test command — validate changes by reading them
  against `_shared/state-file-schema.md` (state shape), the invariants above,
  and consistency with sibling skills that read/write the same state-file
  sections (see the "Per-Section Write Owners" table in
  `_shared/state-file-schema.md`).
- Frontmatter `description:` in each `SKILL.md` is what Cline's skill
  triggering matches against — keep it specific about when the skill fires
  and when it must NOT (most skills list explicit anti-triggers).
- `.clinerules/3gpp-rca-collaboration.md` is the only always-on rule; anything
  phase-specific belongs in the relevant `SKILL.md`, not there.
