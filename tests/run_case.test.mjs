// Tests for run_case.mjs's pipeline orchestrator, anchor logic, and stuck detection.
// browser.mjs (evalFile/open/click/sleep/getCdpClient) is mocked via node:test's module mocker
// so these run with NO real Chrome/CDP/network involved.
//     node --experimental-test-module-mocks --test tests/run_case.test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-run-'));

const SCRIPTS = new URL('../.claude/skills/qualcomm-case-agent/scripts/', import.meta.url);
const BROWSER_URL = new URL('browser.mjs', SCRIPTS);
const REAL_HREF = 'https://support.qualcomm.com/s/case/500dK00000HZeVSQA1/some-title';

function mockBrowser(t, handlerOrQueue, cdpOverride = null) {
  const evalFileCalls = [];
  const openCalls = [];
  const clickCalls = [];
  const screenshotCalls = [];

  const defaultMockCdp = {
    isConnected: () => true,
    navigate: async () => {},
    eval: async () => ({
      state: 'ON_CASE',
      href: REAL_HREF,
      fields: { title: 't' },
    }),
    click: async () => true,
    close: async () => {},
  };

  t.mock.module(BROWSER_URL, {
    exports: {
      click: (sel) => { clickCalls.push(sel); },
      open: (url) => { openCalls.push(url); },
      sleep: async () => {},
      ensureChrome: async () => {},
      pdf: () => {},
      screenshot: (path) => { screenshotCalls.push(path); },
      getCdpClient: async () => cdpOverride || defaultMockCdp,
      closeCdpClient: async () => {},
      CDP_PORT: 9773,
      BrowserError: class BrowserError extends Error {},
      PortConflictError: class PortConflictError extends Error {},
      evalFile: (path, vars) => {
        const file = path.split(/[\\/]/).pop();
        evalFileCalls.push({ path: file, vars });
        if (typeof handlerOrQueue === 'function') {
          try {
            const res = handlerOrQueue(file, vars);
            if (res !== undefined) return res;
          } catch (e) {
            if (file === 'switch_tab.js') return { ok: true, clicked: true };
            throw e;
          }
          if (file === 'switch_tab.js') return { ok: true, clicked: true };
        }
        const next = handlerOrQueue.shift();
        if (next === undefined) throw new Error(`mockBrowser: evalFile queue exhausted on ${file}`);
        return next;
      },
      evalFileViaCdp: async (_cdp, path, vars) => {
        const file = path.split(/[\\/]/).pop();
        evalFileCalls.push({ path: file, vars });
        if (typeof handlerOrQueue === 'function') {
          return handlerOrQueue(file, vars);
        }
        const next = handlerOrQueue.shift();
        if (next === undefined) throw new Error(`mockBrowser: evalFileViaCdp queue exhausted on ${file}`);
        return next;
      },
    },
  });
  return { evalFileCalls, openCalls, clickCalls, screenshotCalls };
}

let seq = 0;
const importRunCase = () => import(new URL(`run_case.mjs?t=${++seq}`, SCRIPTS));

describe('anchorOf & isNoUpdate', () => {
  it('extracts author and bodyStart prefix for cached comment', async () => {
    const { anchorOf } = await importRunCase();
    const cached = {
      comments: [
        { author: 'Qualcomm Engineer', body: '  Please check the QXDM log for   NAS attach error.  ' },
      ],
    };
    const anchor = anchorOf(cached);
    assert.deepEqual(anchor, {
      author: 'Qualcomm Engineer',
      bodyStart: 'Please check the QXDM log for NAS attach error.',
    });
    assert.equal(anchorOf(null), null);
    assert.equal(anchorOf({ comments: [] }), null);
  });

  it('normalizes whitespace into the anchor body prefix', async () => {
    const { anchorOf } = await importRunCase();
    const anchor = anchorOf({ comments: [{ author: 'A', body: 'line1\n\nline2\t\tline3' }] });
    assert.equal(anchor.bodyStart, 'line1 line2 line3');
  });

  it('reports no-update only when the anchor is still the top post and 0 unexpanded controls', async () => {
    const { isNoUpdate } = await importRunCase();
    const cached = { comments: [{ author: 'A', body: 'x' }] };
    const cleanProbe = { top: { author: 'A', bodyStart: 'x' }, anchorIdx: 0, pendingExpand: 0, pendingMoreComments: 0 };
    assert.equal(isNoUpdate(cleanProbe, cached), true);

    const movedProbe = { top: { author: 'B', bodyStart: 'new' }, anchorIdx: 1, pendingExpand: 0, pendingMoreComments: 0 };
    assert.equal(isNoUpdate(movedProbe, cached), false);

    const unexpandedProbe = { top: { author: 'A', bodyStart: 'x' }, anchorIdx: 0, pendingExpand: 1, pendingMoreComments: 0 };
    assert.equal(isNoUpdate(unexpandedProbe, cached), false);

    const moreCommentsProbe = { top: { author: 'A', bodyStart: 'x' }, anchorIdx: 0, pendingExpand: 0, pendingMoreComments: 2 };
    assert.equal(isNoUpdate(moreCommentsProbe, cached), false);
  });
});

describe('mergeDetailFields', () => {
  it('prefers detailRaw over a differing raw value (regression: case 08417053)', async () => {
    const { mergeDetailFields } = await importRunCase();
    const raw = { contactName: 'Sang Bui' };
    const detailRaw = { contactName: 'Duc Hoang' };
    const merged = mergeDetailFields(raw, detailRaw, ['contactName']);
    assert.equal(merged.contactName, 'Duc Hoang');
  });

  it('keeps using detailRaw when raw is empty', async () => {
    const { mergeDetailFields } = await importRunCase();
    const merged = mergeDetailFields({ contactName: '' }, { contactName: 'Duc Hoang' }, ['contactName']);
    assert.equal(merged.contactName, 'Duc Hoang');
  });

  it('falls back to raw when detailRaw is absent/empty for that field', async () => {
    const { mergeDetailFields } = await importRunCase();
    const merged = mergeDetailFields({ contactName: 'Sang Bui' }, { contactName: '' }, ['contactName']);
    assert.equal(merged.contactName, 'Sang Bui');
  });

  it('returns raw unchanged when detailRaw itself is null/absent', async () => {
    const { mergeDetailFields } = await importRunCase();
    const raw = { contactName: 'Sang Bui' };
    const merged = mergeDetailFields(raw, null, ['contactName']);
    assert.equal(merged, raw);
    assert.equal(merged.contactName, 'Sang Bui');
  });

  it('leaves fields outside the given list untouched regardless of either value', async () => {
    const { mergeDetailFields } = await importRunCase();
    const raw = { contactName: 'Sang Bui', unrelated: 'raw-value' };
    const detailRaw = { contactName: 'Duc Hoang', unrelated: 'detail-value' };
    const merged = mergeDetailFields(raw, detailRaw, ['contactName']);
    assert.equal(merged.unrelated, 'raw-value');
  });
});

describe('parseArgs minimal CLI contract', () => {
  it('defaults to mode: auto', async () => {
    const { parseArgs } = await importRunCase();
    assert.deepEqual(parseArgs([]), { mode: 'auto' });
  });

  it('accepts --mode full and --mode update', async () => {
    const { parseArgs } = await importRunCase();
    assert.deepEqual(parseArgs(['--mode', 'full']), { mode: 'full' });
    assert.deepEqual(parseArgs(['--mode', 'update']), { mode: 'update' });
  });

  it('ignores deprecated --enrich and --no-pdf flags', async () => {
    const { parseArgs } = await importRunCase();
    const parsed = parseArgs(['--enrich', 'local', '--no-pdf', '--mode', 'full']);
    assert.deepEqual(parsed, { mode: 'full' });
    assert.equal(parsed.enrich, undefined);
    assert.equal(parsed.noPdf, undefined);
  });
});

describe('STATUS_EXIT & formatVerdict', () => {
  it('maps blocked/auth/busy statuses to distinct non-zero exits', async () => {
    const { STATUS_EXIT } = await importRunCase();
    assert.equal(STATUS_EXIT.created, 0);
    assert.equal(STATUS_EXIT.updated, 0);
    assert.equal(STATUS_EXIT['no-update'], 0);
    assert.equal(STATUS_EXIT['auth-required'], 3);
    assert.equal(STATUS_EXIT['not-found'], 4);
    assert.equal(STATUS_EXIT.blocked, 5);
    assert.equal(STATUS_EXIT.busy, 6);
    assert.equal(STATUS_EXIT['port-conflict'], 7);
    assert.equal(STATUS_EXIT.error, 1);
  });

  it('formats standardized single-line JSON verdict', async () => {
    const { formatVerdict } = await importRunCase();
    const started = Date.now() - 250;
    const v = formatVerdict('08438355', { status: 'created', href: REAL_HREF, durationMs: 80 }, started);
    assert.equal(v.code, '08438355');
    assert.equal(v.status, 'created');
    assert.equal(v.caseUrl, REAL_HREF);
    assert.ok(v.timing.elapsedMs >= 200);
    assert.equal(v.timing.landingMs, 80);
  });
});

describe('run() expand-loop stuck detection', () => {
  it('reports blocked+retryable instead of silently extracting a half-expanded feed', async (t) => {
    const stuckTick = { clickedExpand: 1, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };
    const stableFeed = { articles: 5, displayed: 5, anchorIdx: -1, top: { author: 'A', bodyStart: 'x' } };

    mockBrowser(t, (file, vars) => {
      if (file === 'expand_step.js') {
        if (vars?.__PROBE) return stableFeed;
        return stuckTick;
      }
      if (file === 'check_collapsed.js') {
        return { stillCollapsed: 2, stillHasMoreComments: 0 };
      }
      if (file === 'extract_case.js') {
        return { caseNumber: '08438355', title: 't', status: 'Open', url: REAL_HREF, comments: [] };
      }
      throw new Error(`Unexpected evalFile: ${file}`);
    });

    const { run } = await importRunCase();
    const v = await run('08438355', { mode: 'auto', enrich: 'none', noPdf: true });
    assert.equal(v.status, 'blocked');
    assert.equal(v.retryable, true);
    assert.match(v.reason, /collapsed post/);
    assert.equal(v.expandRounds, 40);
    assert.equal(v.evidence.stillCollapsed, 2);
  });

  it('recovers if the stuck control finally lets go during the grace retries', async (t) => {
    const stuckTick = { clickedExpand: 1, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };
    const idleTick = { clickedExpand: 0, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };
    const stableFeed = { articles: 5, displayed: 5, anchorIdx: -1, top: { author: 'A', bodyStart: 'x' } };

    let expandCount = 0;
    const { evalFileCalls } = mockBrowser(t, (file, vars) => {
      if (file === 'expand_step.js') {
        if (vars?.__PROBE) return stableFeed;
        expandCount++;
        if (expandCount <= 40) return stuckTick;
        return idleTick;
      }
      if (file === 'check_collapsed.js') {
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      if (file === 'extract_case.js') {
        return {
          caseNumber: '08438355',
          title: 't',
          status: 'Open',
          url: REAL_HREF,
          comments: [{ author: 'A', body: 'ok', timestamp: 't' }],
        };
      }
      throw new Error(`Unexpected evalFile: ${file}`);
    });

    mkdirSync(join(process.env.QUALCOMM_ROOT, 'data', 'cases', '08438355'), { recursive: true });
    const { run } = await importRunCase();
    const v = await run('08438355', { mode: 'auto', enrich: 'none', noPdf: true });
    if (v.status !== 'created' && v.status !== 'updated') console.error('FAILED TEST 2 V:', v);
    assert.ok(!(v.status === 'blocked' && v.retryable), 'must not report the stuck verdict once a grace retry goes idle');
    assert.ok(!/round budget/.test(v.reason || ''));
    assert.equal(v.verified, true);
    assert.equal(v.evidence.pendingExpand, 0);
    assert.equal(v.evidence.pendingMoreComments, 0);
    assert.ok(v.evidence.clicks.expand >= 1);
    const names = evalFileCalls.map(c => c.path);
    assert.ok(names.filter(n => n === 'expand_step.js').length >= 40);
    assert.ok(names.filter(n => n === 'check_collapsed.js').length >= 2);
  });
});

describe('run() fast landing & verdict integration', () => {
  it('uses fastLandOnCase directly when cdp is provided in options', async (t) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08438355';
    const mockCdp = {
      isConnected: () => true,
      navigate: async () => {},
      eval: async () => ({
        state: 'ON_CASE',
        href: targetUrl,
        fields: { title: 'Test Case Title' },
      }),
      click: async () => true,
      close: async () => {},
    };

    const stableFeed = { articles: 5, displayed: 5, anchorIdx: -1, top: { author: 'A', bodyStart: 'x' } };
    const idleTick = { clickedExpand: 0, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };

    mockBrowser(t, (file, vars) => {
      if (file === 'expand_step.js') {
        if (vars?.__PROBE) return stableFeed;
        return idleTick;
      }
      if (file === 'check_collapsed.js') {
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      if (file === 'extract_case.js') {
        return {
          caseNumber: '08438355',
          title: 'Test Case Title',
          status: 'Open',
          url: targetUrl,
          comments: [{ author: 'A', body: 'content body', timestamp: 't' }],
        };
      }
      throw new Error(`Unexpected evalFile: ${file}`);
    }, mockCdp);

    mkdirSync(join(process.env.QUALCOMM_ROOT, 'data', 'cases', '08438355'), { recursive: true });
    const { run, formatVerdict } = await importRunCase();
    const v = await run('08438355', { mode: 'auto', enrich: 'none', noPdf: true, cdp: mockCdp });

    assert.equal(v.verified, true);
    assert.equal(v.caseUrl, targetUrl);
    assert.ok(v.timing, 'verdict includes timing info');
    assert.ok(typeof v.timing.landingMs === 'number');
    assert.ok(v.mdPath && v.mdPath.endsWith('case.md'));
    assert.ok(v.casePath && v.casePath.endsWith('case.json'));
    assert.equal(v.pdfPath, undefined);
    assert.equal(v.htmlPath, undefined);
    assert.equal(v.reportPath, undefined);
    assert.equal(v.txtPath, undefined);

    const started = Date.now() - 150;
    const formatted = formatVerdict('08438355', v, started);
    assert.equal(formatted.code, '08438355');
    assert.equal(formatted.status, v.status);
    assert.equal(formatted.caseUrl, targetUrl);
    assert.equal(typeof formatted.timing.elapsedMs, 'number');
    assert.equal(typeof formatted.timing.landingMs, 'number');
  });

  it('handles NOT_FOUND landing with diagnostics and screenshot', async (t) => {
    const mockCdp = {
      isConnected: () => true,
      navigate: async () => {},
      eval: async () => ({
        state: 'NO_LINK',
        reason: 'Search returned no case links for 08000001',
      }),
      click: async () => true,
      close: async () => {},
    };

    const { screenshotCalls } = mockBrowser(t, () => {}, mockCdp);
    const { run, formatVerdict } = await importRunCase();
    const v = await run('08000001', { mode: 'auto', enrich: 'none', noPdf: true, cdp: mockCdp });

    assert.equal(v.status, 'not-found');
    assert.match(v.reason, /no search result|no case link/i);
    assert.ok(Array.isArray(v.diagnostics), 'diagnostics array should be included');
    assert.ok(v.diagnostics.length > 0);
    assert.equal(v.screenshot, 'not_found.png');
    assert.ok(screenshotCalls.some(p => p.endsWith('not_found.png')));

    const formatted = formatVerdict('08000001', v, Date.now() - 100);
    assert.equal(formatted.status, 'not-found');
    assert.equal(formatted.screenshot, 'not_found.png');
    assert.deepEqual(formatted.diagnostics, v.diagnostics);
  });

  it('handles STUB / blocked landing with diagnostics and screenshot', async (t) => {
    let evalStep = 0;
    const mockCdp = {
      isConnected: () => true,
      navigate: async () => {},
      eval: async () => {
        evalStep++;
        if (evalStep === 1) {
          // Search script returns STUB link
          return {
            state: 'FOUND',
            href: 'https://support.qualcomm.com/s/case/Case/Default',
            exact: false,
            fields: {},
            rows: 1,
          };
        }
        // Click probe returns TIMEOUT
        return { state: 'TIMEOUT', href: 'https://support.qualcomm.com/s/case/Case/Default' };
      },
      click: async () => true,
      close: async () => {},
    };

    const { screenshotCalls } = mockBrowser(t, () => {}, mockCdp);
    const { run, formatVerdict } = await importRunCase();
    const v = await run('08000002', { mode: 'auto', enrich: 'none', noPdf: true, cdp: mockCdp });

    assert.equal(v.status, 'blocked');
    assert.match(v.reason, /stub/i);
    assert.ok(Array.isArray(v.diagnostics), 'diagnostics array should be included');
    assert.equal(v.screenshot, 'landing_failure.png');
    assert.ok(screenshotCalls.some(p => p.endsWith('landing_failure.png')));

    const formatted = formatVerdict('08000002', v, Date.now() - 100);
    assert.equal(formatted.status, 'blocked');
    assert.equal(formatted.screenshot, 'landing_failure.png');
    assert.deepEqual(formatted.diagnostics, v.diagnostics);
  });

  it('handles AUTH redirect with diagnostics and auth_required screenshot', async (t) => {
    const mockCdp = {
      isConnected: () => true,
      navigate: async () => {},
      eval: async () => ({
        state: 'AUTH',
        url: 'https://account.qualcomm.com/login',
      }),
      click: async () => true,
      close: async () => {},
    };

    const { screenshotCalls } = mockBrowser(t, () => {}, mockCdp);
    const { run, formatVerdict } = await importRunCase();
    const v = await run('08000003', { mode: 'auto', enrich: 'none', noPdf: true, cdp: mockCdp });

    assert.equal(v.status, 'auth-required');
    assert.match(v.reason, /okta/i);
    assert.ok(Array.isArray(v.diagnostics));
    assert.equal(v.screenshot, 'auth_required.png');
    assert.ok(screenshotCalls.some(p => p.endsWith('auth_required.png')));

    const formatted = formatVerdict('08000003', v, Date.now() - 100);
    assert.equal(formatted.status, 'auth-required');
    assert.equal(formatted.screenshot, 'auth_required.png');
  });

  it('handles feed with no articles with diagnostics and feed_missing screenshot', async (t) => {
    const mockCdp = {
      isConnected: () => true,
      navigate: async () => {},
      eval: async () => ({
        state: 'ON_CASE',
        href: REAL_HREF,
        fields: { title: 't' },
      }),
      click: async () => true,
      close: async () => {},
    };

    const { screenshotCalls } = mockBrowser(t, (file, vars) => {
      if (file === 'expand_step.js') {
        return { articles: 0 };
      }
      throw new Error(`Unexpected evalFile: ${file}`);
    }, mockCdp);

    const { run, formatVerdict } = await importRunCase();
    const v = await run('08000004', { mode: 'auto', enrich: 'none', noPdf: true, cdp: mockCdp });

    assert.equal(v.status, 'blocked');
    assert.match(v.reason, /no chatter feed articles/i);
    assert.ok(Array.isArray(v.diagnostics));
    assert.equal(v.screenshot, 'feed_missing.png');
    assert.ok(screenshotCalls.some(p => p.endsWith('feed_missing.png')));

    const formatted = formatVerdict('08000004', v, Date.now() - 100);
    assert.equal(formatted.status, 'blocked');
    assert.equal(formatted.screenshot, 'feed_missing.png');
  });

  it('coordinates switching to Detail tab to extract metadata and merging with Feed comments', async (t) => {
    const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854';
    const mockCdp = {
      isConnected: () => true,
      navigate: async () => {},
      eval: async () => ({
        state: 'ON_CASE',
        href: targetUrl,
        fields: { title: 'VoNR Handover Issue' },
      }),
      click: async () => true,
      close: async () => {},
    };

    let extractCallCount = 0;
    mockBrowser(t, (file, vars) => {
      if (file === 'switch_tab.js') {
        return { ok: true, clicked: true, tab: vars?.__TARGET_TAB };
      }
      if (file === 'expand_step.js') {
        if (vars?.__PROBE) return { articles: 2, displayed: 2, anchorIdx: -1, top: { author: 'Mai Ngoc', bodyStart: 'Initial' } };
        return { clickedExpand: 0, clickedViewMore: 0, clickedDescription: 0, remainingExpand: 0 };
      }
      if (file === 'check_collapsed.js') {
        return { stillCollapsed: 0, stillHasMoreComments: 0 };
      }
      if (file === 'extract_case.js') {
        extractCallCount++;
        if (extractCallCount === 1) {
          // First call: Detail tab metadata extraction
          return {
            caseNumber: '08603854',
            title: 'VoNR Handover Issue',
            contactName: 'Mai Ngoc',
            customerProject: 'VinFast VF9 MY26',
            openedAt: 'August 10, 2026 at 09:30 AM',
            closedAt: 'August 20, 2026 at 04:15 PM',
            accountName: 'VinFast Auto LLC',
            relatedCRs: 'CR3798678',
            caseRecordType: 'Customer Support',
            description: 'VoNR call drops during 5G SA.',
            status: 'Closed',
            priority: '1 - Critical',
            url: targetUrl,
            comments: [],
          };
        }
        // Second call: Feed tab comments extraction
        return {
          caseNumber: '08603854',
          title: 'VoNR Handover Issue',
          url: targetUrl,
          comments: [
            { author: 'Mai Ngoc', body: 'Initial problem details', timestamp: 'August 10, 2026' },
            { author: 'Qualcomm Support', body: 'Investigating issue', timestamp: 'August 11, 2026' },
          ],
        };
      }
      throw new Error(`Unexpected evalFile: ${file}`);
    }, mockCdp);

    mkdirSync(join(process.env.QUALCOMM_ROOT, 'data', 'cases', '08603854'), { recursive: true });
    const { run } = await importRunCase();
    const v = await run('08603854', { mode: 'auto', cdp: mockCdp });

    assert.equal(v.status, 'created');
    assert.equal(v.verified, true);

    const caseData = JSON.parse(readFileSync(v.casePath, 'utf8'));
    assert.equal(caseData.contactName, 'Mai Ngoc');
    assert.equal(caseData.customerProject, 'VinFast VF9 MY26');
    assert.equal(caseData.openedAt, 'August 10, 2026 at 09:30 AM');
    assert.equal(caseData.closedAt, 'August 20, 2026 at 04:15 PM');
    assert.equal(caseData.accountName, 'VinFast Auto LLC');
    assert.equal(caseData.relatedCRs, 'CR3798678');
    assert.equal(caseData.caseRecordType, 'Customer Support');
    assert.equal(caseData.description, 'VoNR call drops during 5G SA.');
  });
});
