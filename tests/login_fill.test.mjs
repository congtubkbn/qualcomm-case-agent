// tests/login_fill.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, stripComments } from '../.claude/skills/qualcomm-case-agent/scripts/browser.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../.claude/skills/qualcomm-case-agent/scripts/login_fill.js');
const rawSrc = readFileSync(SCRIPT_PATH, 'utf8');

test('login_fill page script', async (t) => {
  await t.test('script loads, parses, and strips comments properly', () => {
    const stripped = stripComments(rawSrc);
    assert.ok(stripped.length > 0);
    assert.ok(!stripped.includes('// scripts/login_fill.js'));
    assert.ok(stripped.includes('classifyCurrentState'));
  });

  await t.test('buildPayload wraps login_fill.js in IIFE with injected variables', () => {
    const payload = buildPayload(rawSrc, {
      __PASSWORD: 'TestPassword123',
      __USERNAME: 'test.user@samsung.com',
      __TIMEOUT: 5000,
    });

    assert.ok(payload.startsWith('(function(){'));
    assert.ok(payload.includes('var __PASSWORD = "TestPassword123";'));
    assert.ok(payload.includes('var __USERNAME = "test.user@samsung.com";'));
    assert.ok(payload.includes('var __TIMEOUT = 5000;'));
  });

  await t.test('evaluates in Node vm with mock browser DOM globals', async () => {
    const vm = await import('node:vm');

    function createMockDom(options = {}) {
      const {
        hostname = 'account.qualcomm.com',
        pathname = '/login',
        bodyText = '',
        elements = [],
      } = options;

      const listeners = new Map();

      class MockElement {
        constructor(tag, attrs = {}) {
          this.tagName = tag.toUpperCase();
          this.attrs = attrs;
          this.value = attrs.value || '';
          this.form = null;
          this.clicked = false;
        }
        getAttribute(name) { return this.attrs[name]; }
        querySelector(sel) { return null; }
        querySelectorAll(sel) { return []; }
        focus() {}
        click() { this.clicked = true; }
        dispatchEvent(evt) {}
      }

      const docElements = elements.map(e => new MockElement(e.tag, e.attrs));

      const mockDocument = {
        title: 'Qualcomm Login',
        body: {
          innerText: bodyText,
          textContent: bodyText,
        },
        querySelector: (sel) => {
          if (sel.includes('input[type="password"]')) {
            return docElements.find(e => e.attrs.type === 'password') || null;
          }
          if (sel.includes('input[name="identifier"]')) {
            return docElements.find(e => e.attrs.name === 'identifier') || null;
          }
          if (sel.includes('submit')) {
            return docElements.find(e => e.attrs.type === 'submit') || null;
          }
          return null;
        },
        querySelectorAll: (sel) => {
          if (sel.includes('.okta-form-infobox-error')) {
            return docElements.filter(e => e.attrs.className?.includes('error'));
          }
          return [];
        },
      };

      const mockWindow = {
        location: { hostname, pathname, href: `https://${hostname}${pathname}` },
        document: mockDocument,
        Event: class Event { constructor(type) { this.type = type; } },
        setTimeout,
        clearTimeout,
        Date,
        Promise,
      };

      return mockWindow;
    }

    // 1. Authenticated host
    const authContext = createMockDom({ hostname: 'support.qualcomm.com', pathname: '/s/' });
    vm.createContext(authContext);
    const authPayload = buildPayload(rawSrc, { __PASSWORD: 'Pass' });
    const authResult = await vm.runInContext(authPayload, authContext);
    assert.equal(authResult.outcome, 'AUTHENTICATED');

    // 2. Rejected via error body text
    const rejectContext = createMockDom({
      hostname: 'account.qualcomm.com',
      bodyText: 'Unable to sign in. Check your username and password.',
    });
    vm.createContext(rejectContext);
    const rejectPayload = buildPayload(rawSrc, { __PASSWORD: 'Wrong' });
    const rejectResult = await vm.runInContext(rejectPayload, rejectContext);
    assert.equal(rejectResult.outcome, 'REJECTED');

    // 3. OTP required text
    const otpContext = createMockDom({
      hostname: 'account.qualcomm.com',
      bodyText: 'Enter a verification code sent to your email',
    });
    vm.createContext(otpContext);
    const otpPayload = buildPayload(rawSrc, { __PASSWORD: 'Valid' });
    const otpResult = await vm.runInContext(otpPayload, otpContext);
    assert.equal(otpResult.outcome, 'OTP_REQUIRED');

    // 4. Missing password argument
    const noPwContext = createMockDom({ hostname: 'account.qualcomm.com' });
    vm.createContext(noPwContext);
    const noPwPayload = buildPayload(rawSrc, {});
    const noPwResult = await vm.runInContext(noPwPayload, noPwContext);
    assert.equal(noPwResult.outcome, 'UNKNOWN');
  });
});
