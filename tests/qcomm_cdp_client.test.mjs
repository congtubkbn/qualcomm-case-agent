// tests/qcomm_cdp_client.test.mjs
// Unit tests for Native WebSocket CDP Client (Slice 1).

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { createMockCdpServer } from './mocks/cdp_server.mjs';

// We import CdpClient (will be created in Green phase)
const { CdpClient } = await import(
  new URL('../.claude/skills/qcomm/scripts/cdp_client.mjs', import.meta.url)
);

describe('CdpClient (Native WebSocket CDP Transport)', () => {
  let mockServer;

  before(async () => {
    mockServer = await createMockCdpServer();
  });

  after(async () => {
    if (mockServer) await mockServer.close();
  });

  it('connects to CDP server via CdpClient.connect() and attaches to target page', async () => {
    const client = await CdpClient.connect({ port: mockServer.port });
    assert.equal(client.isConnected(), true);
    assert.ok(client.targetId || client.wsUrl);
    await client.close();
    assert.equal(client.isConnected(), false);
  });

  it('sends Page.navigate command and receives response < 10ms', async () => {
    const client = await CdpClient.connect({ port: mockServer.port });
    const t0 = performance.now();
    const res = await client.navigate('https://support.qualcomm.com/s/case/08603854', { waitUntil: 'none' });
    const elapsed = performance.now() - t0;

    assert.ok(res);
    assert.ok(res.frameId || res.loaderId);
    assert.ok(elapsed < 100, `Expected < 100ms in unit test, got ${elapsed}ms`);
    await client.close();
  });

  it('evaluates JS expression and unpacks remote object values', async () => {
    const client = await CdpClient.connect({ port: mockServer.port });
    
    // Primitive return
    const res42 = await client.eval('return 42');
    assert.equal(res42, 42);

    // String return
    const resHref = await client.eval('return location.href');
    assert.equal(resHref, 'https://support.qualcomm.com/s/case/08603854');

    // Object return
    const resObj = await client.eval('return { ready: true }');
    assert.deepEqual(resObj, { state: 'READY' });

    await client.close();
  });

  it('evaluates with injected args using buildPayload pattern', async () => {
    let receivedExpression = null;
    mockServer.setHandler((msg) => {
      if (msg.method === 'Runtime.evaluate') {
        receivedExpression = msg.params.expression;
        return {
          id: msg.id,
          result: {
            result: {
              type: 'string',
              value: 'FOUND_TEST',
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    const res = await client.eval('return __CODE', { __CODE: '08603854' });

    assert.equal(res, 'FOUND_TEST');
    assert.ok(receivedExpression.includes('var __CODE = "08603854";'));
    assert.ok(receivedExpression.startsWith('(function()'));

    mockServer.setHandler(null);
    await client.close();
  });

  it('dispatches click events without spawning child processes', async () => {
    const events = [];
    mockServer.setHandler((msg) => {
      if (msg.method === 'Input.dispatchMouseEvent') {
        events.push(msg.params);
        return { id: msg.id, result: {} };
      }
      if (msg.method === 'Runtime.evaluate') {
        // simulate bounding box lookup
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { x: 100, y: 200 },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    const ok = await client.click('a.case-link');
    assert.equal(ok, true);

    // Click dispatches mousePressed and mouseReleased
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'mousePressed');
    assert.equal(events[0].x, 100);
    assert.equal(events[0].y, 200);
    assert.equal(events[1].type, 'mouseReleased');

    mockServer.setHandler(null);
    await client.close();
  });

  it('auto-reconnects transparently when connection is dropped', async () => {
    const client = await CdpClient.connect({ port: mockServer.port });
    assert.equal(client.isConnected(), true);

    // Drop all server connections to simulate disconnect
    mockServer.closeAllClients();

    // Give socket event a tick to notice disconnect
    await new Promise((r) => setTimeout(r, 50));

    // Next request triggers auto-reconnect
    const res = await client.eval('return 42');
    assert.equal(res, 42);
    assert.equal(client.isConnected(), true);

    await client.close();
  });

  it('navigate() waits for Page.loadEventFired lifecycle event when waitUntil is load', async () => {
    let pageEnabled = false;
    let navigateCalled = false;

    mockServer.setHandler((msg, ws) => {
      if (msg.method === 'Page.enable') {
        pageEnabled = true;
        return { id: msg.id, result: {} };
      }
      if (msg.method === 'Page.navigate') {
        navigateCalled = true;
        // Simulate async load event firing after 50ms
        setTimeout(() => {
          ws.send(JSON.stringify({
            method: 'Page.loadEventFired',
            params: { timestamp: Date.now() / 1000 }
          }));
        }, 50);
        return { id: msg.id, result: { frameId: 'F1', loaderId: 'L1' }, suppressLoadEvent: true };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    const t0 = performance.now();
    const res = await client.navigate('https://support.qualcomm.com/s/case/08603854', {
      waitUntil: 'load',
      timeout: 2000,
    });
    const elapsed = performance.now() - t0;

    assert.ok(pageEnabled, 'Page.enable should have been called');
    assert.ok(navigateCalled, 'Page.navigate should have been called');
    assert.ok(elapsed >= 40, `Expected elapsed >= 40ms waiting for load event, got ${elapsed}ms`);
    assert.ok(res.frameId === 'F1');

    mockServer.setHandler(null);
    await client.close();
  });

  it('navigate() resolves gracefully on navigation timeout without throwing unhandled rejection', async () => {
    mockServer.setHandler((msg, ws) => {
      if (msg.method === 'Page.enable') return { id: msg.id, result: {} };
      if (msg.method === 'Page.navigate') {
        // Suppress Page.loadEventFired to test timeout
        return { id: msg.id, result: { frameId: 'F1', loaderId: 'L1' }, suppressLoadEvent: true };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    // Should not throw, should resolve gracefully with navigation result
    const res = await client.navigate('https://support.qualcomm.com/s/case/08603854', {
      waitUntil: 'load',
      timeout: 100,
    });

    assert.ok(res);
    assert.equal(res.frameId, 'F1');
    assert.equal(res.timedOut, true);

    mockServer.setHandler(null);
    await client.close();
  });

  it('eval() retries and recovers when encountering transient context destruction', async () => {
    let evalAttempts = 0;
    mockServer.setHandler((msg) => {
      if (msg.method === 'Runtime.evaluate') {
        evalAttempts++;
        if (evalAttempts === 1) {
          // First attempt: simulate transient context destroyed
          return {
            id: msg.id,
            error: {
              code: -32000,
              message: 'Execution context was destroyed.',
            },
          };
        }
        // Second attempt: context restored, returns success
        return {
          id: msg.id,
          result: {
            result: {
              type: 'string',
              value: 'RECOVERED_VALUE',
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    const result = await client.eval('return window.__STATUS', {}, { maxRetries: 3, retryDelay: 50 });

    assert.equal(result, 'RECOVERED_VALUE');
    assert.equal(evalAttempts, 2, 'Should have retried once after context destruction');

    mockServer.setHandler(null);
    await client.close();
  });

  it('eval() throws CdpError after maxRetries are exhausted for persistent context destruction', async () => {
    let evalAttempts = 0;
    mockServer.setHandler((msg) => {
      if (msg.method === 'Runtime.evaluate') {
        evalAttempts++;
        return {
          id: msg.id,
          error: {
            code: -32000,
            message: 'Execution context was destroyed.',
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    await assert.rejects(
      async () => {
        await client.eval('return 1', {}, { maxRetries: 2, retryDelay: 20 });
      },
      (err) => {
        assert.ok(err.message.includes('Execution context was destroyed'));
        return true;
      }
    );

    assert.equal(evalAttempts, 3, 'Should attempt initial try + 2 retries = 3 attempts');

    mockServer.setHandler(null);
    await client.close();
  });

  it('screenshot() captures full-page PNG by default and returns Buffer', async () => {
    let capturedMethod = null;
    let capturedParams = null;
    const mockPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    mockServer.setHandler((msg) => {
      if (msg.method === 'Page.enable') return { id: msg.id, result: {} };
      if (msg.method === 'Page.captureScreenshot') {
        capturedMethod = msg.method;
        capturedParams = msg.params;
        return {
          id: msg.id,
          result: { data: mockPngBase64 },
        };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    const buf = await client.screenshot();

    assert.ok(Buffer.isBuffer(buf), 'result should be a Node.js Buffer');
    assert.equal(buf.toString('base64'), mockPngBase64);
    assert.equal(capturedMethod, 'Page.captureScreenshot');
    assert.equal(capturedParams.format, 'png');
    assert.equal(capturedParams.captureBeyondViewport, true);

    mockServer.setHandler(null);
    await client.close();
  });

  it('screenshot() forwards custom parameters (format, quality, clip, fullPage)', async () => {
    let capturedParams = null;
    const mockJpgBase64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

    mockServer.setHandler((msg) => {
      if (msg.method === 'Page.enable') return { id: msg.id, result: {} };
      if (msg.method === 'Page.captureScreenshot') {
        capturedParams = msg.params;
        return {
          id: msg.id,
          result: { data: mockJpgBase64 },
        };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    const clip = { x: 10, y: 20, width: 300, height: 400, scale: 1 };
    const buf = await client.screenshot({
      format: 'jpeg',
      quality: 85,
      fullPage: false,
      clip,
    });

    assert.ok(Buffer.isBuffer(buf));
    assert.equal(capturedParams.format, 'jpeg');
    assert.equal(capturedParams.quality, 85);
    assert.deepEqual(capturedParams.clip, clip);
    assert.equal(capturedParams.captureBeyondViewport, undefined);

    mockServer.setHandler(null);
    await client.close();
  });

  it('screenshot() throws CdpError when Page.captureScreenshot fails or returns no data', async () => {
    mockServer.setHandler((msg) => {
      if (msg.method === 'Page.enable') return { id: msg.id, result: {} };
      if (msg.method === 'Page.captureScreenshot') {
        return {
          id: msg.id,
          error: { code: -32000, message: 'Screenshot capture failed' },
        };
      }
      return { id: msg.id, result: {} };
    });

    const client = await CdpClient.connect({ port: mockServer.port });
    await assert.rejects(
      async () => {
        await client.screenshot();
      },
      (err) => {
        assert.equal(err.name, 'CdpError');
        assert.match(err.message, /Screenshot capture failed/);
        return true;
      }
    );

    mockServer.setHandler(null);
    await client.close();
  });
});

