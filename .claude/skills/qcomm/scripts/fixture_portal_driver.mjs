// fixture_portal_driver.mjs — offline PortalDriver: replays pre-recorded
// snapshots instead of driving Chrome. No CDP, no network, no browser
// process — this is what lets `node run_case.mjs <CODE>` run in CI (#241).
//
// Fixture layout, one directory per case code:
//   <fixtureDir>/<CODE>/landing.json   optional — navigateToCase() result
//                                       (defaults to a synthetic ON_CASE landing
//                                       if absent, so a fixture author only has
//                                       to supply the part they care about)
//   <fixtureDir>/<CODE>/probe.json     optional — the feed probe passed to
//                                       expandAndExtract's onProbe callback,
//                                       for exercising the no-update fast path
//   <fixtureDir>/<CODE>/raw.json       required for a successful capture —
//                                       the case.raw.json-shaped extraction
//                                       result (comments/, fields, url, ...)
//   <fixtureDir>/<CODE>/page.html      optional — the captured DOM at
//                                       extraction time, kept for human
//                                       provenance/debugging only. Nothing in
//                                       expandAndExtract() reads or replays it
//                                       — this codebase has no DOM/JS-engine
//                                       dependency, so real in-page script
//                                       replay against HTML is out of scope.
//                                       raw.json is the load-bearing artifact.
//
// A case directory with no raw.json produces an expandAndExtract() 'no-articles'
// failure, the same shape a live driver returns when the feed never loads.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PortalDriver } from './portal_driver.mjs';
import { PROJECT_ROOT } from './_paths.mjs';

export const DEFAULT_FIXTURE_DIR = join(PROJECT_ROOT, 'tests', 'fixtures', 'qcomm-cases');

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  const t = readFileSync(path, 'utf8');
  return JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
}

export class FixturePortalDriver extends PortalDriver {
  constructor({ fixtureDir = null } = {}) {
    super();
    this.fixtureDir = fixtureDir || process.env.QCOMM_FIXTURE_DIR || DEFAULT_FIXTURE_DIR;
    this._connected = false;
    this._currentCode = null; // set by navigateToCase(); expandAndExtract() reads it
  }

  caseDir(code) {
    return join(this.fixtureDir, code);
  }

  async connect() {
    this._connected = true;
    return true;
  }

  isConnected() {
    return this._connected;
  }

  async navigateToCase(code, _opts = {}) {
    this._currentCode = code;
    const landing = readJsonIfPresent(join(this.caseDir(code), 'landing.json'));
    if (landing) return landing;
    return {
      state: 'OK',
      href: `https://support.qualcomm.com/s/case/fixture/${code}`,
      fields: {},
      fastPathUsed: false,
      durationMs: 0,
      diagnostics: [`fixture: no landing.json for ${code}, using synthetic ON_CASE landing`],
    };
  }

  async screenshot(_path, _opts = {}) {
    return null; // no real page to capture; verify_case.mjs warns, doesn't error
  }

  async expandAndExtract({ onProbe = null } = {}) {
    // Operates on whatever case navigateToCase() last landed on — mirrors
    // CdpPortalDriver, where expandAndExtract() reads the page the browser is
    // currently sitting on rather than taking a code of its own.
    const dir = this.caseDir(this._currentCode);
    const probe = readJsonIfPresent(join(dir, 'probe.json'));
    if (probe && typeof onProbe === 'function' && onProbe(probe)) {
      return { ok: true, noUpdate: true, probe };
    }

    const raw = readJsonIfPresent(join(dir, 'raw.json'));
    if (!raw || !Array.isArray(raw.comments) || raw.comments.length === 0) {
      return {
        ok: false,
        stage: raw ? 'no-comments' : 'no-articles',
        reason: raw
          ? 'case extraction returned no comments'
          : `no fixture raw.json found at ${join(dir, 'raw.json')}`,
        probe: probe || null,
      };
    }

    const detailRaw = readJsonIfPresent(join(dir, 'detail.json'));
    return {
      ok: true,
      noUpdate: false,
      raw,
      detailRaw,
      detailExtracted: !!detailRaw,
      detailSwitchError: null,
      clicks: { expand: 0, viewMore: 0, moreComments: 0, description: 0 },
      rounds: 0,
      pendingExpand: 0,
      pendingMoreComments: 0,
    };
  }

  async close() {
    this._connected = false;
  }
}
