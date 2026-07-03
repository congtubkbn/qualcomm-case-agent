# qualcomm-case-agent — Current Flow Analysis & Downstream RAG / Document Design

- Date: 2026-07-03
- Status: research / proposal
- Related:
  - [2026-06-20-qualcomm-case-agentic-pipeline-design.md](2026-06-20-qualcomm-case-agentic-pipeline-design.md)
  - [2026-06-20-qualcomm-case-agent-consumer-interface-design.md](2026-06-20-qualcomm-case-agent-consumer-interface-design.md)
  - [2026-06-21-qualcomm-auth-vault-design.md](2026-06-21-qualcomm-auth-vault-design.md)

## Part 1 — Analysis of the current flow

### 1.1 End-to-end pipeline (as implemented today)

```
Input: ONE 8-digit case code
  │
  ▼ Intake            intake.mjs — validate ^\d{8}$, strip CASE-, prep data/cases/ + _index.json
  ▼ PHASE 0  Attach   connect_chrome.ps1 → real Chrome, CDP 9222, persistent data/chrome-profile
  ▼ PHASE 1  Locate   open /s/global-search/<CODE> → readiness.js poll → click result → real URL
  │   └─ Recovery 1 (Auth, reactive only): Okta identifier-first → DPAPI qid.bin autofill →
  │      human pastes email OTP → "Keep me signed in" (~30 days)
  ▼ PHASE 1.5 Expand  click "View More Posts" / every "Expand Post" / "Description" until none left
  ▼ PHASE 2  Extract  extract_case.js (eval --stdin) → case.raw.json → scrape_case.mjs finalize
  │                    (count assert ≥ displayedCommentCount, SHA-256 hash, incremental check)
  │   └─ hash unchanged → "no update" → STOP
  ▼ PHASE 3  Enrich   LLM-as-analyst (inline or qualcomm-enrich skill) → data.enrichment
  ▼ PHASE 4  Persist  case.json → render_case.mjs → report.md / md / html / txt (+ pdf via Chrome)
  ▼ PHASE 5  Report   counts, status, root cause, open questions, paths
```

### 1.2 Login / data-acquisition layer — assessment

The auth design is a **two-layer model** and it is the strongest part of the pipeline:

| Layer | Mechanism | Frequency |
|-------|-----------|-----------|
| 1. Session reuse | persistent Chrome `--user-data-dir` on CDP 9222, attached BEFORE any navigation (PHASE 0) | every run, silent |
| 2. Forced re-login | Okta two-step; password from DPAPI `qid.bin` (never in chat); **email OTP always human-pasted** | only on session lapse (~30 days with KMSI) |

Properties worth preserving in anything built on top:

- **Session > password > OTP.** The common run touches no secret at all. OTP is the hard human
  dependency — no mailbox access ⇒ no fresh login, by design (fail-fast, never guess).
- **State-machine navigation**, not blind waits: `readiness.js` classifies READY / AUTH / EMPTY /
  BLANK / LOADING; each state has exactly one recovery, each recovery runs at most once.
- **Completeness is asserted, not hoped**: `comments.length >= displayedCommentCount` gates the
  write; partial capture is a hard failure (exit 5), never silently accepted.
- **Incremental by content hash**: SHA-256 over raw ⇒ unchanged case costs ~one page load and no
  LLM tokens.
- **Role split**: the model owns judgement (enrichment JSON); deterministic scripts own formatting
  (`render_case.mjs`) and finalization (`scrape_case.mjs`). Cheap, reproducible, testable.

### 1.3 Final outputs and who consumes them today

| Artifact | Consumer | What they get |
|----------|----------|---------------|
| `case.report.md` | **Manager / lead** | status, root cause, open questions, recommended actions — no log noise |
| `case.html` / `case.pdf` / `case.md` / `case.txt` | **Engineer** | every comment verbatim + per-comment analysis + 3GPP citations, offline-reviewable |
| `case.json` | **LLM / Agent B** | machine contract (consumer-guide.md): raw + `enrichment` — cache-first read, invoke skill only when missing |
| `_index.json` | orchestrators | sync registry `{syncedAt, commentCount, hash, enrichedAt}` |

**Key observation:** the `enrichment` schema already IS a retrieval-ready structure. Each comment
carries `{summary, role, keyPoints[], citations[], answered}`; the case carries
`{engineerSummary, rootCause, caseFlow[], openQuestions[], tags[], timeline[]}`. That means the
"chunking + metadata" problem that dominates most RAG builds is ~already solved by the existing
pipeline — downstream work is mostly **indexing + retrieval + rendering**, not re-modeling.

### 1.4 Gaps (what the current design deliberately leaves out)

1. **Single-case scope.** One code per run; `_index.json` exists but there is no cross-case view,
   no "find similar cases", no fleet/manager digest.
2. **No query layer.** Consumers read whole `case.json` files; nothing answers
   "which cases mention n78 desense with MSD?" without opening every file.
3. **Citations are dead text.** `TS 38.331 §5.3.7` is captured but not linked to the actual spec
   clause; the engineer still opens the 3GPP doc manually.
4. **No freshness/watch.** The portal sends no notification; a case only updates when a human asks.
5. **Qualcomm's own document library** (80-xxxxx docs, same Qualcomm ID login) is not captured at
   all, even though the authenticated Chrome profile could reach it.

## Part 2 — What can be built on the case corpus (research)

### 2.0 Hard constraint that shapes everything: NDA locality

Case bodies/logs are Qualcomm NDA material (`data/cases/` git-ignored, "never paste to external
services"). Consequences:

- **No external embedding APIs** over comment bodies (an embeddings call ships the text out).
  Either (a) lexical retrieval (BM25/FTS — zero external calls), or (b) a **local** embedding model
  (e.g. Ollama + bge-m3). Recommendation: **start lexical**; the corpus is small (tens of cases,
  thousands of comments) and telecom queries are keyword-heavy (band, EARFCN, 0xB0C0, TS numbers) —
  exact-token match outperforms semantic search for most of these anyway.
- **The reading LLM is the existing harness** (Claude Code / Cline), which already processes case
  bodies today (enrichment). RAG here = *file-based retrieval that feeds the in-session agent*,
  not a hosted service.
- Everything stays under `data/` (git-ignored), same as today.

### 2.1 Track A — Case-corpus knowledge base (cases → searchable KB)

**Goal:** answer "have we seen this before?" across all synced cases.

- **A1. Index builder** (deterministic script, sibling of `render_case.mjs`):
  `build_kb_index.mjs` walks `data/cases/*/case.json` → emits `data/kb/chunks.jsonl` +
  SQLite **FTS5** DB `data/kb/kb.db`. One chunk per comment
  (`body + analysis.summary + keyPoints`) and one per case-level field, each with metadata
  `{caseNumber, commentId, role, tags[], citations[], status, product, date, answered}`.
  Incremental: reuse the per-case `hash` from `_index.json` — unchanged case ⇒ skip re-index.
  No new heavy deps: Node ≥22 ships `node:sqlite`; FTS5 is compiled in.
- **A2. Search skill** `qualcomm-kb-search`: no browser, no login. Query → FTS5 (BM25, with
  tag/band/status filters) → top-k chunks → agent reads the matching `case.json` sections
  in-context and answers with case+comment citations. This is RAG where retrieval is lexical and
  "generation" is the session LLM — fully NDA-local.
- **A3. Similar-case finder**: given a case code, use its `tags[]` + `keyPoints[]` as the query
  against the KB minus itself → "related cases" section appended to `case.report.md`.

### 2.2 Track B — Generated documents (per-audience deliverables)

All deterministic renders / enrich-style passes over existing JSON — no portal access needed:

- **B1. Manager digest** `qualcomm-digest`: walk `_index.json` + each `enrichment` →
  `data/reports/digest-<date>.md/html`: open cases by status/priority, aging (days since last
  comment), unanswered-question count, waiting-on-whom (from `currentStatus`), root-cause table
  for closed cases. This is the "input for managers" artifact — today they'd have to read N
  report.md files.
- **B2. Lessons-learned / FAQ KB**: for cases with `rootCause !== "Unresolved"`, generate one
  `data/kb/lessons/<CODE>.md` — symptom → root cause → fix → spec clauses → tags. These chunks
  also feed Track A's index (highest-value retrieval targets).
- **B3. New-case bootstrap**: when opening a NEW Qualcomm case, query the KB with the draft
  symptom description → attach "we already tried X in case Y" context → better first message to
  Qualcomm, fewer round-trips.

### 2.3 Track C — 3GPP spec RAG (public specs; citations become live)

**Goal:** make `citations: ["TS 38.331 §5.3.7"]` clickable/retrievable.

- 3GPP specs are **public** (3gpp.org, no NDA) — this track has no locality constraint.
- **C1. Spec ingestion** `ingest_3gpp.mjs`: given a TS number + release, download the zip/docx from
  the 3GPP FTP, convert to text (e.g. pandoc), split **by clause heading** (`5.3.7 …`) →
  `data/specs/TS-38.331/<clause>.md` + a clause index.
  Clause-keyed lookup means **no vector search needed at all** for the citation path: the
  enrichment already emits exact clause ids ⇒ retrieval is a dictionary hit.
- **C2. Renderer hook**: `render_case.mjs` turns each citation into a link to the local clause file
  (HTML) when present. Enrich prompt can additionally quote the 2–3 relevant clause lines.
- **C3. Optional free-text spec search**: FTS5 over clause chunks for "what does the spec say
  about T310?" queries (same engine as Track A, separate table).
- Priority list to ingest (from the corpus's own citations): 38.331, 38.101-1/2, 38.133, 38.213/214,
  36.331, 36.101, 24.501, 24.301 — build the list dynamically by scanning all `citations[]`.

### 2.4 Track D — Qualcomm document RAG (NDA docs behind the same login)

**Goal:** the same access pattern as cases, applied to Qualcomm's doc library
(80-xxxxx application notes, ISOD/QXDM guides, KBAs on the support portal).

- **Feasibility:** the authenticated Chrome profile (PHASE 0) already holds the Qualcomm ID
  session; docs.qualcomm.com / createpoint use the same SSO. A sibling skill
  `qualcomm-doc-agent` can reuse PHASE 0 / Recovery 0-1 **verbatim** (same scripts) and swap only
  the locate/extract phases (search doc number → download PDF/HTML → `data/docs/<DOCID>/`).
- **Indexing:** extract text (pdftotext), chunk by section, add to the same FTS5 DB with
  `source: "qc-doc"` metadata. NDA ⇒ identical locality rules as cases.
- **Payoff:** enrichment can then cite Qualcomm doc sections (e.g. log packet definitions,
  NV/EFS items) next to 3GPP clauses — this is the highest-value RAG for actual debugging, since
  Qualcomm answers usually reference their own docs.
- **Caution:** portal ToS — only documents the signed-in account is entitled to; keep the
  one-artifact-per-run, assert-completeness discipline.

### 2.5 Track E — Case watch (freshness)

`_index.json` already has `syncedAt` + `hash`. A scheduled "re-sync open cases" loop (orchestrator
per UC-11: sequential, one profile lock) turns the pipeline into a monitor: hash changed ⇒ enrich
delta ⇒ regenerate digest ⇒ notify. The incremental design makes this nearly free when nothing
changed.

## Part 3 — Recommended implementation order

| Step | Deliverable | Effort | Depends on |
|------|-------------|--------|-----------|
| 1 | `build_kb_index.mjs` + FTS5 DB (A1) | S — deterministic script | existing case.json only |
| 2 | `qualcomm-kb-search` skill (A2) + similar-cases (A3) | S | 1 |
| 3 | `qualcomm-digest` manager report (B1) | S | existing enrichment |
| 4 | 3GPP clause ingestion + citation links (C1–C2) | M | public downloads |
| 5 | Lessons-learned generation (B2) → feeds index | S | 1 |
| 6 | `qualcomm-doc-agent` (D) | L — new scrape surface | reuses PHASE 0/Recovery 1 |
| 7 | Watch loop (E) | S | 1–3 |

Decision points to confirm before building step 1:
- Lexical-first (FTS5/BM25) vs local embeddings — proposal: lexical now, embeddings only if recall
  proves insufficient (keyword-heavy domain suggests it won't).
- KB location `data/kb/` (git-ignored, NDA) — same lifecycle as `data/cases/`.
- Chunk granularity: per-comment (raw+analysis merged) + case-level fields + lessons files.

## Part 4 — What NOT to build

- A hosted vector DB / external RAG service — violates NDA locality for zero benefit at this corpus size.
- A freshness TTL inside the consumer contract — keep cache-first (existing approved design); watch loop (E) handles staleness explicitly.
- Re-chunking raw HTML — `case.json` is already the normalized source of truth; index from it only.
- Embedding the whole 3GPP corpus — clause-keyed lookup covers the citation path; ingest only cited specs.
