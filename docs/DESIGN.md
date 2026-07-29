# Design & Architecture — `qualcomm-case-agent`

**Audience:** architecture review, senior/expert developers joining or auditing this pipeline.
**Scope:** the whole repo — the agent skill, the headless capture pipeline, the enrichment layer,
the scheduler and the local dashboard.
**Status:** describes the code at the fingerprint recorded in §7. Sections 1–6 and 8–12 are
hand-written (intent, rationale, trade-offs); §7 is generated from the source on every commit
(see §12).

---

## 1. Problem, constraints, non-goals

### 1.1 The problem

Qualcomm Support (`support.qualcomm.com`) is a Salesforce Lightning portal. A support case is a
Chatter feed: metadata plus an arbitrarily long, paginated, collapsed comment thread carrying the
actual engineering content (symptoms, QXDM logs, 3GPP references, requests for data). Engineers
need three things the portal does not give them:

1. **The complete case offline** — every comment verbatim, not the first page, not a summary.
2. **An engineer-grade reading of it** — what broke, what has been tried, what is still open.
3. **To know when it changes** — without re-reading a 40-comment thread by hand.

### 1.2 Constraints that shaped every decision

| # | Constraint | Consequence |
|---|---|---|
| C1 | **No API.** The portal exposes no case API to this account; the DOM is the interface. | Browser automation is the only transport. |
| C2 | **Okta SSO with email OTP.** The 6-digit code arrives in a mailbox no automation here can read. | Full unattended auth is *impossible*; the design must degrade to "ask the human once", not retry-loop. |
| C3 | **NDA content.** Case bodies, logs and customer names are confidential. | Cache stays local + git-ignored; no external LLM endpoint; dashboard is loopback-only. |
| C4 | **Model tokens are the dominant cost.** The measured baseline was 123k input tokens for one case (flow 1784759542159), almost all of it browser choreography. | Anything deterministic must leave the model's context entirely. |
| C5 | **Windows + PowerShell host, driven by more than one agent harness** (Claude Code, Cline). | No shell-quoted payloads; no bash-only idioms; every step must be a single plain command. |
| C6 | **Fidelity over convenience.** A truncated comment is worse than no comment. | Capture is verbatim; completeness is asserted before persisting; analysis lives in a separate field. |

### 1.3 Non-goals

- Multi-case capture in one invocation (the scheduler is the multi-case path).
- Writing back to the portal (read-only by ToS and by design).
- A hosted/multi-user service — this is a single-desktop tool, and C3 keeps it that way.
- Replacing the engineer's judgement: enrichment is a reading aid, never a verdict.

---

## 2. System context

```mermaid
graph LR
  subgraph Human
    U[Engineer]
  end
  subgraph "Agent harness (Claude Code / Cline / any terminal agent)"
    S[SKILL.md runbook]
  end
  subgraph "This repo (one desktop)"
    RC[run_case.mjs<br/>capture pipeline]
    EN[enrich_local.mjs<br/>optional local LLM]
    SC[scheduler.mjs]
    WEB[web/server.mjs<br/>127.0.0.1:8787]
    FS[(data/ cache<br/>git-ignored)]
  end
  AB[agent-browser CLI]
  CH[Real Chrome<br/>persistent profile, CDP 9222]
  QC[(support.qualcomm.com<br/>Salesforce Lightning)]
  LLM[(Local OpenAI-compatible<br/>LLM server)]

  U -->|case code| S
  S -->|one command| RC
  U -->|npm run case/sync/web| RC
  RC --> AB --> CH -->|Okta SSO| QC
  RC --> FS
  SC --> RC
  WEB --> FS
  U -->|browser| WEB
  RC -.->|--enrich local| EN --> LLM
  EN --> FS
  S -->|reads verdict line, writes enrichment| FS
```

The trust boundary is the desktop. Nothing leaves it except the authenticated HTTPS session to
Qualcomm; the LLM endpoint is loopback by default and the dashboard binds `127.0.0.1` only.

---

## 3. Architecture

### 3.1 The central split: **capture is code, analysis is a model**

This is the load-bearing decision of the whole system. Every step of retrieval — sign in, resolve
the case URL, paginate, expand posts, read the DOM, hash, merge, render — is a *decision-free*
procedure. Driving it turn-by-turn through an agent means dumping a Salesforce accessibility tree
into a model's context dozens of times so it can find one element reference to click. That is C4's
123k tokens, and none of it is reasoning.

So the pipeline is split at the point where judgement actually begins:

| Layer | Owner | Cost | Contract |
|---|---|---|---|
| Retrieval + persistence + rendering | `run_case.mjs` and friends (plain Node) | 0 tokens | one JSON verdict line on stdout, one exit code |
| Interpretation (per-comment analysis, root cause, open questions) | a model — cloud (SKILL.md PHASE 3) *or* local (`enrich_local.mjs`) | small, bounded | writes only `case.json → enrichment` |
| Orchestration + reporting to the human | the agent harness | one verdict line + the comment bodies it analyzes | SKILL.md |

The agent's entire view of a capture is ~200 tokens. `SKILL.md` states the rule explicitly:
*"Do NOT `Read` `case.json` to find out what happened."*

### 3.2 Layers

```mermaid
graph TD
  A["Runbooks — SKILL.md · .clinerules · references/*<br/>harness-agnostic prose, loaded on demand"]
  B["Orchestration — run_case.mjs · scheduler.mjs · web/server.mjs"]
  C["Browser adapter — browser.mjs (argv-array spawn, eval -b, CDP attach)"]
  D["Page scripts — readiness.js · find_case_link.js · expand_step.js · extract_case.js<br/>run INSIDE the tab, return small objects"]
  E["Persistence + integrity — intake.mjs · scrape_case.mjs · lock.mjs · _paths.mjs"]
  F["Presentation — render_case.mjs (report.md · md · html · txt) + PDF via Chrome"]
  G["Analysis — enrich_local.mjs / cloud PHASE 3 → enrichment only"]
  A --> B --> C --> D
  B --> E --> F
  B --> G --> F
```

Two properties fall out of this layering and are worth stating as rules, because most of the
project's historical bugs were violations of them:

- **Nothing crosses a shell.** `browser.mjs` spawns `agent-browser` with an argv array; page
  scripts cross as base64. No quoting, no dialect (§4, D4/D5).
- **Page scripts return counters, never DOM dumps.** `expand_step.js` clicks *inside the page* in a
  loop and returns `{articles, displayed, anchorIdx, clicked…}` — a few dozen bytes replacing ~15
  snapshot round-trips per case.

### 3.3 Component responsibilities

| Component | Responsibility | Explicitly not responsible for |
|---|---|---|
| `intake.mjs` | Validate the 8-digit code, create cache dirs, sanity-check `_index.json` | Anything network |
| `browser.mjs` | Chrome lifecycle on CDP 9222, `eval -b` transport, error typing (`BrowserError`) | Knowing anything about cases |
| `readiness.js` | Classify SPA page state into one enum: `AUTH/READY/EMPTY/BLANK/LOADING` | Waiting (the caller polls) |
| `find_case_link.js` | Resolve search row → real `/s/case/<SFID>/…` URL **and** the header fields that exist only on that row | Navigating |
| `expand_step.js` | One expansion/pagination tick; doubles as the fast no-update probe | Extraction |
| `extract_case.js` | Read the expanded DOM into the raw case object | Completeness policy |
| `scrape_case.mjs` | Completeness gates, merge policy, SHA-256 identity, canonical write, index update | Browser, analysis |
| `render_case.mjs` | Deterministic formatting of whatever is in `case.json` | Summarizing, reordering, inventing |
| `enrich_local.mjs` | Local-model enrichment with schema coercion and fail-closed parsing | Touching raw fields or `hash` |
| `scheduler.mjs` | Due-ness, sweep, run-log, stop-on-auth | Capturing (it shells out to `run_case.mjs`) |
| `web/server.mjs` | Loopback dashboard + JSON projection + whitelisted artifacts | Long-running work (it detaches) |

---

## 4. Design decisions and why

Each decision is stated with the alternative that was rejected and the cost that was accepted —
that is what makes it reviewable.

| # | Decision | Alternative rejected | Why | Accepted cost |
|---|---|---|---|---|
| D1 | **Real system Chrome over CDP 9222 with a persistent `--user-data-dir`** | Playwright's bundled Chromium; a fresh headless context per run | The bundled build's CDP handshake broke (`os error 10060`); more fundamentally, the Okta session must *survive between runs* (C2) — a persistent, OS-trusted, signed browser profile is what makes MFA one-time (~30 days) instead of per-run | A real desktop session is required; the machine must be logged in; profile is user-bound and non-portable |
| D2 | **Capture is deterministic code; only interpretation reaches a model** (§3.1) | Agent-drives-browser choreography | C4: ~123k → ~5k tokens per case, and it makes the *same* pipeline usable with no model at all (scheduler) | The pipeline must encode DOM knowledge that a model could have improvised; DOM drift becomes a code change |
| D3 | **In-page click loops** (`expand_step.js`) instead of snapshot→ref→click | `agent-browser snapshot -c` + one click per control | Removes the dominant token cost and ~15 round-trips per case; the loop is trivially bounded | The page script cannot ask for help; it must be defensive and return diagnostics |
| D4 | **`agent-browser eval -b <base64>`** for every page script | `eval --stdin`, `<` redirection, inline JS | `--stdin` **silently returns `null`** when fed from a PowerShell pipe (reproduced live, flow 1784759542159 §3); base64 has no shell metacharacters, so the nested-quote class of bug disappears too | 8191-char cmd.exe ceiling → `browser.mjs` strips comments and refuses payloads > 7000 b64 chars |
| D5 | **Node `spawnSync` with an argv array; on Windows one hand-built `cmd.exe` line rejecting metacharacters** | `shell: true`, PowerShell wrappers | Five distinct quoting failures in one flow (flow 1784759542159 §1). An argv array is not re-tokenized on POSIX; on Windows the metachar check turns a silent mangling into a loud error | A path containing `& \| < > ^ " % !` fails fast rather than being escaped (§11, I7) |
| D6 | **The agent↔code contract is one JSON line + a distinct exit code per outcome** | Prose output, or the agent reading `case.json` | Machine-checkable, cheap, and it lets the scheduler branch on the same contract with no model in the loop; distinct exits let cron/Task Scheduler alert correctly | The verdict schema is now public API for three consumers (skill, scheduler, dashboard) |
| D7 | **Incremental sync via SHA-256 over verbatim fields only** (`computeHash`) | Timestamp comparison; hashing the whole file | Enrichment must not change a case's identity, or every re-analysis would look like a change. Stable field order ⇒ stable hash across runs | The hash covers relative timestamps, which drift, so a full re-capture can hash differently with no real change (§11, I16) |
| D8 | **Anchor-based incremental expansion** — stop paginating at the newest cached comment | Always full expansion | An update run on a 40-comment case touches only the new posts; the cached bodies are kept verbatim rather than re-scraped | Nested replies under old posts can hide from the probe (§11, I5) |
| D9 | **Merge policy: cache is authoritative for old content; the fresh page only fills blanks; CLI header flags win on an update** | Overwrite with the fresh capture | An update capture is deliberately *partial* — old posts stay collapsed. Overwriting would truncate good cached data. But Status/Priority genuinely change over a case's life, so those are taken from the fresh search row | Merge identity depends on the `commentKey` heuristic (§11, I3) |
| D10 | **Fail-closed completeness gates before any write**: 0 comments → `INCOMPLETE`; captured < displayed → `INCOMPLETE`; empty title → `INCOMPLETE` | Persist and warn | A failed pull must never overwrite a good cached case, and an empty title is "a failed pull dressed as success" | A legitimately odd case (no title on an archived record) is rejected; the manual flow exists for that |
| D11 | **`blocked` is never downgraded to `no-update`** | Treat a probe failure as "nothing changed" | "Unchanged" is a positive finding. Reporting it on a failed probe is the one wrong answer this tool can give a user — it is silent data loss | Some runs end inconclusive and need a human |
| D12 | **Plain JSON files as the entire datastore** (`case.json`, `_index.json`, `watchlist.json`, `runs.json`) | SQLite / an embedded DB | Single-writer, single-desktop, human-inspectable, diff-able, trivially backed up, and readable by an agent with a Read tool. A DB would add a dependency and a migration story for no gain at this scale | Read-modify-write races between scheduler and dashboard (mitigated, not eliminated — §11, I6) |
| D13 | **Advisory PID+timestamp capture lock** (`data/.capture.lock`, stale after 30 min or dead PID) | An OS mutex; a job queue | All three capture paths drive the *same* Chrome tab; two at once interleave navigation. A `busy` verdict is a correct, cheap answer | Known exists→write race; accepted because the completeness gates refuse to persist a garbled run anyway |
| D14 | **Local-LLM enrichment is optional and schema-coerced; unparseable output leaves a comment unanalyzed** | Retry until it parses; accept free text | C3 (content stays local) plus honesty: a malformed response is not a licence to invent an analysis. `role` is coerced to a fixed enum; `failed` is counted and reported | Local enrichment is slow (30–60 s/comment CPU-only) and weak at 3GPP clause recall — documented as such |
| D15 | **Four rendered formats from one deterministic renderer** (`report.md`, `md`, `html`, `txt`, + PDF printed from the HTML) | Let the model write the report | The renderer cannot summarize, reorder or invent — it only formats `case.json`. That keeps the human-facing artifacts provably faithful to the capture | Four formats to keep in sync inside one file (they share helpers; changes must be made in all four) |
| D16 | **Dashboard binds `127.0.0.1` and additionally verifies `Host`/`Origin`** | Bind-only | Binding alone does not stop a malicious page on the same machine (CSRF) or DNS rebinding. Artifacts are served from a fixed whitelist, so no path traversal reaches the cache | Any *local process* can still drive the API — accepted on a single-user desktop |
| D17 | **The skill lives in the repo** (`.claude/skills/…`), harness-agnostic, references loaded on demand | A global/installed skill; one monolithic runbook | The runbook travels with the code it drives, so they cannot drift apart across machines; on-demand references cut activation from ~15.6k to ~4.7k tokens | Two harness entry points to maintain (`SKILL.md`, `.clinerules/`) |
| D18 | **Paths resolve by walking up to a marker** (`_paths.mjs` / `_paths.ps1`), never from CWD | `../..` relative paths | A scheduled task, a dashboard child process and an interactive run all start in different directories but must agree on one cache. Re-nesting the skill does not break it | A `QUALCOMM_ROOT` escape hatch is needed for layouts with no `.git` |
| D19 | **Comment identity is content-derived** (`commentId` = hash of author + body prefix), assigned in the finalizer, and **`enrichment` survives every re-capture** | Positional ids from the extractor; trusting the Chatter DOM id | `enrichment.commentAnalyses` is keyed by comment id, so a positional id meant a full re-capture re-keyed every comment and re-attached each analysis to the *wrong* one — and a full re-capture dropped `enrichment` outright. Deriving the id from the content that defines the comment makes both problems disappear: the cached analysis lands back on the comment it was written for, whatever position it now holds | Two comments with the same author and same opening 120 chars are ambiguous; they are kept distinct with a `-N` suffix and reported as `idCollisions` rather than resolved silently. Caches on the old scheme are migrated on read (`migrateIds`) and re-hash once |

---

## 5. Data model and state

### 5.1 `data/cases/<CODE>/case.json` — the source of truth

```jsonc
{
  "caseNumber": "08603854",
  "title": "…", "status": "…", "priority": "…", "severity": "…",
  "product": "…", "customer": "…", "created": "…", "updated": "…",
  "description": "…",
  "url": "https://support.qualcomm.com/s/case/<SFID>/<slug>",
  "displayedCommentCount": 11,            // portal's own top-level total, or null
  "comments": [                            // NEWEST FIRST, verbatim, never truncated
    { "id": "c9f2a1b7c4d0",                // content id — sha256(author + body prefix), see below
      "timestamp": "…", "company": "", "author": "…", "role": "",
      "body": "…", "analysisLog": [], "attachments": [] }
  ],
  "hash": "<sha256 over verbatim fields only>",
  "extractedAt": "<ISO-8601>",
  "enrichment": { /* §5.2 — the ONLY writable region for a model */ }
}
```

**Invariant:** raw fields and `hash` are written by `scrape_case.mjs` alone. Analysis never mutates
them. That is what lets a case be re-analyzed any number of times without looking "changed".

**Comment identity (D19).** `id` is derived from the comment's own content — `commentId(c)` =
`sha256(author + whitespace-normalized body prefix)` — and assigned by the finalizer for every
persisted comment, whatever the extractor supplied. Two consequences the whole cache depends on:
the same comment keeps the same id across every capture regardless of its position in the feed, so
`enrichment.commentAnalyses[<id>]` re-attaches to the comment it was written for; and a duplicate
identity is a real ambiguity, so it is kept as a separate comment with a `-N` suffix and counted in
the verdict's `idCollisions` instead of being merged away. A cache written with the old positional
ids (`c1`, `c2`, …) is migrated on read by `migrateIds`, which re-keys `commentAnalyses`,
`commentSummaries` and `caseFlow[].refComments` in the same pass.

### 5.2 `enrichment` — the analysis region

Case level, regenerated in full on every pass (new comments can change the conclusion):
`engineerSummary`, `currentStatus`, `rootCause`, `caseFlow[]` (oldest→newest debug narrative with
`refComments`), `openQuestions[]`, `recommendedActions[]`, `tags[]`, `timeline[]` (newest-first),
`enrichedAt`, `enrichedBy`.

Case-level fields and per-comment analyses **survive every re-capture of a cached case**, full or
incremental — enrichment is model-produced and unrecoverable, so the finalizer carries it forward
rather than letting a fresh pull replace the file wholesale.

Per comment, keyed by comment id and **incremental** (existing ids are preserved):
`commentAnalyses[<id>] = { summary, role, keyPoints[], citations[], answered }` where `role` ∈
`Symptom | Question | Hypothesis | Data-Log | Analysis | Request | Resolution | Info`.

The renderer also accepts the legacy flat `commentSummaries[<id>] = string`, so older caches keep
rendering — a deliberate backward-compatibility affordance, not dead code.

### 5.3 Everything else

| File | Written by | Shape / role |
|---|---|---|
| `data/cases/_index.json` | `scrape_case.mjs`, `enrich_local.mjs` | `<CODE> → { syncedAt, commentCount, hash, enrichedAt? }` — the cross-case index the dashboard and incremental logic read |
| `data/watchlist.json` | user / dashboard | `{ intervalMinutes, enrich, pdf, cases[{code, enabled, intervalMinutes?}] }` — the only place that decides how often a case is pulled |
| `data/runs.json` | `scheduler.mjs` | `<CODE> → { lastRunAt, status, reason, newComments, commentCount, elapsedMs }` plus `_sweep` |
| `data/.capture.lock` | `lock.mjs` | `{ pid, at }` — advisory, stale after 30 min or a dead PID |
| `data/chrome-profile/` | Chrome | Persistent `--user-data-dir` — cookies/tokens for the Okta session. This is what makes sign-in one-time; no password is stored anywhere by this project (see §10) |
| `data/cases/<CODE>/case.raw.json` | `run_case.mjs` | Scratch capture; deleted by `scrape_case.mjs` on the success path |

All of `data/` is git-ignored (C3).

---

## 6. Runtime flows

### 6.1 Capture — the fast path

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent / CLI
  participant R as run_case.mjs
  participant L as lock.mjs
  participant B as browser.mjs → Chrome
  participant P as page scripts
  participant F as scrape_case.mjs
  participant V as render_case.mjs

  A->>R: node run_case.mjs <CODE> [--mode] [--enrich] [--no-pdf]
  R->>R: intake() — 8 digits, cache dirs
  R->>L: acquireLock() → else verdict busy (exit 6)
  R->>R: read cache → mode auto: cached ? update : full
  R->>B: ensureChrome() — CDP /json/version, launch if dead, attach ws://
  R->>B: open /s/global-search/<CODE>
  loop ≤ 8 × 2 s
    R->>P: readiness.js → AUTH | READY | EMPTY | BLANK | LOADING
  end
  alt AUTH
    R-->>A: auth-required (exit 3) — human does Okta + email OTP once
  else EMPTY
    R-->>A: not-found (exit 4)
  else READY
    R->>P: find_case_link.js → href + title/status/priority/customer + marks row (data-cq-hit)
    R->>B: click "[data-cq-hit='1']" — trusted click; open(href) lands on Lightning stub /s/case/Case/Default
    R->>P: expand_step.js (PROBE) → articles, displayed, anchorIdx, top
    alt update run and anchor still on top and displayed unchanged
      R-->>A: no-update (exit 0) — STOP, nothing written
    else
      loop ≤ 40 ticks
        R->>P: expand_step.js → click Expand Post / View More / Description
      end
      R->>P: extract_case.js → raw case object
      R->>F: scrape_case.mjs <CODE> raw.json [--merge] --title … --status …
      F->>F: gates (0 comments · captured<displayed · empty title) → INCOMPLETE = blocked
      F->>F: merge · computeHash · write case.json · update _index.json · rm raw
      R->>V: render_case.mjs → report.md · md · html · txt
      R->>B: open file://case.html; pdf case.pdf (size > 0 checked)
      R-->>A: created | updated (+ newComments, newCommentIds, hash, dir)
    end
  end
```

The agent then runs PHASE 3 (analysis) on `created` / all comments, or on `newCommentIds` only for
`updated`, writes `enrichment`, re-renders, and reports.

### 6.2 Why the incremental probe is a *probe*, not a diff

`isNoUpdate(probe, cached)` returns true only when **both** hold: the newest cached comment is
still `articles[0]`, and the portal's own displayed total is unchanged. Anything else — a null
probe, a missing anchor, a changed total — is *not* unchanged. The unit tests pin this ("never lets
a failed probe read as unchanged"), and D11 is the policy behind it.

### 6.3 Scheduled sweep

```mermaid
sequenceDiagram
  participant T as Task Scheduler / cron / --scheduler
  participant S as scheduler.mjs --once
  participant R as run_case.mjs (child)
  participant J as runs.json

  T->>S: sweep
  S->>S: dueCases(watchlist, runs) — per-case interval, enabled only
  loop each due case
    S->>R: spawn (timeout 15 min)
    R-->>S: verdict line
    alt busy
      S->>S: skip — do not stamp lastRunAt, retry next tick
    else
      S->>J: re-read, merge, write verdict
      opt auth-required
        S->>S: STOP the sweep (OTP is human-only) — dashboard shows a sign-in banner
      end
    end
  end
```

Stopping on `auth-required` is deliberate: retrying a lapsed session burns attempts and buries the
one fact the user must act on.

### 6.4 Dashboard

`GET /` (static page) · `GET /api/overview` (projection of every cached case + run state, never the
comment bodies) · `GET /api/case/<CODE>` · `GET /artifact/<CODE>/<whitelisted file>` ·
`POST /api/watchlist` (add/remove/toggle/settings) · `POST /api/run/<CODE>` (detached child, 202
immediately — a 10-minute capture must never block the event loop).

---

## 7. Module and function reference *(generated)*

<!-- BEGIN GENERATED: reference -->

> Generated by `npm run docs` from the source tree — **do not edit by hand**.
> Source fingerprint `aeb31bfe3b1a` over 28 files.
> Stale block ⇒ `npm run docs:check` fails.

#### Pipeline scripts

| File | Lines | Purpose |
|---|---|---|
| `.claude/skills/qualcomm-case-agent/scripts/_paths.mjs` | 63 | single source of truth for skill paths (Node / ESM). |
| `.claude/skills/qualcomm-case-agent/scripts/_paths.ps1` | 67 | single source of truth for skill paths (PowerShell). |
| `.claude/skills/qualcomm-case-agent/scripts/browser.mjs` | 187 | thin Node wrapper around the `agent-browser` CLI. |
| `.claude/skills/qualcomm-case-agent/scripts/check_collapsed.js` | 69 | Pure read: how many non-anchor posts still end in the "Expand Post" label right now. |
| `.claude/skills/qualcomm-case-agent/scripts/connect_chrome.ps1` | 143 | launch REAL system Chrome detached with a CDP port + dedicated persistent profile, ready for 'agent-browser connect <port>'. |
| `.claude/skills/qualcomm-case-agent/scripts/enrich_local.mjs` | 249 | PHASE 3 (enrichment) on a LOCAL model. |
| `.claude/skills/qualcomm-case-agent/scripts/expand_step.js` | 168 | PHASE 1.5 (A and B) as ONE browser-side tick, called in a loop from run_case.mjs. |
| `.claude/skills/qualcomm-case-agent/scripts/extract_case.js` | 119 | Default case extractor for PHASE 2. |
| `.claude/skills/qualcomm-case-agent/scripts/find_case_link.js` | 97 | PHASE 1 "click the search result" — done browser-side instead of by the agent. |
| `.claude/skills/qualcomm-case-agent/scripts/intake.mjs` | 51 | Intake guard: validate case code + prep cache dirs. |
| `.claude/skills/qualcomm-case-agent/scripts/lock.mjs` | 46 | one capture at a time, machine-wide. |
| `.claude/skills/qualcomm-case-agent/scripts/readiness.js` | 62 | PHASE 1 readiness probe. |
| `.claude/skills/qualcomm-case-agent/scripts/recover_chrome.ps1` | 43 | Recovery 0 as ONE script (was a raw PowerShell block pasted into SKILL.md, which errored when the agent ran it through the Bash tool: 'Where-Object' is not recognized ...). |
| `.claude/skills/qualcomm-case-agent/scripts/register_task.ps1` | 48 | put the scheduler on Windows Task Scheduler. |
| `.claude/skills/qualcomm-case-agent/scripts/render_case.mjs` | 382 | deterministic renderer for the Qualcomm Case Management Agent. |
| `.claude/skills/qualcomm-case-agent/scripts/run_case.mjs` | 630 | the whole capture pipeline as ONE deterministic command. |
| `.claude/skills/qualcomm-case-agent/scripts/scheduler.mjs` | 150 | unattended, scheduled capture of the watched cases. |
| `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs` | 439 | Persistence post-processor for the AGENT-DRIVEN extraction. |
| `.claude/skills/qualcomm-case-agent/scripts/verify_case.mjs` | 160 | post-capture QA gate for run_case.mjs's output. |

Exported API — pipeline scripts:

| Module | Export | Kind | Contract |
|---|---|---|---|
| `verify_case.mjs` | `verifyCase(code, dir = join(DATA_DIR, code))` | function |  |

#### Dashboard

| File | Lines | Purpose |
|---|---|---|
| `web/server.mjs` | 207 | local dashboard for the Qualcomm case cache. |

#### Tests

| File | Lines | Purpose |
|---|---|---|
| `tests/intake.test.mjs` | 121 | QA coverage for intake.mjs — the skill's INPUT CONTRACT gate. |
| `tests/pipeline.test.mjs` | 258 | Unit tests for the headless pipeline's pure logic + a dashboard smoke test. |
| `tests/render_case.test.mjs` | 201 | QA coverage for render_case.mjs — previously untested. |
| `tests/run_case.test.mjs` | 257 | Tests for run_case.mjs's browser-driving state machine (landOnCase / findCaseLink) — the part of the pipeline that decides whether we actually landed on the real case page or a Lightning stub. |
| `tests/scrape_case.test.mjs` | 396 | Tests for the finalizer — the module that decides what gets persisted. |
| `tests/verify_case.test.mjs` | 75 | Tests for the post-capture QA gate. |

#### Doc tooling

| File | Lines | Purpose |
|---|---|---|
| `tools/gen_design.mjs` | 217 | regenerate the machine-derived part of docs/DESIGN.md. |

#### Verdict contract — `run_case.mjs` stdout `status` → process exit

| status | exit |
|---|---|
| `created` | 0 |
| `updated` | 0 |
| `no-update` | 0 |
| `auth-required` | 3 |
| `not-found` | 4 |
| `blocked` | 5 |
| `busy` | 6 |
| `error` | 1 |

#### Finalizer exit codes — `scrape_case.mjs`

| name | exit |
|---|---|
| `OK` | 0 |
| `BAD_ARGS` | 2 |
| `INCOMPLETE` | 5 |

#### Entry points — `package.json` scripts

| Command | Runs |
|---|---|
| `npm run test` | `node --experimental-test-module-mocks --test tests/pipeline.test.mjs tests/scrape_case.test.mjs tests/run_case.test.mjs` |
| `npm run case` | `node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs` |
| `npm run sync` | `node .claude/skills/qualcomm-case-agent/scripts/scheduler.mjs --once` |
| `npm run watch` | `node .claude/skills/qualcomm-case-agent/scripts/scheduler.mjs` |
| `npm run web` | `node web/server.mjs --scheduler` |
| `npm run llm:check` | `node .claude/skills/qualcomm-case-agent/scripts/enrich_local.mjs --check` |
| `npm run docs` | `node tools/gen_design.mjs` |
| `npm run docs:check` | `node tools/gen_design.mjs --check` |
| `npm run docs:hook` | `git config core.hooksPath tools/hooks` |

<!-- END GENERATED: reference -->

---

## 8. Invariants

These are the properties a reviewer should check any change against. Most were paid for with a bug.

| # | Invariant | Enforced by |
|---|---|---|
| V1 | A failed probe is never reported as "unchanged" | `isNoUpdate` guards; `run_case.mjs` status mapping; unit test |
| V2 | A short or empty capture never overwrites a good cached case | `scrape_case.mjs` gates: 0 comments, `countAssert`, title gate |
| V3 | Analysis never mutates raw fields or `hash` | `computeHash` covers verbatim fields only; enrichment writers touch `enrichment` alone |
| V4 | Comment bodies are verbatim and never truncated | Extractor takes `.feedBodyInner`; merge keeps cached bodies; renderer only formats |
| V5 | One capture at a time, machine-wide | `lock.mjs` + `busy` verdict + scheduler's no-stamp-on-busy |
| V6 | Nothing confidential leaves the desktop | `.gitignore` on `data/`; loopback bind; local LLM endpoint by default |
| V7 | No JS payload crosses a shell | `browser.mjs` argv-array spawn + `eval -b` + metachar rejection |
| V8 | Paths never depend on CWD | `_paths.mjs` / `_paths.ps1` walk-up |
| V9 | stdout of `run_case.mjs` is exactly one JSON line; everything else is stderr | Single `process.stdout.write` at the end |
| V10 | Comment identity is content-derived, so an analysis never re-attaches to a different comment | `commentId` / `assignIds` in the finalizer; `migrateIds` for legacy caches; unit tests |
| V11 | A capture never destroys enrichment — no path replaces a cached case's analysis with a fresh raw pull | `finalize()` carries `cached.enrichment` forward on both paths; child-process regression test |

---

## 9. Failure modes

| Symptom | Verdict | Root cause | Designed response |
|---|---|---|---|
| Okta session lapsed | `auth-required` (3) | C2 — OTP is human-only | Stop, tell the human, resume after one sign-in. Never retry-loop |
| Search returns nothing | `not-found` (4) | Wrong code, or the account cannot see it | Stop — it is not a transient error |
| SPA never hydrates / no feed articles | `blocked` (5) | Portal slow, DOM drift, wrong page | One same-URL retry, then hand off to `references/manual-flow.md` with `reason` |
| Captured < displayed, or empty title | `blocked` (5) | Expansion ran short; header not backfilled | Nothing is persisted (V2) |
| Another capture running | `busy` (6) | Concurrent sweep/dashboard/interactive run | Retry later; stale lock auto-releases after 30 min |
| Chrome not on CDP 9222 | `blocked` via `BrowserError` | Chrome closed or the bundled-Chromium trap (D1) | `ensureChrome()` launches it; `recover_chrome.ps1` for the daemon-wedged case |
| Local LLM returns non-JSON | not a verdict — `failed` counter | Small-model drift | Comment left unanalyzed; never a fabricated analysis (D14) |
| New nested reply under an old post | `no-update` ⚠ | The probe watches the top post (D8) | Documented; `--mode full` is the definitive check, and it preserves the analysis (D19) |

---

## 10. Security and confidentiality model

- **Password**: never captured, stored, or automated by this project. On an `auth-required`
  verdict the user types the password and email OTP directly into the visible, real Chrome window
  (`references/login-flow.md`) — no DPAPI, no credential file. This retired the earlier
  `capture_password.ps1` / `okta_login.ps1` DPAPI flow (`b64de47`).
- **OTP**: never stored, never automated (C2).
- **Session**: lives in `data/chrome-profile/` (Chrome `--user-data-dir`), git-ignored, user-bound.
  A valid profile reloads the portal with no password and no OTP — that is the entire "don't ask
  again" mechanism.
- **Case content**: NDA. `data/` is git-ignored in full; the dashboard is loopback-only with
  `Host`/`Origin` verification and a fixed artifact whitelist; `enrich_local.mjs` defaults to a
  loopback endpoint and `docs/LOCAL_LLM.md` states plainly that repointing it ships comment bodies
  wherever it is aimed.
- **Blast radius of the browser automation**: `connect_chrome.ps1` uses its *own* `--user-data-dir`
  and never kills the user's personal Chrome; `recover_chrome.ps1` is path-filtered to
  agent-browser's own throwaway browser.
- **ToS**: only cases the signed-in account is authorized to view; read-only.

---

## 11. Known gaps and improvement backlog

Ordered by risk. Each item names the mechanism, not just the symptom.

### Resolved

**I1. `--mode full` on an already-cached case silently destroyed `enrichment`. — FIXED (D19).**
`run_case.mjs` sets `merge = mode === 'update' && !!cached`, so a forced full run called
`scrape_case.mjs` without `--merge`; `finalize()` then persisted `out = raw`, and the raw capture has
no `enrichment` key. Every per-comment analysis and the case-level synthesis were lost, while
`_index.json` kept a stale `enrichedAt`. It was reachable through a *documented* instruction —
`SKILL.md` recommends `--mode full` as the definitive check when the fast probe may have missed a
nested reply (§9). `finalize()` now reads the cache on **both** paths and carries `cached.enrichment`
forward; `--merge` decides how comments are merged, never whether the analysis survives. The index
keeps `enrichedAt`, and the verdict reports the genuinely new ids on a full re-capture too, so a
re-pull costs one analysis per new comment rather than a whole thread. Regression-tested through a
real child-process run in `tests/scrape_case.test.mjs`.

**I2. Comment ids were positional, so identity was not stable across a full re-capture. — FIXED (D19).**
`extract_case.js` uses `a.id || ("c" + (i + 1))`, so without a DOM id a comment's identity was its
position: a full re-capture of a thread that gained a post re-keyed every comment, and
`enrichment.commentAnalyses` (keyed by id) would attach each analysis to the wrong comment — which
is what made I1's fix unsafe on its own. Ids are now content-derived (`commentId` = sha256 of
`commentKey`), assigned in the finalizer for every persisted comment, so they no longer depend on
the extractor or on position. Legacy caches are re-keyed on read by `migrateIds`, which moves
`commentAnalyses`, `commentSummaries` and `caseFlow[].refComments` with them. `computeHash` no
longer includes the id (it is derived from content already in the hash), so a cache written before
this change re-hashes once — one no-op `updated` verdict, no data change.

**I4. `scrape_case.mjs` was the least-tested module and the most consequential. — FIXED.**
`tests/scrape_case.test.mjs` now covers the pure helpers (hash stability under re-enrichment and
across id schemes, the completeness gates, header-flag parsing, identity, id assignment, legacy
migration, the merge matrix) plus `finalize()` itself, spawned against a throwaway cache root — the
only honest way to test a function that ends in `process.exit`, and the only way to catch I1, which
shows up in the file it writes rather than in a return value. The suite asserts the negative cases
too: a short, empty or untitled capture must leave the cached case byte-identical.

### P0 — data-integrity

**I3. `commentKey` dedupe is a heuristic with two known collisions.**
Identity is `author + first 120 chars of normalized body`. An edit inside those 120 characters makes
an old comment look new (duplicate); two genuinely distinct short comments by the same author share
an identity. Timestamps are excluded on purpose — Chatter renders relative times that drift.
Partially addressed by D19: a duplicate identity inside one capture is now kept as a distinct
comment (`-N` suffix) and counted as `idCollisions` in the verdict instead of being collapsed. Still
open: an *edit* to an old comment's opening 120 characters still reads as a new comment on the next
merge. Fix: prefer a stable Chatter DOM id if one proves stable across loads, and treat a
near-duplicate (same author, high body similarity) as an edit rather than an insertion.

### P1 — assurance and completeness

**I5. `analysisLog`, `attachments`, `company` and `role` are promised but never populated.**
`extract_case.js` hard-codes them empty; the renderer, the enrichment prompts and `SKILL.md` all
describe them as captured content. The result is a documented capability that silently yields
nothing — the worst kind of gap, because downstream readers cannot tell "no attachments" from "not
extracted". Fix: either implement extraction (feed-item attachment anchors, author company from the
Chatter profile card) or state the limitation in `SKILL.md` and the rendered artifacts.

**I6. State files are read-modify-write with no atomicity.**
`runs.json`, `_index.json` and `case.json` are rewritten in place from three possible writers
(sweep, dashboard-spawned run, interactive run). The scheduler mitigates by re-reading immediately
before writing, but the window is real, and a crash mid-write truncates the file. Fix: write to a
temp file and `rename()` (atomic on both platforms); keep the re-read.

**I7. No CI.** `npm test` runs only when someone remembers. A GitHub Actions workflow now runs the
tests and the doc freshness check (§12) — extend it with lint and coverage. Note that `npm test`
lists its test files explicitly: a new `tests/*.test.mjs` must be added there to run at all (Node's
`--test` glob support is newer than this project's `engines` floor).

### P2 — robustness and operability

- **I8. The fast no-update probe ignores header-only changes.** A case that goes Open → Closed with
  no new comment returns `no-update` from the early probe, before `scrape_case.mjs` (which *does*
  compute `headerChanged`) ever runs. Fix: compare the search-row header fields against the cache in
  `run_case.mjs` before taking the early exit.
- **I9. `readiness.js` detects auth by hostname only.** An interstitial served under
  `support.qualcomm.com` reads as `LOADING` and ends as `blocked` after 16 s instead of the correct
  `auth-required`. Fix: also treat a visible Okta username/password form as `AUTH`.
- **I10. Expansion exhaustion is invisible.** Hitting `EXPAND_ROUNDS = 40` looks the same as a
  finished expansion; only the downstream `countAssert` catches it, and the reason it reports is
  "captured < displayed". Fix: surface `expandExhausted` in the verdict.
- **I11. The capture lock has a documented exists→write race** and can be made atomic for free with
  `writeFileSync(path, …, { flag: 'wx' })`.
- **I12. Windows metachar rejection can block a legitimate machine** — a project path containing
  `&` or `%` (e.g. `C:\R&D\…`) fails `winLine()` outright. Fix: keep the guard, but quote-escape
  paths instead of refusing, or resolve to a short path.
- **I13. No per-run log.** Unattended failures leave a 300-char truncated `reason` in `runs.json`.
  Fix: append full stderr to `data/logs/<code>-<ts>.log`, rotated by count.
- **I14. Chrome launch is Windows-only.** `browser.mjs` can attach to Chrome on POSIX, but
  `connect_chrome.ps1` (the persistent-profile launcher) is PowerShell-only, so a Linux/macOS run
  needs Chrome started by hand with the same `--user-data-dir` first. (Auth itself is no longer
  platform-coupled — login is manual in the visible window (`references/login-flow.md`), no DPAPI.)
  Fix: document as a hard requirement, or add a POSIX launcher.
- **I15. Renderer duplication.** Four formats each re-walk the same shape in `render_case.mjs`; a
  new enrichment field must be added in four places. Fix: a single section model that each format
  serializes — only worth doing when the next field is added.
- **I16. `computeHash` covers relative timestamps, which drift.** Chatter renders "2 days ago", so a
  full re-capture can produce a different hash for an unchanged case and report `updated` with zero
  new comments. Merge runs are unaffected (cached timestamps are never rewritten). Fix: exclude
  `timestamp` from the hash — identity is already carried by author + body — or normalize the
  relative form to an absolute date at extraction time, which would be worth more on its own.

### Not-a-bug (deliberate, documented)

Positional retry with a single re-open (not a backoff storm), stopping the sweep on
`auth-required`, refusing to persist a partial capture, and leaving a comment unanalyzed on a
malformed local-model response are all intentional (D10, D11, D14).

---

## 12. How this document stays true

The failure mode of a design doc is drift. Half of this one is therefore not written by hand.

```mermaid
graph LR
  E[edit code] --> C[git commit]
  C --> H[".githooks/pre-commit"]
  H --> G["node tools/gen_design.mjs"]
  G -->|block changed| S["git add docs/DESIGN.md"]
  S --> C2[commit includes the doc]
  C2 --> CI["CI: npm test + npm run docs:check"]
```

**Install the hook once per clone:**

```bash
npm run docs:hook      # git config core.hooksPath tools/hooks
```

**Commands:**

| Command | Does |
|---|---|
| `npm run docs` | Regenerate §7 from the source tree, in place |
| `npm run docs:check` | Exit 1 if §7 is stale — used by the hook's safety net and by CI |
| `npm run docs:hook` | Point `core.hooksPath` at `tools/hooks` (one-time, per clone) |

**The contract, so contributors know what to edit:**

- **Generated (never edit by hand):** §7 — module inventory, exported API with signatures and the
  first sentence of each doc comment, the verdict/exit tables (imported from `STATUS_EXIT` and
  `EXIT`, not transcribed), and the npm script list. Adding a script or renaming an export updates
  this section automatically on the next commit.
- **Hand-written (a generator cannot infer it):** §1–6 and §8–12 — constraints, decisions and the
  alternatives they beat, invariants, failure semantics, the security model, the backlog. **Changing
  behaviour means changing these too.** Specifically: a new verdict status ⇒ §6 and §9; a new state
  file ⇒ §5; a new external dependency or trust-boundary change ⇒ §2 and §10; anything that
  overturns a decision in §4 ⇒ update that row rather than deleting it, so the history of *why*
  survives.
- The generated block carries a **source fingerprint** (sha256 over every scanned file). If the
  fingerprint in the doc does not match the tree, the doc is stale by construction — that is exactly
  what `docs:check` tests.

### Related documents

| Doc | Covers |
|---|---|
| `README.md` | Orientation, setup, layout |
| `.claude/skills/qualcomm-case-agent/SKILL.md` | The operational runbook (the agent contract) |
| `.claude/skills/qualcomm-enrich/SKILL.md` | The standalone analyst pass |
| `docs/AUTOMATION.md` | Fast path, scheduling, dashboard — operator view |
| `docs/LOCAL_LLM.md` | Local-model sizing, prompt budgets, what it must not be trusted with |
| `references/manual-flow.md` | Hand-driving a capture when a run reports `blocked` |
