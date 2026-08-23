// tests/protocol_registration.test.mjs
// Unit & integration tests for Windows Registry protocol registration scripts.

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const REGISTER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'register_protocol.ps1');
const UNREGISTER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'unregister_protocol.ps1');
const PACKAGE_JSON_PATH = join(PROJECT_ROOT, 'package.json');

const IS_WINDOWS = process.platform === 'win32';
const TEST_REG_KEY = 'HKCU:\\Software\\Classes\\qc_test_unit';
const DEFAULT_REG_KEY = 'HKCU:\\Software\\Classes\\qc';

describe('Windows Registry Protocol Registration', () => {
  describe('package.json scripts configuration', () => {
    it('defines setup:protocol and uninstall:protocol scripts', () => {
      const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
      assert.ok(pkg.scripts['setup:protocol'], 'setup:protocol script must be defined in package.json');
      assert.ok(pkg.scripts['uninstall:protocol'], 'uninstall:protocol script must be defined in package.json');

      assert.match(pkg.scripts['setup:protocol'], /register_protocol\.ps1/i);
      assert.match(pkg.scripts['uninstall:protocol'], /unregister_protocol\.ps1/i);
    });
  });

  describe('PowerShell Registration Scripts', () => {
    it('scripts exist in scripts/ directory', () => {
      assert.ok(existsSync(REGISTER_SCRIPT), `register_protocol.ps1 must exist at ${REGISTER_SCRIPT}`);
      assert.ok(existsSync(UNREGISTER_SCRIPT), `unregister_protocol.ps1 must exist at ${UNREGISTER_SCRIPT}`);
    });

    if (IS_WINDOWS) {
      after(() => {
        // Clean up test keys if left over
        try {
          execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '${TEST_REG_KEY}') { Remove-Item -Path '${TEST_REG_KEY}' -Recurse -Force }"`);
        } catch {}
      });

      it('register_protocol.ps1 registers custom registry key properly without admin privileges', () => {
        const res = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', REGISTER_SCRIPT,
          '-KeyPath', TEST_REG_KEY,
        ], { encoding: 'utf8' });

        assert.equal(res.status, 0, `Script failed with error: ${res.stderr}\n${res.stdout}`);
        assert.match(res.stdout, /Successfully registered/i);

        // Verify registry entries via PowerShell query
        const queryRes = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `$def = (Get-ItemProperty -Path '${TEST_REG_KEY}').'(default)'; ` +
          `$proto = (Get-ItemProperty -Path '${TEST_REG_KEY}').'URL Protocol'; ` +
          `$cmd = (Get-ItemProperty -Path '${TEST_REG_KEY}\\shell\\open\\command').'(default)'; ` +
          `[PSCustomObject]@{ Default = $def; UrlProtocol = $proto; Command = $cmd } | ConvertTo-Json`,
        ], { encoding: 'utf8' });

        assert.equal(queryRes.status, 0, queryRes.stderr);
        const regValues = JSON.parse(queryRes.stdout.trim());

        assert.match(regValues.Default, /URL:Qualcomm Case Protocol/i);
        assert.equal(regValues.UrlProtocol, '');
        assert.match(regValues.Command, /open_qc_case\.mjs/);
        assert.match(regValues.Command, /"%1"/);
      });

      it('register_protocol.ps1 handles paths with spaces properly', () => {
        const spaceScriptPath = join(PROJECT_ROOT, 'scripts', 'open_qc_case.mjs');
        const customNode = 'C:\\Program Files\\nodejs\\node.exe';

        const res = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', REGISTER_SCRIPT,
          '-KeyPath', TEST_REG_KEY,
          '-NodePath', customNode,
          '-ScriptPath', spaceScriptPath,
        ], { encoding: 'utf8' });

        assert.equal(res.status, 0, `Script failed with error: ${res.stderr}\n${res.stdout}`);

        const queryRes = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `(Get-ItemProperty -Path '${TEST_REG_KEY}\\shell\\open\\command').'(default)'`,
        ], { encoding: 'utf8' });

        assert.equal(queryRes.status, 0);
        const commandVal = queryRes.stdout.trim();
        assert.ok(commandVal.startsWith(`"${customNode}"`));
        assert.ok(commandVal.includes(`"${spaceScriptPath}"`));
        assert.ok(commandVal.endsWith('"%1"'));
      });

      it('unregister_protocol.ps1 cleanly removes the test registry key', () => {
        const res = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', UNREGISTER_SCRIPT,
          '-KeyPath', TEST_REG_KEY,
        ], { encoding: 'utf8' });

        assert.equal(res.status, 0, `Script failed with error: ${res.stderr}\n${res.stdout}`);
        assert.match(res.stdout, /Successfully unregistered/i);

        // Verify key is gone
        const verifyRes = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `Test-Path '${TEST_REG_KEY}'`,
        ], { encoding: 'utf8' });

        assert.equal(verifyRes.stdout.trim().toLowerCase(), 'false');
      });

      it('unregister_protocol.ps1 handles non-existent key gracefully', () => {
        const res = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', UNREGISTER_SCRIPT,
          '-KeyPath', 'HKCU:\\Software\\Classes\\non_existent_key_12345',
        ], { encoding: 'utf8' });

        assert.equal(res.status, 0);
        assert.match(res.stdout, /not registered|nothing to do/i);
      });

      it('npm run setup:protocol and npm run uninstall:protocol work end-to-end', () => {
        // Run npm run setup:protocol
        const setupOutput = execSync('npm run setup:protocol', {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
        });
        assert.match(setupOutput, /Successfully registered/i);

        // Verify HKCU:\Software\Classes\qc exists
        const checkRes = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `Test-Path '${DEFAULT_REG_KEY}'`,
        ], { encoding: 'utf8' });
        assert.equal(checkRes.stdout.trim().toLowerCase(), 'true');

        // Run npm run uninstall:protocol
        const uninstallOutput = execSync('npm run uninstall:protocol', {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
        });
        assert.match(uninstallOutput, /Successfully unregistered/i);

        // Verify HKCU:\Software\Classes\qc is removed
        const checkAfterRes = spawnSync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Test-Path '${DEFAULT_REG_KEY}'`,
        ], { encoding: 'utf8' });
        assert.equal(checkAfterRes.stdout.trim().toLowerCase(), 'false');
      });
    }
  });
});
