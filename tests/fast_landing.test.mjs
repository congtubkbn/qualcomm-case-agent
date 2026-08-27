import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockCdpServer } from './mocks/cdp_server.mjs';
import { CdpClient } from '../.claude/skills/qualcomm-case-agent/scripts/cdp_client.mjs';
import { fastLandOnCase, isStubUrl } from '../.claude/skills/qualcomm-case-agent/scripts/fast_landing.mjs';

let seq = 0;
const importFastLanding = () => import(`../.claude/skills/qualcomm-case-agent/scripts/fast_landing.mjs?t=${++seq}`);

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
    assert.ok(result.reason);
    assert.ok(Array.isArray(result.diagnostics));
  });

  await t.test('fastLandOnCase recovers from context destruction retry during direct nav and lands ON_CASE', async () => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    let evalAttempts = 0;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        evalAttempts++;
        if (evalAttempts === 1) {
          // First attempt simulates Chrome destroying execution context during in-flight nav
          return {
            id: msg.id,
            error: {
              code: -32000,
              message: 'Execution context was destroyed.',
            },
          };
        }
        // Second attempt on retry succeeds
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: {
                state: 'ON_CASE',
                href: targetUrl,
                fields: { title: 'Modem Crash Issue' },
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

    assert.equal(result.state, 'OK');
    assert.equal(result.href, targetUrl);
    assert.equal(result.fastPathUsed, true);
    assert.ok(evalAttempts >= 2);
    assert.ok(Array.isArray(result.diagnostics));
  });

  await t.test('fastLandOnCase records diagnostic logs and details before falling back to global search on direct nav failure', async () => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const searchUrl = 'https://support.qualcomm.com/s/global-search/08603854';
    const navigatedUrls = [];

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        navigatedUrls.push(msg.params.url);
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        // Direct nav eval returns TIMEOUT
        if (navigatedUrls[navigatedUrls.length - 1] === targetUrl) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { state: 'TIMEOUT', href: 'https://support.qualcomm.com/s/' },
              },
            },
          };
        }
        // Search eval returns NO_LINK
        if (navigatedUrls[navigatedUrls.length - 1] === searchUrl) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: {
                  state: 'NO_LINK',
                  reason: 'Search yielded zero matches',
                  href: '',
                  fields: {},
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
      cached: { caseUrl: targetUrl },
    });

    assert.equal(result.state, 'NOT_FOUND');
    assert.equal(result.fastPathUsed, false);
    assert.ok(Array.isArray(result.diagnostics));
    assert.ok(result.diagnostics.some(d => d.includes('Falling back to global search') || d.includes('inconclusive')));
    assert.ok(result.diagnostics.some(d => d.includes('global search')));
    assert.equal(result.reason, 'Search yielded zero matches');
  });

  await t.test('autofill: secret present + AUTHENTICATED result proceeds without human action', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const TEST_PW = 'SuperSecretQidPass123!';

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => TEST_PW,
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let evalCount = 0;
    let loginFillParams = null;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        evalCount++;
        const expr = msg.params?.expression || '';
        // 1. Initial direct nav probe -> AUTH
        if (evalCount === 1) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
              },
            },
          };
        }
        // 2. login_fill.js eval
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          loginFillParams = msg.params;
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'AUTHENTICATED' },
              },
            },
          };
        }
        // 3. Post-auth re-nav probe -> ON_CASE
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'ON_CASE', href: targetUrl, fields: { title: 'Camera ISP drop issue' } },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
    });

    assert.equal(result.state, 'OK');
    assert.equal(result.href, targetUrl);
    assert.ok(loginFillParams !== null, 'login_fill.js should have been evaluated');
    // Verify password is never in diagnostics
    assert.ok(!result.diagnostics.some(d => d.includes(TEST_PW)));
  });

  await t.test('autofill: secret present + REJECTED calls clearSecret, returns AUTH with reason password-rejected and no retry', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const TEST_PW = 'WrongPassword999!';
    let clearSecretCalls = 0;

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => TEST_PW,
        clearSecret: () => { clearSecretCalls++; },
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let fillAttempts = 0;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          fillAttempts++;
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'REJECTED', reason: 'Unable to sign in' },
              },
            },
          };
        }
        // Direct nav probe -> AUTH
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
    });

    assert.equal(result.state, 'AUTH');
    assert.equal(result.reason, 'password-rejected');
    assert.equal(clearSecretCalls, 1, 'clearSecret must be called on REJECTED');
    assert.equal(fillAttempts, 1, 'rejected password must never be retried');
    assert.ok(!result.diagnostics.some(d => d.includes(TEST_PW)));
  });

  await t.test('autofill: UNKNOWN twice then success on 3rd attempt executes exactly 3 attempts', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const TEST_PW = 'TransientGlitchPw';

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => TEST_PW,
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let fillAttempts = 0;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          fillAttempts++;
          if (fillAttempts < 3) {
            return {
              id: msg.id,
              result: {
                result: {
                  type: 'object',
                  value: { outcome: 'UNKNOWN', reason: 'Form not ready yet' },
                },
              },
            };
          }
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'AUTHENTICATED' },
              },
            },
          };
        }
        if (fillAttempts >= 3) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { state: 'ON_CASE', href: targetUrl },
              },
            },
          };
        }
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
      fillRetryLimit: 3,
    });

    assert.equal(result.state, 'OK');
    assert.equal(result.href, targetUrl);
    assert.equal(fillAttempts, 3, 'should make exactly 3 fill attempts');
  });

  await t.test('autofill: UNKNOWN on all fillRetryLimit attempts falls back to generic AUTH', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    let clearSecretCalls = 0;

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => 'GlitchPw',
        clearSecret: () => { clearSecretCalls++; },
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let fillAttempts = 0;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          fillAttempts++;
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'UNKNOWN', reason: 'Timeout' },
              },
            },
          };
        }
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
      fillRetryLimit: 3,
    });

    assert.equal(result.state, 'AUTH');
    assert.equal(result.reason, undefined);
    assert.equal(fillAttempts, 3);
    assert.equal(clearSecretCalls, 0, 'clearSecret must not be called on UNKNOWN technical glitches');
  });

  await t.test('autofill: readPassword() returns null -> manual behavior unchanged, no fill attempted', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => null,
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let fillAttempted = false;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          fillAttempted = true;
        }
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
    });

    assert.equal(result.state, 'AUTH');
    assert.equal(result.url, 'https://account.qualcomm.com/login');
    assert.equal(fillAttempted, false, 'must not attempt fill when readPassword is null');
  });

  await t.test('autofill: second AUTH sighting later in same invocation does not re-trigger fresh fill attempt', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    let readPasswordCalls = 0;

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => {
          readPasswordCalls++;
          return 'ValidSecret';
        },
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let fillAttempts = 0;
    let directNavProbes = 0;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          fillAttempts++;
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'AUTHENTICATED' },
              },
            },
          };
        }
        // Direct nav observe probe
        directNavProbes++;
        if (directNavProbes === 1) {
          // First sighting triggers autofill
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
              },
            },
          };
        }
        // Re-nav after autofill still returns AUTH (e.g. session was revoked or redirected back)
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login-again' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
    });

    assert.equal(result.state, 'AUTH');
    assert.equal(readPasswordCalls, 1, 'readPassword should only be called on first AUTH');
    assert.equal(fillAttempts, 1, 'login_fill should only run once across the whole invocation');
  });

  await t.test('security: password is never logged or echoed anywhere in diagnostics or return values', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const LEAK_TEST_PASSWORD = 'TOP_SECRET_SUPER_SPECIAL_PASSWORD_NEVER_LOG';

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => LEAK_TEST_PASSWORD,
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'UNKNOWN', reason: 'Simulated failure' },
              },
            },
          };
        }
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
      fillRetryLimit: 1,
    });

    const resultStr = JSON.stringify(result);
    assert.ok(!resultStr.includes(LEAK_TEST_PASSWORD), 'password must not appear in fastLandOnCase return object');
    assert.ok(Array.isArray(result.diagnostics));
    for (const diag of result.diagnostics) {
      assert.ok(!diag.includes(LEAK_TEST_PASSWORD), 'password must not appear in any diagnostic message');
    }
  });

  await t.test('otp: OTP_REQUIRED then poll resolves AUTHENTICATED resumes landing flow ON_CASE', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const TEST_PW = 'OtpValidPassword123';

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => TEST_PW,
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let fillCalls = 0;
    let pollCalls = 0;
    let navProbes = 0;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          fillCalls++;
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'OTP_REQUIRED' },
              },
            },
          };
        }
        if (expr.includes('otp_probe') || expr.includes('OTP_PROBE') || expr.includes('isHostAuthenticated')) {
          pollCalls++;
          if (pollCalls < 3) {
            return {
              id: msg.id,
              result: {
                result: {
                  type: 'object',
                  value: { outcome: 'OTP_REQUIRED', href: 'https://account.qualcomm.com/login' },
                },
              },
            };
          }
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'AUTHENTICATED', href: 'https://support.qualcomm.com/s/' },
              },
            },
          };
        }
        // Direct nav probe
        navProbes++;
        if (navProbes === 1) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
              },
            },
          };
        }
        // Post-auth re-nav probe -> ON_CASE
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'ON_CASE', href: targetUrl, fields: { title: 'Audio codec crash' } },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
      otpTimeoutMs: 1000,
      otpPollIntervalMs: 20,
    });

    assert.equal(result.state, 'OK');
    assert.equal(result.href, targetUrl);
    assert.equal(fillCalls, 1);
    assert.equal(pollCalls, 3);
    assert.ok(result.diagnostics.some(d => d.includes('OTP')), 'diagnostics must log OTP activity');
  });

  await t.test('otp: OTP_REQUIRED exceeding otpTimeoutMs returns state OTP_TIMEOUT', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const TEST_PW = 'OtpValidPassword123';

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => TEST_PW,
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    let pollCalls = 0;

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'OTP_REQUIRED' },
              },
            },
          };
        }
        if (expr.includes('otp_probe') || expr.includes('OTP_PROBE') || expr.includes('isHostAuthenticated')) {
          pollCalls++;
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'OTP_REQUIRED' },
              },
            },
          };
        }
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
      otpTimeoutMs: 60,
      otpPollIntervalMs: 15,
    });

    assert.equal(result.state, 'OTP_TIMEOUT');
    assert.match(result.reason, /OTP/i);
    assert.match(result.reason, /timeout|timed out/i);
    assert.ok(pollCalls >= 1, 'should have polled at least once');
    assert.ok(result.diagnostics.some(d => d.includes('OTP')), 'diagnostics must log OTP activity');
  });

  await t.test('otp: OTP_REQUIRED then poll encounters REJECTED returns state AUTH', async (st) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const TEST_PW = 'OtpValidPassword123';

    st.mock.module('../.claude/skills/qualcomm-case-agent/scripts/secret_store.mjs', {
      exports: {
        readPassword: () => TEST_PW,
        clearSecret: () => {},
      },
    });

    const { fastLandOnCase: fastLand } = await importFastLanding();

    server.setHandler((msg, ws) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'F1' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params?.expression || '';
        if (expr.includes('login_fill') || expr.includes('classifyCurrentState') || expr.includes('__PASSWORD')) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'OTP_REQUIRED' },
              },
            },
          };
        }
        if (expr.includes('otp_probe') || expr.includes('OTP_PROBE') || expr.includes('isHostAuthenticated')) {
          return {
            id: msg.id,
            result: {
              result: {
                type: 'object',
                value: { outcome: 'REJECTED', reason: 'Invalid verification code entered' },
              },
            },
          };
        }
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: { state: 'AUTH', url: 'https://account.qualcomm.com/login' },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });

    const result = await fastLand('08603854', {
      cdp: client,
      cached: { caseUrl: targetUrl },
      otpTimeoutMs: 1000,
      otpPollIntervalMs: 20,
    });

    assert.equal(result.state, 'AUTH');
    assert.equal(result.reason, 'Invalid verification code entered');
  });
});



