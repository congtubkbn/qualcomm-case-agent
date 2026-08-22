---
name: qualcomm-case-summary
description: "Qualcomm Case Summary. Given ONE Qualcomm case code, ensures the case is captured (delegating to qualcomm-case-agent), reports its own Status field verbatim, and produces a compact per-comment technical summary plus a case-level flow narrative, newest-first, in a persisted `summary.json`/`summary.md`. Incremental: re-summarizes only comments new since the last run (a delta) — an unchanged case costs zero model calls. Downstream, read-only consumer of qualcomm-case-agent; never modifies case.json, comment order, or merge logic. Triggers: 'summarize qualcomm case <code>', 'case status <code>', 'what's the state of case <code>'. Use whenever the user wants a case's status and comment history summarized, not just captured."
allowed-tools: Bash(node:*), Read, Write
---

# Qualcomm Case Summary

**Role.** Given one **case code**, report the case's own Status and a compact, newest-first
summary of its comment history: a short technical digest per comment, plus a case-level flow
narrative. Read-only downstream consumer of `qualcomm-case-agent`'s `case.json` — see
`references/consumer-guide.md` in that skill.

**Input contract.** Same as `qualcomm-case-agent`: one Qualcomm case code = exactly 8 digits
(`CASE-` prefix accepted and stripped).

---

## Flow — two script steps, you summarize in between

Everything mechanical (ensuring capture, computing what's new, writing files) is deterministic
script. The summarization judgment — reading each new comment and the case flow so far, and
producing the per-comment digest and updated narrative — is yours; that is the entire reason this
is a skill and not a headless pipeline (see ADR 0002).

**Step 1 — prepare:**
```bash
node ".claude/skills/qualcomm-case-summary/scripts/run_summary.mjs" prepare <CODE>
```
Prints one JSON line. Branch on `status`:

| `status` | Meaning | Your next step |
|----------|---------|----------------|
| `needs-summary` | New comments since last run (`deltaComments`, `priorFlow`, `caseStatus`) | Go to Step 2 |
| `no-delta` | Nothing new; `summary` is the cached result | Report `summary` directly, STOP |
| `created` / `updated` / `no-update` never appear here — those only gate whether capture succeeded | | |
| `auth-required` / `not-found` / `blocked` / `busy` / `error` | `qualcomm-case-agent`'s capture didn't succeed cleanly (`capture` holds its verdict) | Surface that verdict's guidance as-is (see `qualcomm-case-agent`'s SKILL.md table). Do not attempt summarization. |

**Step 2 — you summarize (only when `status` was `needs-summary`):**

For every comment in `deltaComments`, using its verbatim `body` (never a truncated or
pre-filtered version — the 20,000-char cap already applied is a pathological-input safety guard,
not a summarization step), produce an object:
```json
{ "id": "<comment id>", "timestamp": "<comment timestamp>", "author": "<comment author>",
  "issue": "<optional>", "status": "<optional PASS/FAIL/etc>", "nextAction": "<optional>" }
```
Include only the `issue`/`status`/`nextAction` dimensions that actually fit the comment's content —
a plain acknowledgement may only have `nextAction`, or none of the three. Then, using `priorFlow`
as context, write an updated one-paragraph (or short multi-paragraph) `flow` narrative — update it,
don't regenerate it from scratch.

Write both into a JSON file (e.g. a scratch/temp path) shaped `{ "comments": [...], "flow": "..." }`.

**Step 3 — finalize:**
```bash
node ".claude/skills/qualcomm-case-summary/scripts/run_summary.mjs" finalize <CODE> --input <path-to-your-json-file>
```
Merges your batch into `summary.json` (preserving prior summaries untouched) and renders
`summary.md` newest-first. Prints `{ status: "summarized", summaryPath, mdPath, newCount }`.

---

## Output Artifacts

`data/cases/<CODE>/summary.json` (structured, owned exclusively by this skill) and
`data/cases/<CODE>/summary.md` (human-readable, newest-first). Never written on a `no-delta` run.

## Reporting

Tell the user: the case's Status (verbatim), the case flow narrative, and the newest few comment
summaries — point to `summary.md` for the full newest-first list.

## Guardrails

- **Read-only on `case.json`/`_index.json`.** Never write to them — those are owned by
  `qualcomm-case-agent`.
- **Confidentiality unchanged.** Comment bodies are still Qualcomm NDA content; you (the agent
  running this skill) already have workspace access to them via `case.json` — never paste them to
  an external service. Summarization happens in this same session, not via a script-initiated
  network/API call.
- **One model call per run.** Summarize the entire `deltaComments` batch in Step 2 in one pass, not
  one comment at a time.
- **Case Status is a verbatim passthrough** — never reclassified or inferred.
- **Scope:** one case per invocation.
