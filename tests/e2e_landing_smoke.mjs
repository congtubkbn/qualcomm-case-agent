#!/usr/bin/env node
// tests/e2e_landing_smoke.mjs — E2E Smoke Test for Fast CDP Landing Engine.
// Verifies direct CDP connectivity and fastLandOnCase resolution against Chrome 9222 or mock server.
//
// Usage:
//   node tests/e2e_landing_smoke.mjs [CODE] [--port 9222] [--mock]
//
// Exit Codes:
//   0: Landing successful (state: 'OK')
//   3: Auth required / Okta redirect (state: 'AUTH')
//   4: Case not found (state: 'NOT_FOUND')
//   5: Blocked / Stub (state: 'STUB' | 'BLOCKED')
//   1: Connection or unexpected error

import { CdpClient } from '../.claude/skills/qualcomm-case-agent/scripts/cdp_client.mjs';
import { fastLandOnCase } from '../.claude/skills/qualcomm-case-agent/scripts/fast_landing.mjs';
import { createMockCdpServer } from './mocks/cdp_server.mjs';
import { fileURLToPath } from 'node:url';

export async function runSmokeTest(code = '08603854', options = {}) {
  const isMock = options.mock || process.argv.includes('--mock');
  const port = options.port || Number(process.env.QUALCOMM_CDP_PORT || 9222);
  const host = options.host || '127.0.0.1';

  let mockServer = null;
  let targetPort = port;

  if (isMock) {
    mockServer = await createMockCdpServer();
    targetPort = mockServer.port;
    mockServer.setHandler((msg) => {
      if (msg.method === 'Page.navigate') {
        return { id: msg.id, result: { frameId: 'SMOKE_FRAME' } };
      }
      if (msg.method === 'Runtime.evaluate') {
        return {
          id: msg.id,
          result: {
            result: {
              type: 'object',
              value: {
                state: 'ON_CASE',
                href: `https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/${code}`,
                fields: { title: 'Smoke Test Case' },
              },
            },
          },
        };
      }
      return { id: msg.id, result: {} };
    });
    process.stderr.write(`[Smoke] Started local Mock CDP Server on port ${targetPort}\n`);
  }

  process.stderr.write(`[Smoke] Connecting to Chrome CDP at ${host}:${targetPort}...\n`);
  let cdp = null;
  const started = Date.now();

  try {
    cdp = await CdpClient.connect({
      host,
      port: targetPort,
      timeout: isMock ? 3000 : 8000,
    });
    process.stderr.write(`[Smoke] Connected to CDP session successfully.\n`);

    process.stderr.write(`[Smoke] Running fastLandOnCase for case ${code}...\n`);
    const landing = await fastLandOnCase(code, {
      cdp,
      portalUrl: 'https://support.qualcomm.com',
      timeout: 10000,
    });

    const elapsedMs = Date.now() - started;
    const verdict = {
      code,
      status: landing.state === 'OK' ? 'ok' : landing.state.toLowerCase(),
      caseUrl: landing.href || undefined,
      timing: {
        elapsedMs,
        landingMs: landing.durationMs,
      },
      fastPathUsed: landing.fastPathUsed,
      fields: landing.fields,
      reason: landing.reason || undefined,
    };

    // Output single JSON line verdict to stdout (0 token pollution)
    process.stdout.write(JSON.stringify(verdict) + '\n');

    let exitCode = 0;
    if (landing.state === 'AUTH') exitCode = 3;
    else if (landing.state === 'NOT_FOUND') exitCode = 4;
    else if (landing.state === 'STUB' || landing.state === 'BLOCKED') exitCode = 5;
    else if (landing.state !== 'OK') exitCode = 1;

    return { verdict, exitCode };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const errVerdict = {
      code,
      status: 'error',
      reason: err.message,
      timing: { elapsedMs },
    };
    process.stdout.write(JSON.stringify(errVerdict) + '\n');
    process.stderr.write(`[Smoke] Error: ${err.stack || err.message}\n`);
    return { verdict: errVerdict, exitCode: 1 };
  } finally {
    if (cdp) {
      try { await cdp.close(); } catch {}
    }
    if (mockServer) {
      try { await mockServer.close(); } catch {}
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const code = args[0] || '08603854';
  const isMock = process.argv.includes('--mock');
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 9222;

  runSmokeTest(code, { mock: isMock, port })
    .then(({ exitCode }) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      process.stderr.write(`[Smoke] Fatal: ${err.message}\n`);
      process.exit(1);
    });
}
