// portal_driver.mjs — the seam between run_case.mjs (orchestration: verdicts,
// retries, screenshots-per-failure-mode) and however a case actually gets
// read off the portal.
//
// Two implementations:
//   - CdpPortalDriver     (cdp_portal_driver.mjs)     — live Chrome over CDP.
//   - FixturePortalDriver (fixture_portal_driver.mjs) — offline JSON replay.
//
// run_case.mjs only ever calls these four methods (plus screenshot()) — it
// never imports browser.mjs, evalFileViaCdp, or a CDP client directly. That's
// the whole point of the seam: swap the driver, and the orchestrator's retry
// logic, verdict shapes, and file writes run byte-identical against a fixture
// with no Chrome and no network.
//
// Contract each method must honor (see cdp_portal_driver.mjs for the
// reference implementation run_case.mjs is written against):
//
//   connect()
//     Establish whatever session the driver needs. Idempotent — calling it
//     again with an already-live session is a cheap no-op, not a re-connect.
//
//   isConnected()
//     Synchronous. True iff a subsequent navigateToCase()/expandAndExtract()
//     call can proceed right now.
//
//   navigateToCase(code, opts) -> landing result
//     Same return shape as fast_landing.mjs's fastLandOnCase(): one of
//     { state: 'OK', href, fields, fastPathUsed, durationMs, diagnostics }
//     or a non-OK state (AUTH, NOT_FOUND, STUB, OTP_TIMEOUT, ...).
//
//   expandAndExtract({ anchor, caseUrl, onProbe }) -> descriptor
//     onProbe(probe) is called once the feed is confirmed non-empty; if it
//     returns true, expandAndExtract stops there and returns
//       { ok: true, noUpdate: true, probe }
//     without running the expand loop. Otherwise it fully expands the feed,
//     extracts, and returns
//       { ok: true, noUpdate: false, raw, detailRaw, detailExtracted,
//         detailSwitchError, clicks, rounds, pendingExpand, pendingMoreComments }
//     On failure it returns a neutral descriptor — never a verdict shape —
//     for run_case.mjs to map:
//       { ok: false, stage: 'feed-switch' | 'no-articles' | 'stuck-expand' | 'no-comments',
//         reason, retryable?, evidence?, probe?, rounds? }
//
//   screenshot(path, opts) -> filename | null
//     Best-effort. A driver that cannot produce a real screenshot (the
//     fixture driver) returns null; verify_case.mjs treats a missing
//     screenshot as a warning, never an error.
//
//   close()
//     Release whatever connect() acquired. Must NOT tear down a connection
//     the caller injected (e.g. an already-open CDP client passed to the
//     constructor) — only what the driver itself opened.

export class PortalDriver {
  async connect() {
    throw new Error(`${this.constructor.name}.connect() not implemented`);
  }

  isConnected() {
    throw new Error(`${this.constructor.name}.isConnected() not implemented`);
  }

  async navigateToCase(_code, _opts = {}) {
    throw new Error(`${this.constructor.name}.navigateToCase() not implemented`);
  }

  async expandAndExtract(_opts = {}) {
    throw new Error(`${this.constructor.name}.expandAndExtract() not implemented`);
  }

  async screenshot(_path, _opts = {}) {
    throw new Error(`${this.constructor.name}.screenshot() not implemented`);
  }

  async close() {
    throw new Error(`${this.constructor.name}.close() not implemented`);
  }
}
