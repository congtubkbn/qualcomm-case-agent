# qcomm skill audit — 2026-09-18

Working log from a re-review of `.claude/skills/qcomm/`: static read of each
area, findings discussed and decided live, fixes applied immediately when the
decision was "remove/fix now". Not an ADR — nothing here is an
architecture-level decision; see `docs/adr/` for those.

Order: risk-ranked (most logic-dense areas first), not file-tree order.

## Finalize chain — reviewed

Files: `finalize_case.mjs` (orchestrator) + `finalize_completeness.mjs`,
`finalize_description.mjs`, `finalize_header.mjs`, `finalize_identity.mjs`,
`finalize_merge.mjs`, `finalize_normalize.mjs`, `comment_tree.mjs`.

Flow: parse raw JSON → validate ≥1 comment → load+migrate cached `case.json`
→ synthesize description-as-first-comment if the feed doesn't already carry
it → normalize timestamps + assign content-derived comment ids → union fresh
into cached comments via `mergeComments` (never shrinks, never overwrites a
cached body) → hard gates (collapsed "Expand Post" control, comment-count vs
portal badge, empty title) → scrub `role`/`company`/`displayPosition` →
build nested `subs:[]` tree → hash + write `case.json` + `_index.json` →
sync overview.

### Findings & decisions

| # | Finding | Decision | Status |
|---|---|---|---|
| 1 | `finalize_case.mjs`: duplicated comment line ("Inject description as initial comment...") pasted twice back to back | Remove duplicate | ✅ done |
| 2 | `finalize_normalize.mjs` `classifyRole`: hardcoded fallback allowlist of 5 Qualcomm employee names (`aiden an`, `seunghoon lee`, `hoon lee`, `cs lee`, `kyungnam ken lee`) — fragile, silently misclassifies any QC employee not on the list and not otherwise identifiable by domain/greeting pattern | Remove the allowlist branch entirely; falls through to existing domain/greeting/default heuristics | ✅ done — also dropped the test pinning this behavior (`tests/qcomm_finalize_normalize.test.mjs`) |
| 3 | `finalize_normalize.mjs` `isRelativeTimestamp` exported but never imported by any production script (`run_case.mjs`, `render_case.mjs`, `finalize_*`, etc.) — only exercised by its own test | Verified via grep across the repo (only hit: its own definition, `docs/DESIGN.md`'s auto-generated table, and one test file) — dead export, removed | ✅ done — removed function + the test case that only covered it (`tests/qcomm_chronological_sort.test.mjs`, describe block renamed since it no longer covers `isRelativeTimestamp`) |

Verification: `npm test` → 557/557 pass. `npm run docs` regenerated
`docs/DESIGN.md` (auto-generated table lost the `isRelativeTimestamp` row);
`npm run docs:check` clean afterward.

### Other things noticed, not acted on (no decision needed yet)

- `finalize_case.mjs`'s merge-branch (`--merge`) backfills `HEADER_KEYS` from
  `raw` (lines ~163-165) in addition to the CLI-flag backfill loop further
  down (~219-223) that runs for both merge and full-capture. Two different
  sources (DOM-extracted vs agent-supplied flag) filling the same keys —
  looked like possible overlap but traced through: the extractor normally
  leaves `title` blank on the Feed view (comment at line ~226), so the raw-DOM
  backfill is realistically a no-op most runs, not dead code. Not flagged as
  a bug; noting here in case it resurfaces during the core-capture pass.
- `render_case.mjs` falls back to `classifyRole()` whenever a cached comment
  has no `.role` field — since `finalize_case.mjs` always scrubs `role` on
  write, this fallback runs on *every* render, every comment. Confirmed
  intentional (comment: "Comments must never carry role/company — scrub them
  here"), the `c?.role ||` branch exists only for pre-scrub legacy cache
  files. Not a bug.

## Core capture — reviewed

`run_case.mjs`, `portal_driver.mjs` (+ `cdp_portal_driver.mjs` /
`fixture_portal_driver.mjs`), `dom_extractor.js`.

### Findings & decisions

| # | Finding | Decision | Status |
|---|---|---|---|
| 4 | `run_case.mjs`/`finalize_case.mjs`/`verify_case.mjs`: `finalize()` writes `case.json` to disk *before* `verifyCase()` runs. `verifyCase` checks `raw.capture.pendingExpand`/`pendingMoreComments` (DOM-level "still hiding content" counters) which `finalize()`'s own `findCollapsed` gate does NOT check (that gate only scans new comments' *body text* for a trailing "Expand Post" label — a different signal). So a capture can fail `verifyCase` (→ `status: blocked`) *after* `case.json` on disk has already been overwritten with the incomplete result. Traced through: not permanent data loss — `pendingExpand`/`pendingMoreComments` are re-checked by `isNoUpdate()`'s probe on every future run, so a still-incomplete cache can never falsely short-circuit as "no-update"; combined with `blocked`'s `retryable: true`, the pipeline self-heals on the next retry. Still a real gap: `finalize_case.mjs` *could* hard-gate on `raw.capture.pendingExpand`/`pendingMoreComments` before writing, the same way it already gates on `findCollapsed`, and avoid ever persisting a known-incomplete capture. | **Pending** — asked whether to add the extra gate now or leave as-is (retry already covers it, don't touch a stable module without a concrete failure driving it) | ⏳ undecided |

`portal_driver.mjs` reviewed: abstract seam class only (throws
"not implemented" per method), fully documented contract, no findings — clean
deep-module interface between `run_case.mjs` and the two concrete drivers.

`dom_extractor.js` (1028 lines, in-browser code run via CDP eval) — targeted
read of `expandStep` and `extractCase` (the two functions core-capture
depends on), not the full file (selector-heavy, most of the rest is
`references/dom-selectors.md`'s territory, only worth a full read when a
selector actually drifts).

- Confirms finding #4's mechanism: `expandStep`'s `pendingExpand`/
  `pendingMoreComments` come from counting DOM controls (`.cuf-more`, "N more
  comments" links) still visible — genuinely independent of what
  `extractCase` puts in a comment's `body` text. No new bug here, just
  evidence for #4.
- Minor edge case, no evidence it's ever fired: `extractCase` assigns a
  reply's `parentIndex = lastTopLevelIndex`. If a reply article appeared in
  DOM order before any top-level post (`lastTopLevelIndex` still `null`),
  it silently becomes a top-level comment instead of erroring. Not raised as
  a bug — noting in case a future capture shows an orphaned reply at the top
  level.

## Auth/OTP — reviewed

Turned out not to be a separate module the way the original risk-order
assumed: the actual auth/OTP state machine lives inside `fast_landing.mjs`
(`handleAuth`, OTP poll loop) plus `dom_extractor.js`'s `loginFill` (in-page
password fill / Okta state classification) and `secret_store.mjs` (DPAPI
read/clear). Reviewed all three.

- `fast_landing.mjs`: `fastLandOnCase` handles direct-nav fast path, global
  search fallback, and inline auth-retry (`probeAndHandleAuth` wraps any
  navigation action, transparently runs the auth cycle once if it lands on
  AUTH, then retries the original action). `authFillAttempted` is a
  one-shot-per-call flag — a second AUTH encounter in the same
  `fastLandOnCase()` call always short-circuits to a manual-AUTH verdict
  rather than attempting fill twice. No bug found; traced the "AUTH found
  after a successful auth retry" branch (line ~275) that looked at first
  glance like it could silently fall through to search without returning —
  it can't, `authFillAttempted` guarantees the second `handleAuth()` call in
  that scenario always returns a non-`handled` result, so it always returns.
- `dom_extractor.js` `loginFill`: in-page state classifier
  (`classifyCurrentState`) with a fill/submit polling loop. `isHostAuthenticated()`
  is a fragile heuristic (host isn't `account.qualcomm.com` AND path doesn't
  match `/login|auth|okta/i` → assumed authenticated) — matches the pattern
  in recent commit history (131ad23 added the "Finish Logging In" interstitial
  special-case specifically because this heuristic false-positived on it).
  Not flagged as a new bug — it's a known-shape heuristic that gets patched
  reactively as new false-positive states are discovered live; nothing here
  suggests a *currently* broken case, just noting the pattern for whoever
  hits the next one.
- `secret_store.mjs`: DPAPI read via `powershell -Command` with the secret
  path interpolated into a single-quoted string — correctly escapes embedded
  single quotes (`replace(/'/g, "''")`). Path is internally config-derived
  (`_paths.mjs`'s `SECRET_PATH`), not attacker-controlled, so injection risk
  is low regardless, but the escaping is correct. No findings.

## Overview/dashboard — not started

`cases_overview.mjs`, `overview_store.mjs`, `overview_lock.mjs`,
`dashboard_renderer.mjs`, `cli_renderer.mjs`, `staleness.mjs`.

## Delete/lock/protocol — not started

`delete_case.mjs`, `lock.mjs`, `ensure_protocol.mjs`, `open_qc_case.mjs`,
`register_protocol.ps1` / `unregister_protocol.ps1`, `recover_chrome.ps1`,
`connect_chrome.ps1`.

## Session stopped here — 2026-09-18

User called it here after finalize chain + core capture + auth/OTP.
Open items for next session:

- **Decide finding #4** (finalize writes before verify's `pendingExpand`/
  `pendingMoreComments` check) — add a hard gate in `finalize_case.mjs`, or
  leave as-is on the strength of the retry/self-heal argument above.
- Overview/dashboard and delete/lock/protocol areas not reviewed at all yet.
