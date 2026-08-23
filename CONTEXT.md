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

**Hide (case)**:
A per-browser, client-side-only flag on the `qualcomm-case-overview` dashboard that removes a case
from active tab views. Stored in `localStorage`; touches no file on disk; fully reversible via
"Unhide". Does not affect `_overview.json`, `_index.json`, or the case's cache directory.
_Avoid_: delete, archive, remove

**Delete (case)**:
Permanently removes a case's entire local cache directory (`data/cases/<code>/` —
`case.json`, `summary.json`, comments) and its `_index.json` entry. Irreversible. Owned by
`qualcomm-case-agent` (the data owner), never by `qualcomm-case-overview` (read-only consumer).
Always gated by an agent-mediated confirmation in chat before the underlying script runs.
_Avoid_: hide, remove (ambiguous with hiding)
