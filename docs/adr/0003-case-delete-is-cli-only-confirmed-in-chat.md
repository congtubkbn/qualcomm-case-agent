# 0003. Case deletion is CLI-only, confirmed in chat — dashboard never deletes directly

Date: 2026-08-23
Status: Accepted

`qualcomm-case-overview`'s `dashboard.html` is a self-contained static file with zero server or
CDN dependency (see its SKILL.md). Deleting a case's local cache directory therefore cannot be
wired to a real button click in the dashboard without adding a background HTTP server the browser
could call — a standing process contradicting the "offline, zero-dependency" design this dashboard
was built around.

Deletion instead lives as a new script owned by `qualcomm-case-agent` (the data owner; `case.json`
is an "individual case file" the read-only `qualcomm-case-overview` explicitly may not touch). The
dashboard's "Delete" affordance copies a natural-language instruction (e.g. "xóa case 08603854
khỏi cache local") to the clipboard for the user to paste into the Claude Code chat, rather than
copying the literal CLI invocation. This is deliberate: it forces every delete through the agent,
which asks for confirmation before running the script with `--yes`. A copied CLI command
containing `--yes` could be pasted straight into a terminal and skip confirmation entirely.

## Considered Options

- **A local server so the dashboard button deletes directly.** Rejected: requires a
  permanently-running process, contradicting the dashboard's stated "zero server" design and this
  repo's broader "capture is code, no model/server loop" architecture.
- **Copy the full CLI command (including `--yes`) to clipboard.** Rejected: pasted into a bare
  terminal instead of chat, it deletes with no confirmation step at all — defeats the reason this
  feature was asked for.

## Consequences

- The dashboard's "Delete" button is a convenience shortcut, not a real delete action — a future
  reader must not "fix" it into a direct-delete button without reintroducing the skipped-confirmation
  risk above.
- Every real deletion is agent-mediated: `qualcomm-case-agent` owns the new delete script;
  `qualcomm-case-overview` only reacts afterward via its existing `updateCaseOverview(code)` sync
  (unchanged — already handles a vanished case directory correctly).
