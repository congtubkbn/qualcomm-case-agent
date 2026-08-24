// tests/open_qc_case.test.mjs
// Unit & integration tests for the qc:// custom protocol dispatcher.

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockCdpServer } from './mocks/cdp_server.mjs';

// We import the functions to be implemented in scripts/open_qc_case.mjs
const {
  parseQcUri,
  resolveTargetUrl,
  dispatchQcTarget,
  openQcCase,
  ensureCommunicationTabUrl,
} = await import(new URL('../scripts/open_qc_case.mjs', import.meta.url));

describe('qc:// Protocol Dispatcher (open_qc_case.mjs)', () => {
  let tempDir;
  let casesDir;
  let mockCdpServer;

  before(async () => {
    mockCdpServer = await createMockCdpServer();
  });

  after(async () => {
    if (mockCdpServer) await mockCdpServer.close();
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'qc-test-'));
    casesDir = join(tempDir, 'data', 'cases');
    mkdirSync(casesDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  describe('parseQcUri', () => {
    it('parses qc://case/<caseNumber> format', () => {
      const res = parseQcUri('qc://case/08603854');
      assert.deepEqual(res, { type: 'case', caseNumber: '08603854' });
    });

    it('parses qc://<caseNumber> shorthand format', () => {
      const res = parseQcUri('qc://08603854');
      assert.deepEqual(res, { type: 'case', caseNumber: '08603854' });
    });

    it('parses qc:case/<caseNumber> without double slashes', () => {
      const res = parseQcUri('qc:case/08603854');
      assert.deepEqual(res, { type: 'case', caseNumber: '08603854' });
    });

    it('parses qc:<caseNumber> shorthand without double slashes', () => {
      const res = parseQcUri('qc:08603854');
      assert.deepEqual(res, { type: 'case', caseNumber: '08603854' });
    });

    it('handles trailing slashes cleanly', () => {
      const res1 = parseQcUri('qc://case/08603854/');
      assert.deepEqual(res1, { type: 'case', caseNumber: '08603854' });

      const res2 = parseQcUri('qc://08603854/');
      assert.deepEqual(res2, { type: 'case', caseNumber: '08603854' });
    });

    it('parses qc://open?url=<encoded_url> format for valid Qualcomm domains', () => {
      const directUrl = 'https://support.qualcomm.com/s/case/5002000000abcde';
      const uri = `qc://open?url=${encodeURIComponent(directUrl)}`;
      const res = parseQcUri(uri);
      assert.deepEqual(res, { type: 'url', url: directUrl });
    });

    it('parses qc://open?url=<unencoded_url> format', () => {
      const directUrl = 'https://support.qualcomm.com/s/case/5002000000abcde';
      const uri = `qc://open?url=${directUrl}`;
      const res = parseQcUri(uri);
      assert.deepEqual(res, { type: 'url', url: directUrl });
    });

    it('rejects URLs outside of support.qualcomm.com domain', () => {
      assert.throws(() => {
        parseQcUri('qc://open?url=https://evil.com/phishing');
      }, /Unauthorized domain|Invalid Qualcomm URL/i);

      assert.throws(() => {
        parseQcUri('qc://open?url=https://attacker.qualcomm.com.evil.com');
      }, /Unauthorized domain|Invalid Qualcomm URL/i);
    });

    it('rejects unsafe schemes like javascript: or file:', () => {
      assert.throws(() => {
        parseQcUri('qc://open?url=javascript:alert(1)');
      }, /Invalid URL|Unauthorized domain/i);

      assert.throws(() => {
        parseQcUri('qc://open?url=file:///C:/Windows/System32');
      }, /Invalid URL|Unauthorized domain/i);
    });

    it('rejects invalid or non-qc URIs', () => {
      assert.throws(() => parseQcUri(''), /Invalid qc URI/i);
      assert.throws(() => parseQcUri('http://support.qualcomm.com'), /Invalid qc URI/i);
      assert.throws(() => parseQcUri('qc://'), /Invalid qc URI/i);
      assert.throws(() => parseQcUri('qc://case/'), /Invalid case number/i);
      assert.throws(() => parseQcUri('qc://open'), /Missing url parameter/i);
    });
  });

  describe('ensureCommunicationTabUrl', () => {
    it('rewrites tabset-XXXX=2 parameter to tabset-XXXX=1', () => {
      const url = 'https://support.qualcomm.com/s/case/500dK00000O6MRRQA3/foo?tabset-8baba=2';
      assert.equal(ensureCommunicationTabUrl(url), 'https://support.qualcomm.com/s/case/500dK00000O6MRRQA3/foo?tabset-8baba=1');
    });

    it('rewrites tabset-XXXX=3 parameter to tabset-XXXX=1', () => {
      const url = 'https://support.qualcomm.com/s/case/500dK00000O6MRRQA3/foo?tabset-7b221=3';
      assert.equal(ensureCommunicationTabUrl(url), 'https://support.qualcomm.com/s/case/500dK00000O6MRRQA3/foo?tabset-7b221=1');
    });

    it('leaves URL unchanged if it already uses tabset-XXXX=1', () => {
      const url = 'https://support.qualcomm.com/s/case/500dK00000O6MRRQA3/foo?tabset-8baba=1';
      assert.equal(ensureCommunicationTabUrl(url), url);
    });

    it('leaves non-tabset URLs unchanged', () => {
      const url = 'https://support.qualcomm.com/s/case/500dK00000O6MRRQA3/foo';
      assert.equal(ensureCommunicationTabUrl(url), url);
    });
  });

  describe('resolveTargetUrl', () => {
    it('returns direct URL when type is url and rewrites Detail tab parameter to Communication tab', () => {
      const directUrl = 'https://support.qualcomm.com/s/case/5002000000abcde?tabset-8baba=2';
      const url = resolveTargetUrl({ type: 'url', url: directUrl });
      assert.equal(url, 'https://support.qualcomm.com/s/case/5002000000abcde?tabset-8baba=1');
    });

    it('reads URL from cached case.json and rewrites tabset-XXXX=2 to tabset-XXXX=1', () => {
      const caseNumber = '08603854';
      const caseFolder = join(casesDir, caseNumber);
      mkdirSync(caseFolder, { recursive: true });
      const cachedUrl = 'https://support.qualcomm.com/s/case/5004W00002FkXYZ?tabset-8baba=2';
      writeFileSync(join(caseFolder, 'case.json'), JSON.stringify({
        caseNumber,
        url: cachedUrl,
        title: 'Test Case Title',
      }));

      const url = resolveTargetUrl({ type: 'case', caseNumber }, { casesDir });
      assert.equal(url, 'https://support.qualcomm.com/s/case/5004W00002FkXYZ?tabset-8baba=1');
    });

    it('falls back to global search URL when case.json is missing', () => {
      const caseNumber = '08603854';
      const url = resolveTargetUrl({ type: 'case', caseNumber }, { casesDir });
      assert.equal(url, `https://support.qualcomm.com/s/global-search/${caseNumber}`);
    });

    it('falls back to global search URL when case.json has no url property', () => {
      const caseNumber = '08603854';
      const caseFolder = join(casesDir, caseNumber);
      mkdirSync(caseFolder, { recursive: true });
      writeFileSync(join(caseFolder, 'case.json'), JSON.stringify({
        caseNumber,
        title: 'No URL in JSON',
      }));

      const url = resolveTargetUrl({ type: 'case', caseNumber }, { casesDir });
      assert.equal(url, `https://support.qualcomm.com/s/global-search/${caseNumber}`);
    });

    it('falls back to global search URL when case.json is corrupted JSON', () => {
      const caseNumber = '08603854';
      const caseFolder = join(casesDir, caseNumber);
      mkdirSync(caseFolder, { recursive: true });
      writeFileSync(join(caseFolder, 'case.json'), '{ malformed json');

      const url = resolveTargetUrl({ type: 'case', caseNumber }, { casesDir });
      assert.equal(url, `https://support.qualcomm.com/s/global-search/${caseNumber}`);
    });
  });

  describe('dispatchQcTarget', () => {
    it('navigates via CDP when Chrome is already running on port', async () => {
      const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002FkXYZ';
      let launchCalled = false;

      const result = await dispatchQcTarget(targetUrl, {
        port: mockCdpServer.port,
        host: '127.0.0.1',
        launchChromeFn: () => { launchCalled = true; },
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'cdp');
      assert.equal(result.targetUrl, targetUrl);
      assert.equal(launchCalled, false);
    });

    it('launches Chrome via launcher adapter when CDP port is dead', async () => {
      const targetUrl = 'https://support.qualcomm.com/s/case/5004W00002FkXYZ';
      let launchedWithUrl = null;

      // Pick an unused port where no server is listening
      const deadPort = 59123;

      const result = await dispatchQcTarget(targetUrl, {
        port: deadPort,
        host: '127.0.0.1',
        launchChromeFn: ({ url, port }) => {
          launchedWithUrl = { url, port };
          return { status: 0 };
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'launch');
      assert.equal(result.targetUrl, targetUrl);
      assert.deepEqual(launchedWithUrl, { url: targetUrl, port: deadPort });
    });
  });

  describe('openQcCase (End-to-End Orchestrator)', () => {
    it('orchestrates opening case with cached URL via active CDP', async () => {
      const caseNumber = '08603854';
      const caseFolder = join(casesDir, caseNumber);
      mkdirSync(caseFolder, { recursive: true });
      const cachedUrl = 'https://support.qualcomm.com/s/case/5004W00002FkXYZ';
      writeFileSync(join(caseFolder, 'case.json'), JSON.stringify({
        caseNumber,
        url: cachedUrl,
      }));

      const result = await openQcCase(`qc://case/${caseNumber}`, {
        port: mockCdpServer.port,
        casesDir,
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'cdp');
      assert.equal(result.targetUrl, cachedUrl);
    });

    it('orchestrates opening case with search URL when not cached via active CDP', async () => {
      const caseNumber = '08999999';
      const result = await openQcCase(`qc://${caseNumber}`, {
        port: mockCdpServer.port,
        casesDir,
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'cdp');
      assert.equal(result.targetUrl, `https://support.qualcomm.com/s/global-search/${caseNumber}`);
    });

    it('orchestrates opening direct url via qc://open?url=...', async () => {
      const directUrl = 'https://support.qualcomm.com/s/case/08603854';
      const result = await openQcCase(`qc://open?url=${encodeURIComponent(directUrl)}`, {
        port: mockCdpServer.port,
        casesDir,
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'cdp');
      assert.equal(result.targetUrl, directUrl);
    });

    it('handles launch when Chrome is closed', async () => {
      const caseNumber = '08603854';
      let launchArgs = null;

      const result = await openQcCase(`qc://case/${caseNumber}`, {
        port: 59124,
        casesDir,
        launchChromeFn: (args) => {
          launchArgs = args;
          return { status: 0 };
        },
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'launch');
      assert.equal(result.targetUrl, `https://support.qualcomm.com/s/global-search/${caseNumber}`);
      assert.ok(launchArgs);
      assert.equal(launchArgs.url, `https://support.qualcomm.com/s/global-search/${caseNumber}`);
    });

    it('returns structured error object on invalid input when throwOnError is false', async () => {
      const result = await openQcCase('invalid://not-qc', { throwOnError: false });
      assert.equal(result.success, false);
      assert.ok(result.error);
    });
  });
});
