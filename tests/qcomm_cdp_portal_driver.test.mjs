// Tests for CdpPortalDriver.connect()'s neutral-descriptor contract (issue: fix
// "Classify connection verdicts through the PortalDriver seam, not browser.mjs's
// error classes"). connect() must never let browser.mjs's BrowserError/
// PortConflictError escape — it catches them and returns the same
// { ok, stage, reason, detail? } shape expandAndExtract() already uses, so
// run_case.mjs never has to import or instanceof-check browser.mjs's error
// classes to build a verdict.
//
//     node --test tests/qcomm_cdp_portal_driver.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CdpPortalDriver } from '../.claude/skills/qcomm/scripts/cdp_portal_driver.mjs';

class BrowserError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'BrowserError';
    this.detail = detail;
  }
}
class PortConflictError extends BrowserError {
  constructor(message, detail) {
    super(message, detail);
    this.name = 'PortConflictError';
  }
}

describe('CdpPortalDriver.connect()', () => {
  it('returns { ok: true } and isConnected() true on success', async () => {
    const cdp = { isConnected: () => true };
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => {},
        getCdpClient: async () => cdp,
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: true });
    assert.equal(driver.isConnected(), true);
  });

  it('returns { ok: false, stage: "port-conflict", reason, detail } when ensureChrome throws PortConflictError, without isConnected()', async () => {
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => {
          throw new PortConflictError('CDP port 9773 is held by a process that is not this project\'s Chrome', { port: 9773, commandLine: 'other.exe' });
        },
        getCdpClient: async () => { throw new Error('should not be called'); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'port-conflict');
    assert.equal(result.reason, 'CDP port 9773 is held by a process that is not this project\'s Chrome');
    assert.deepEqual(result.detail, { port: 9773, commandLine: 'other.exe' });
    assert.equal(driver.isConnected(), false);
  });

  it('returns { ok: false, stage: "blocked", reason } when ensureChrome throws a plain BrowserError', async () => {
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => { throw new BrowserError('no Chrome on CDP 9773 (profile X) — start it, then retry'); },
        getCdpClient: async () => { throw new Error('should not be called'); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: false, stage: 'blocked', reason: 'no Chrome on CDP 9773 (profile X) — start it, then retry' });
    assert.equal(driver.isConnected(), false);
  });

  it('returns { ok: false, stage: "blocked", reason: e.message } when getCdpClient() throws (ensureChrome succeeds)', async () => {
    const driver = new CdpPortalDriver({
      browser: {
        ensureChrome: async () => {},
        getCdpClient: async () => { throw new Error('WebSocket handshake failed'); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: false, stage: 'blocked', reason: 'WebSocket handshake failed' });
    assert.equal(driver.isConnected(), false);
  });

  it('returns { ok: true } without calling getCdpClient() when a cdp client was pre-injected', async () => {
    const cdp = { isConnected: () => true };
    let getCdpClientCalled = false;
    const driver = new CdpPortalDriver({
      cdp,
      browser: {
        ensureChrome: async () => {},
        getCdpClient: async () => { getCdpClientCalled = true; return cdp; },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: true });
    assert.equal(getCdpClientCalled, false);
  });

  it('still surfaces a port-conflict even when a cdp client was pre-injected (ensureChrome always runs first)', async () => {
    const cdp = { isConnected: () => true };
    const driver = new CdpPortalDriver({
      cdp,
      browser: {
        ensureChrome: async () => { throw new PortConflictError('port held by another tool', { port: 9773 }); },
      },
      fastLanding: {},
    });
    const result = await driver.connect();
    assert.deepEqual(result, { ok: false, stage: 'port-conflict', reason: 'port held by another tool', detail: { port: 9773 } });
    assert.equal(driver.isConnected(), false);
  });
});
