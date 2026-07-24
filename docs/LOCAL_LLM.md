# Can this skill run on a local LLM in 4–7 GB of RAM?

**Short answer: yes for the analysis, and the capture no longer needs a model at all.**

The pipeline has three kinds of work. Sorting them is the whole answer:

| Work | Needs a model? | Where it runs now |
|---|---|---|
| Sign in, find the case, paginate, expand, extract, hash, render, PDF | **No** — it is deterministic | `run_case.mjs`, zero tokens, zero RAM |
| Per-comment analysis: summary, role, key points, answered/unanswered | Yes, but small | **local, fits 4–7 GB** (`enrich_local.mjs`) |
| Case-level synthesis: engineer summary, current status, root cause, open questions | Yes, small-to-medium | **local, fits** — it reads the per-comment summaries, not the raw bodies |
| Exact 3GPP clause recall, cross-spec reasoning, judgement calls on next debug steps | Yes, large | keep on the cloud model |

Before this change, "can a local model do it?" was the wrong question, because most of the token
spend was browser choreography, not reasoning. That part is now code. What remains is a
short-input, structured-output job — exactly what a 4B–8B model is good at.

---

## What fits in the budget

Sizing rule: a Q4_K_M GGUF is about **0.6 GB per billion parameters**, plus the KV cache
(roughly 0.5–1.0 GB at 8k context for these sizes), plus ~0.3 GB of runtime.

| Model | Q4_K_M weights | + 8k KV + runtime | Verdict |
|---|---|---|---|
| Qwen3-4B-Instruct | ~2.4 GB | **~3.3 GB** | fits 4 GB — the pick if RAM is tight |
| Qwen2.5-7B-Instruct | ~4.4 GB | **~5.4 GB** | fits 6–7 GB — best quality in budget |
| Llama-3.1-8B-Instruct | ~4.9 GB | **~5.9 GB** | fits 7 GB, tight at 6 |
| Phi-4-mini (3.8B) | ~2.3 GB | ~3.2 GB | fits 4 GB; weaker on long technical text |
| anything ≥ 13B | ≥ 7.5 GB | — | does not fit |

**Recommendation:** 4 GB → `qwen3:4b-instruct` (or `qwen2.5:3b-instruct`) at 8k context.
6–7 GB → `qwen2.5:7b-instruct-q4_K_M` at 8k context (the default in `enrich_local.mjs`).

Context length is the other half of the budget: going 8k → 32k roughly triples the KV cache and
will push a 7B model out of 7 GB. Keep it at 8k — the prompts here are built to fit.

## Why the prompts fit 8k

- **Per comment:** one comment body, clipped at 6000 chars (`--max-body`), plus a ~200-token
  schema instruction. Typically 1.5–2k tokens in, ~250 out.
- **Case level:** the *summaries* of up to 40 comments at 400 chars each, plus the description.
  ~4–5k tokens in, ~600 out.
- Never the whole case: a 40-comment case with full bodies and logs is 60–120k tokens and would
  not fit in any model you can run in 7 GB.

## Speed, honestly

CPU-only, a 7B Q4 model runs at roughly **4–8 tok/s** on a typical laptop; a 250-token analysis is
**30–60 s per comment**. A 20-comment case is 10–25 minutes. A 4B model is about twice as fast.
With GPU offload (even 6 GB VRAM) it drops to seconds.

That makes local enrichment a good fit for **scheduled overnight sweeps** and a poor fit for
"analyze this case while I wait". The scheduler is where to turn it on:

```json
{ "enrich": "local" }     // data/watchlist.json
```

## What the local model must not be trusted with

`enrich_local.mjs` enforces these in code rather than hoping the prompt holds:

- **Invented 3GPP citations.** Small models produce plausible, wrong clause numbers. The prompt
  restricts `citations[]` to clauses the comment text itself cites; treat anything there as a
  pointer to verify, not a fact.
- **Malformed output.** A response that does not parse into the schema leaves that comment
  **unanalyzed** and increments `failed` — it never writes a guessed analysis. The cloud model or
  the `qualcomm-enrich` skill can fill the gap later.
- **Role/enum drift.** `role` is coerced to the fixed set, unknown values become `Info`.
- **Judgement.** `rootCause` from a 7B model is a starting point. For a case that matters, run
  PHASE 3 on the cloud model — the two write the same schema, so they interchange freely.

Every analysis records `enrichment.enrichedBy` (`local:<model>` or absent for a cloud pass), so
you can always tell which produced what.

---

## Setup

### Ollama (simplest)

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M      # or qwen3:4b-instruct on a 4 GB budget
ollama serve                                 # http://127.0.0.1:11434
```

### llama.cpp / LM Studio / vLLM

Any OpenAI-compatible `/chat/completions` endpoint works. Point the script at it:

```bash
set QUALCOMM_LLM_ENDPOINT=http://127.0.0.1:8080/v1
set QUALCOMM_LLM_MODEL=qwen2.5-7b-instruct
```

llama.cpp example: `llama-server -m qwen2.5-7b-instruct-q4_k_m.gguf -c 8192 --port 8080`

### Verify, then use

```bash
npm run llm:check                                   # endpoint + model + a JSON round-trip
node .claude/skills/qualcomm-case-agent/scripts/enrich_local.mjs 08603854
node .claude/skills/qualcomm-case-agent/scripts/enrich_local.mjs 08603854 --all   # redo every comment
node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs 08603854 --enrich local
```

| Env var | Default |
|---|---|
| `QUALCOMM_LLM_ENDPOINT` | `http://127.0.0.1:11434/v1` |
| `QUALCOMM_LLM_MODEL` | `qwen2.5:7b-instruct-q4_K_M` |
| `QUALCOMM_LLM_KEY` | `local` |
| `QUALCOMM_LLM_TIMEOUT_MS` | `300000` |

It is incremental by default: comments that already have an analysis are skipped, case-level
fields are always re-synthesized (new comments change the conclusion).

**Confidentiality:** case content is Qualcomm NDA material. A *local* endpoint keeps it on the
machine — that is the point. Do not repoint `QUALCOMM_LLM_ENDPOINT` at a hosted API without
clearing that first; the script will happily send comment bodies wherever you aim it.

---

## Using a local model as the Cline agent itself

Different question, different answer. A 4–7 GB model driving Cline end-to-end is not
recommended: agentic tool-calling needs reliable multi-step planning and exact tool-call syntax,
and models this size drop tool calls, mis-escape arguments, and loop. The split that works:

- **Cline on a capable cloud model** — decides, reads verdicts, writes the report.
- **`run_case.mjs`** — all the browser work, no model.
- **Local 4–7 GB model** — bulk per-comment enrichment via `enrich_local.mjs`, on a schedule.

That keeps per-case cloud tokens at roughly the skill activation plus a verdict line, and puts
the repetitive analysis on hardware you already own.

---

## Status of this assessment

Sizing, prompt budgets and the code path are verified as far as they can be here: the parsing,
schema-coercion and failure behaviour are unit-tested (`npm test`), and the script speaks plain
OpenAI-compatible JSON. **It has not been run end-to-end against a live local server in this
environment** (no model or GPU available here) — `npm run llm:check` is the one-command way to
confirm it on your machine, and the throughput figures above are typical-hardware estimates, not
measurements from this project.
