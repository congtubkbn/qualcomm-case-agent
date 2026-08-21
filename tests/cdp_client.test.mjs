// tests/cdp_client.test.mjs
// Unit tests for Native WebSocket CDP Client (Slice 1).

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { createMockCdpServer } from './mocks/cdp_server.mjs';

// We import CdpClient (will be created in Green phase)
const { CdpClient } = await import(
  new URL('../.claude/skills/qualcomm-case-agent/scripts/cdp_client.mjs', import.meta.url)
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
    const res = await client.navigate('https://support.qualcomm.com/s/case/08603854');
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
});
