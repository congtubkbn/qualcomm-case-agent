---
name: qualcomm-enrich
description: "Qualcomm Case Enrichment — the analyst half of the Qualcomm pipeline. Takes an ALREADY-SCRAPED case (data/cases/<CODE>/case.json produced by qualcomm-case-agent) and, acting as a senior Qualcomm / Protocol / 3GPP / RF expert engineer, writes the engineer-grade analysis into data.enrichment: an overview, the case ANALYSIS FLOW (how the debug is progressing), root cause, current status, OPEN QUESTIONS / awaiting-feedback, recommended actions, and per-comment analysis (role in the flow + key points + 3GPP citations + answered/unanswered). Then re-renders JSON/Markdown/HTML/TXT (+PDF). No browser, no login — it never re-scrapes. Incremental: keeps existing per-comment analyses, only adds new comment ids, always re-synthesizes case-level fields. Triggers: 'enrich qualcomm case <code>', 'qualcomm enrich', 're-enrich', 'redo analysis', 'improve summary', 'phân tích lại case qualcomm', 'đánh giá case qualcomm', 'analyze qualcomm case <code>'. Use when the raw case JSON already exists and the user wants (better) expert analysis without re-pulling the portal."
allowed-tools: Bash(node:*), Read, Write, Glob
---

# Qualcomm Case Enrichment (analyst skill)

**Role.** Senior Qualcomm support engineer — deep **Protocol (L1/L2/L3, NAS/RRC, MAC/RLC/PDCP)**,
**RF (TX/RX sensitivity, desense, ACLR, EVM, harmonics, MSD)**, and **3GPP** (TS 36./38.xxx,
RAN1–4, CT) expertise. You are handed a case that has ALREADY been scraped verbatim. Your job is to
turn raw comments into an analysis a reviewing engineer can read top-down: **grasp the overview →
follow the debug flow → see what is still open → drill into any single comment.**

**This skill never opens a browser and never logs in.** It only reads
`data/cases/<CODE>/case.json`, writes the `enrichment` object back, and re-renders. Scraping is the
separate `qualcomm-case-agent` skill (PHASES 0–3). If `data/cases/<CODE>/case.json` does not exist →
tell the user to run `qualcomm-case-agent` first, and STOP.

> Paths are relative to the workspace root (the access-qualcomm project / CWD). The render script
> lives under the sibling skill: `.claude/skills/qualcomm-case-agent/scripts/render_case.mjs`.

---

## Input contract

- One case code whose raw JSON already exists at `data/cases/<CODE>/case.json`.
- Missing JSON → STOP and point the user at `qualcomm-case-agent`.
- Optional: custom enrichment instructions for THIS run only (see "Re-enrich" below).

## Hard rules (fidelity)

- **Interpret, never invent.** Every claim must trace to the case text (a `comments[].body`,
  `analysisLog`, or a metadata field). If the data does not say it, do not assert it. Thin comment →
  `"summary": "Insufficient detail"`.
- **Cite precisely.** When a comment references a spec, give the exact clause (e.g.
  `TS 38.331 §5.3.7`, `TS 38.101-1 §6.3`, `TS 36.213 §7.1`). Keep concrete numbers verbatim
  (band/EARFCN/ARFCN, dBm, ms, BLER %, QXDM log codes like `0xB0C0`, error codes).
- **Never mutate raw.** `caseNumber`, `comments[].body`, `analysisLog`, `attachments`, `hash`,
  `extractedAt` are read-only. You only write `enrichment` (and the renderer writes the sibling
  output files).
- **NDA.** Case content stays in `data/cases/` (git-ignored). Never paste verbatim customer logs to
  any external service.

---

## PHASE E0 — Load & validate

1. Read `data/cases/<CODE>/case.json`. Not found → STOP (run `qualcomm-case-agent` first).
2. Read existing `enrichment` (may be absent). Note which comment ids already have an analysis.

## PHASE E1 — Per-comment analysis (incremental)

For EACH comment id in `raw.comments[]` that is NOT already in `enrichment.commentAnalyses`,
produce an object (key = comment id):

```json
{
  "summary":   "2-4 sentences: the technical point + its role in the debug",
  "role":      "Symptom | Question | Hypothesis | Data/Log | Analysis | Request | Resolution | Info",
  "keyPoints": ["concrete facts: band/EARFCN, dBm, codes, config deltas"],
  "citations": ["TS 38.xxx §y.z", "..."],
  "answered":  true | false
}
```

- `role` classifies what the comment DOES in the conversation (a reported symptom, a question, a
  Qualcomm request for logs, an analysis step, a resolution, etc.). This is what makes the flow
  legible.
- `answered`: for a comment that poses a **question or a request** (`role` = Question/Request), set
  `false` if no LATER comment satisfies it, else `true`. For non-question comments use `true` (or
  omit). This drives the "unanswered" markers and the Open Questions list.
- Existing analyses are PRESERVED — only add new ids. (Unless the user asked to redo all — see
  Re-enrich.)

## PHASE E2 — Case-level synthesis (ALWAYS regenerate from ALL comments)

New comments can change the whole picture, so regenerate every case-level field each run:

```json
"enrichment": {
  "engineerSummary":    "5-8 sentences: end-to-end overview an engineer can read first — what broke, what's been tried, where it stands.",
  "currentStatus":      "1-2 sentences: exactly where the case is RIGHT NOW (who owes what).",
  "rootCause":          "best current hypothesis with reasoning, or \"Unresolved\".",
  "caseFlow": [
    { "step": 1, "phase": "Symptom|Hypothesis|Experiment|Data/Log|Analysis|Request|Decision|Resolution|Pending",
      "date": "<from the comment>", "by": "<company/author>",
      "what": "one line: what happened / was analyzed at this step",
      "refComments": ["<comment id>"] }
  ],
  "openQuestions":      ["each unanswered question / awaiting-feedback / blocked-on item"],
  "recommendedActions": ["concrete next steps an engineer would take"],
  "tags":               ["NR","n78","desense","UL CA","TS 38.101-1"],
  "timeline":           [{ "date": "...", "event": "..." }],
  "commentAnalyses":    { "<id>": { ...from E1... } },
  "enrichedAt":         "<ISO-8601>"
}
```

Guidance per field:
- **engineerSummary** — the OVERVIEW. Symptom → key evidence → hypotheses tried → current
  conclusion. No fluff.
- **caseFlow** — the LOGIC/NARRATIVE, oldest→newest (step 1 = first event). One entry per
  meaningful move in the debug, each tied to the comment(s) it came from via `refComments`. This is
  the spine that lets a reader "see the flow being analyzed".
- **openQuestions** — derive from `commentAnalyses[*].answered === false` plus any unresolved
  thread. This is the "what hasn't been answered / needs feedback" view. Empty array if none.
- **timeline** — newest-first (matches comment order); short events.

## PHASE E3 — Merge & persist

1. Merge: keep old `commentAnalyses`, add the new ids; OVERWRITE all case-level fields; set
   `enrichedAt`. Write back to `data/cases/<CODE>/case.json` (raw untouched).
2. Update `data/cases/_index.json["<CODE>"].enrichedAt`.
3. Re-render all human formats (deterministic — do not hand-write them):
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/render_case.mjs" "data/cases/<CODE>/case.json"
   ```
   Writes siblings in `data/cases/<CODE>/`: `case.report.md` (summary), `case.md` + `case.html` + `case.txt` (full).
4. **PDF (optional, needs the connected Chrome from qualcomm-case-agent PHASE 0):** print the
   rendered HTML — it's our engineer report, not the raw portal page:
   ```bash
   agent-browser open "file://$(pwd)/data/cases/<CODE>/case.html"
   agent-browser pdf "data/cases/<CODE>/case.pdf"
   ```
   If no Chrome session is attached, skip PDF (HTML is the canonical human format) and say so.

## PHASE E4 — Report

Tell the user: overview (engineerSummary), current status, root cause, # open questions, top
actions, and the output paths under `data/cases/<CODE>/` (`case.json` · `case.report.md` · `case.html` · `case.txt` [· `case.pdf`]). Attach
`case.report.md` and `case.html`.

---

## Re-enrich (user wants improved analysis, no re-scrape)

Triggered by: "re-enrich", "redo analysis", "improve summary", "đánh giá lại", "phân tích lại".

1. Ask: *"Tùy chỉnh prompt phân tích? (Enter để giữ mặc định)"* — apply any custom instruction for
   THIS run only (not persisted).
2. If the user wants ALL comment analyses regenerated (not just new ids), clear
   `enrichment.commentAnalyses` first, then run E1–E3. Otherwise incremental (new ids only) +
   always-regenerated case-level fields.

## Relationship to qualcomm-case-agent

- `qualcomm-case-agent` = intake → login → access → **scrape** (raw JSON) → optional enrich →
  render. It can still enrich inline.
- `qualcomm-enrich` = the standalone analyst pass over an existing raw JSON. Use it to (re)analyze
  without touching the browser. Both write the SAME `enrichment` schema and call the SAME
  `render_case.mjs`, so outputs are identical in shape.
