// tests/fast_landing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockCdpServer } from './mocks/cdp_server.mjs';
import { CdpClient } from '../.claude/skills/qualcomm-case-agent/scripts/cdp_client.mjs';
import { fastLandOnCase, isStubUrl } from '../.claude/skills/qualcomm-case-agent/scripts/fast_landing.mjs';

test('Fast Path Landing Engine', async (t) => {
  let server;
  let client;

  t.beforeEach(async () => {
    server = await createMockCdpServer();
    client = await CdpClient.connect({
      host: '127.0.0.1',
      port: server.port,
    });
  });

  t.afterEach(async () => {
    if (client) await client.close();
    if (server) await server.close();
  });

  await t.test('isStubUrl detects generic Lightning Case stub', () => {
    assert.equal(isStubUrl('https://support.qualcomm.com/s/case/Case/Default'), true);
    assert.equal(isStubUrl('https://support.qualcomm.com/s/case/Case/Default?query=1'), true);
    assert.equal(isStubUrl('https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854'), false);
    assert.equal(isStubUrl(''), true);
    assert.equal(isStubUrl(null), true);
  });

  await t.test('fastLandOnCase succeeds on Fast Path when cached.caseUrl is valid and state is ON_CASE', async () => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    let navigatedUrl = null;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        navigatedUrl = msg.params.url;
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        // Mock in-page wait resolving to ON_CASE
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: {
                state: 'ON_CASE',
                href: targetUrl,
                fields: { title: 'Camera ISP drop issue' },
              },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: {
        caseUrl: targetUrl,
        title: 'Camera ISP drop issue',
      },
    });

    assert.equal(navigatedUrl, targetUrl);
    assert.equal(result.state, 'OK');
    assert.equal(result.href, targetUrl);
    assert.equal(result.fastPathUsed, true);
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs < 1000);
  });

  await t.test('fastLandOnCase accepts cached.url if cached.caseUrl is not explicitly set', async () => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    let navigatedUrl = null;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        navigatedUrl = msg.params.url;
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: {
                state: 'ON_CASE',
                href: targetUrl,
                fields: {},
              },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: {
        url: targetUrl,
      },
    });

    assert.equal(navigatedUrl, targetUrl);
    assert.equal(result.state, 'OK');
    assert.equal(result.fastPathUsed, true);
  });

  await t.test('fastLandOnCase detects AUTH redirect during direct navigation', async () => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: {
                state: 'AUTH',
                url: 'https://account.qualcomm.com/login',
              },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
    });

    assert.equal(result.state, 'AUTH');
    assert.equal(result.fastPathUsed, true);
    assert.equal(result.url, 'https://account.qualcomm.com/login');
  });

  await t.test('fastLandOnCase returns STUB/NOT_FOUND if fast-path direct nav fails to land ON_CASE without cached url', async () => {
    server.setHandler((msg, ws) => {
      if (msg.method === 'Runtime.evaluate') {
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'NO_LINK' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: null,
    });

    assert.equal(result.fastPathUsed, false);
    assert.notEqual(result.state, 'OK');
  });

  await t.test('fastLandOnCase falls back to global search when cached URL fails to reach ON_CASE', async () => {
    const cachedStubUrl = 'https://support.qualcomm.com/s/case/Case/Default';
    const realCaseUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const searchUrl = 'https://support.qualcomm.com/s/global-search/08603854';
    const navigatedUrls = [];

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        navigatedUrls.push(msg.params.url);
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        // First eval on direct nav: fails to land ON_CASE (returns TIMEOUT / stub)
        if (navigatedUrls[navigatedUrls.length - 1] === cachedStubUrl) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { state: 'TIMEOUT', href: cachedStubUrl },
              },
            },
          };
        }
        // Second eval on global-search: returns FOUND with resolved href & fields
        if (navigatedUrls[navigatedUrls.length - 1] === searchUrl) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: {
                  state: 'FOUND',
                  href: realCaseUrl,
                  fields: {
                    title: 'Camera ISP drop issue',
                    status: 'In Progress',
                    priority: 'P2',
                    severity: 'High',
                  },
                },
              },
            },
          };
        }
        // Third eval after direct nav to realCaseUrl: ON_CASE
        if (navigatedUrls[navigatedUrls.length - 1] === realCaseUrl) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: {
                  state: 'ON_CASE',
                  href: realCaseUrl,
                },
              },
            },
          };
        }
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: { caseUrl: cachedStubUrl },
    });

    assert.equal(result.state, 'OK');
    assert.equal(result.href, realCaseUrl);
    assert.equal(result.fastPathUsed, false);
    assert.equal(result.fields.title, 'Camera ISP drop issue');
    assert.equal(result.fields.status, 'In Progress');
    assert.ok(navigatedUrls.includes(searchUrl));
  });

  await t.test('fastLandOnCase searches directly for new case without cached metadata', async () => {
    const realCaseUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const searchUrl = 'https://support.qualcomm.com/s/global-search/08603854';
    const navigatedUrls = [];

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        navigatedUrls.push(msg.params.url);
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        if (navigatedUrls[navigatedUrls.length - 1] === searchUrl) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: {
                  state: 'FOUND',
                  href: realCaseUrl,
                  fields: { title: 'New Modem Crash Case' },
                },
              },
            },
          };
        }
        if (navigatedUrls[navigatedUrls.length - 1] === realCaseUrl) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { state: 'ON_CASE', href: realCaseUrl },
              },
            },
          };
        }
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: null,
    });

    assert.equal(result.state, 'OK');
    assert.equal(result.href, realCaseUrl);
    assert.equal(result.fastPathUsed, false);
    assert.equal(result.fields.title, 'New Modem Crash Case');
    assert.equal(navigatedUrls[0], searchUrl);
  });

  await t.test('fastLandOnCase falls back to trusted click if search row href is stub', async () => {
    const stubUrl = 'https://support.qualcomm.com/s/case/Case/Default';
    const realCaseUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const searchUrl = 'https://support.qualcomm.com/s/global-search/08603854';
    let clickedSelector = null;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        // If calculating coords in cdp.click
        if (expr.includes("querySelector") && expr.includes("getBoundingClientRect")) {
          clickedSelector = "[data-cq-hit='1']";
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
        // First search eval returns stub link
        if (!clickedSelector) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: {
                  state: 'FOUND',
                  href: stubUrl,
                  fields: { title: 'Stub Case Title' },
                },
              },
            },
          };
        }
        // After click, observation yields ON_CASE
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'ON_CASE', href: realCaseUrl },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: null,
    });

    assert.equal(result.state, 'OK');
    assert.equal(result.href, realCaseUrl);
    assert.equal(result.fastPathUsed, false);
    assert.equal(clickedSelector, "[data-cq-hit='1']");
  });

  await t.test('fastLandOnCase detects AUTH redirect during global search', async () => {
    const searchUrl = 'https://support.qualcomm.com/s/global-search/08603854';

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: {
                state: 'AUTH',
                url: 'https://account.qualcomm.com/login',
              },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('08603854', {
      cdp: client,
      cached: null,
    });

    assert.equal(result.state, 'AUTH');
    assert.equal(result.fastPathUsed, false);
    assert.equal(result.url, 'https://account.qualcomm.com/login');
  });

  await t.test('fastLandOnCase returns NOT_FOUND when search returns NO_LINK', async () => {
    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'NO_LINK', href: '', fields: {} },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLandOnCase('99999999', {
      cdp: client,
      cached: null,
    });

    assert.equal(result.state, 'NOT_FOUND');
    assert.equal(result.fastPathUsed, false);
  });
});

