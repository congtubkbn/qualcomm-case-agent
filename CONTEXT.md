# access-qualcomm

Local tool that captures Qualcomm Support cases into a local cache (`qualcomm-case-agent`), and —
as a separate downstream skill — reports their status and summarizes their comments for an
engineer reviewing a case (`qualcomm-case-summary`).

## Language

**Case**:
One Qualcomm Support ticket, identified by an 8-digit case code. Captured verbatim into
`case.json`/`case.md`.
_Avoid_: ticket (reserved for this repo's own GitHub issues), record

**Case Status**:
The case's own status field from the Qualcomm Salesforce portal (e.g. "Closed-Customer Requested",
"Pending Qualcomm"), read verbatim from `case.json.status`. Never inferred or reclassified.
_Avoid_: state (ambiguous with a capture-pipeline verdict)

**Capture**:
The deterministic, model-free pipeline (`qualcomm-case-agent`) that signs in, finds a case, and
writes it verbatim to `case.json`/`case.md`. Comments are always stored Oldest → Newest — this
order is load-bearing for the pipeline's own merge/dedup logic, not just display.
_Avoid_: sync, scrape

**Comment Summary**:
A short, technical, per-comment digest (issue / status / next-action, applied as it fits the
comment) produced by `qualcomm-case-summary`. Distinct from the comment's own verbatim body.
_Avoid_: enrichment (the removed model-analysis concept from ADR 0001 — do not reuse this word)

**Case Flow**:
A case-level narrative of how a case progressed (who reported what, who responded, how it resolved
or where it's stuck), maintained by `qualcomm-case-summary` and updated incrementally as new
comments arrive.
_Avoid_: enrichment.caseFlow (the deleted field from ADR 0001 — this is a new, separately-owned
concept, not its revival)

**Delta (comments)**:
The set of a case's comments not yet present in a prior `qualcomm-case-summary` run, computed by
comment-id difference, never by array position or count. Drives summarizing only what's new.
