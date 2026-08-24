// tests/ensure_protocol.test.mjs
// Unit and integration tests for scripts/ensure_protocol.mjs (Self-Healing Protocol Engine).

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isProtocolRegistered,
  ensureProtocolRegistered,
} from '../scripts/ensure_protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const ENSURE_SCRIPT = join(PROJECT_ROOT, 'scripts', 'ensure_protocol.mjs');
const UNREGISTER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'unregister_protocol.ps1');
const PACKAGE_JSON_PATH = join(PROJECT_ROOT, 'package.json');

const IS_WINDOWS = process.platform === 'win32';
const TEST_REG_KEY = 'HKCU:\\Software\\Classes\\qc_ensure_test';

describe('ensure_protocol.mjs — Core Self-Healing Protocol Engine', () => {
  describe('package.json postinstall hook', () => {
    it('has postinstall script configured in package.json', () => {
      const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
      assert.ok(pkg.scripts.postinstall, 'package.json must contain postinstall script');
      assert.match(pkg.scripts.postinstall, /ensure_protocol\.mjs/);
    });
  });

  describe('Non-Windows platform safety', () => {
    it('isProtocolRegistered returns false on non-windows platform', () => {
      assert.equal(isProtocolRegistered({ platform: 'linux' }), false);
      assert.equal(isProtocolRegistered({ platform: 'darwin' }), false);
    });

    it('ensureProtocolRegistered is a clean no-op on non-windows platform', () => {
      const resLinux = ensureProtocolRegistered({ platform: 'linux' });
      assert.equal(resLinux.ok, true);
      assert.equal(resLinux.registered, false);
      assert.equal(resLinux.changed, false);
      assert.equal(resLinux.skipped, true);

      const resDarwin = ensureProtocolRegistered({ platform: 'darwin' });
      assert.equal(resDarwin.ok, true);
      assert.equal(resDarwin.registered, false);
      assert.equal(resDarwin.changed, false);
      assert.equal(resDarwin.skipped, true);
    });
  });

  describe('Windows platform registry detection and self-healing', () => {
    if (!IS_WINDOWS) {
      it('skips Windows-specific registry tests on non-Windows', () => {
        assert.ok(true);
      });
      return;
    }

    const cleanupTestKey = () => {
      try {
        spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', UNREGISTER_SCRIPT,
          '-KeyPath', TEST_REG_KEY,
        ]);
      } catch {}
    };

    before(cleanupTestKey);
    after(cleanupTestKey);

    it('detects un-registered protocol key correctly', () => {
      cleanupTestKey();
      const registered = isProtocolRegistered({ keyPath: TEST_REG_KEY });
      assert.equal(registered, false);
    });

    it('self-heals missing protocol by registering it when ensureProtocolRegistered is called', () => {
      cleanupTestKey();
      assert.equal(isProtocolRegistered({ keyPath: TEST_REG_KEY }), false);

      const result = ensureProtocolRegistered({ keyPath: TEST_REG_KEY, silent: true });
      assert.equal(result.ok, true);
      assert.equal(result.registered, true);
      assert.equal(result.changed, true);

      // Verify it is now registered
      assert.equal(isProtocolRegistered({ keyPath: TEST_REG_KEY }), true);
    });

    it('is idempotent and reports changed: false when already registered', () => {
      // Key should be registered from previous test
      assert.equal(isProtocolRegistered({ keyPath: TEST_REG_KEY }), true);

      const secondResult = ensureProtocolRegistered({ keyPath: TEST_REG_KEY, silent: true });
      assert.equal(secondResult.ok, true);
      assert.equal(secondResult.registered, true);
      assert.equal(secondResult.changed, false);
    });

    it('handles missing registration script gracefully and returns ok: false', () => {
      cleanupTestKey();
      const nonExistentScript = join(PROJECT_ROOT, 'scripts', 'non_existent_register_script.ps1');
      const result = ensureProtocolRegistered({
        keyPath: TEST_REG_KEY,
        scriptPath: nonExistentScript,
        silent: true,
      });

      assert.equal(result.ok, false);
      assert.equal(result.registered, false);
      assert.equal(result.changed, false);
      assert.match(result.error, /Registration script not found/i);
    });

    it('can be run directly via CLI node scripts/ensure_protocol.mjs', () => {
      const res = spawnSync(process.execPath, [ENSURE_SCRIPT], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `CLI execution failed: ${res.stderr}\n${res.stdout}`);
    });

    it('restores default qc:// protocol handler if missing', () => {
      const result = ensureProtocolRegistered({ silent: true });
      assert.equal(result.ok, true);
      assert.equal(result.registered, true);
      assert.equal(isProtocolRegistered(), true);
    });
  });
});

