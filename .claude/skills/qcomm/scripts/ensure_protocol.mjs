#!/usr/bin/env node
// .claude/skills/qcomm/scripts/ensure_protocol.mjs
// Core Self-Healing Protocol Engine for Qualcomm Case Agent (`qc://`).
// Zero external dependencies — runs directly in standard Node.js (>=22.3.0).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const REGISTER_SCRIPT = join(HERE, 'register_protocol.ps1');

const DEFAULT_REG_KEY = 'HKCU:\\Software\\Classes\\qc';

/**
 * Normalize registry key path between PowerShell format (HKCU:\...) and reg.exe format (HKCU\...).
 * @param {string} keyPath
 * @param {'reg'|'ps'} targetFormat
 * @returns {string}
 */
function normalizeKeyPath(keyPath, targetFormat = 'reg') {
  const clean = String(keyPath || DEFAULT_REG_KEY).trim();
  if (targetFormat === 'reg') {
    return clean.replace(/^HKCU:\\/i, 'HKCU\\').replace(/^HKEY_CURRENT_USER:\\/i, 'HKEY_CURRENT_USER\\');
  }
  // PowerShell format (needs colon)
  if (!clean.includes(':\\') && !clean.includes(':/')) {
    return clean.replace(/^(HKCU|HKEY_CURRENT_USER)\\?/i, '$1:\\');
  }
  return clean;
}

/**
 * Checks if the qc:// custom URL protocol scheme is registered in Windows Registry.
 * @param {object} [options]
 * @param {string} [options.keyPath] - Registry key path (default: HKCU:\Software\Classes\qc)
 * @param {string} [options.platform] - OS platform (default: process.platform)
 * @returns {boolean}
 */
export function isProtocolRegistered(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return false;
  }

  const keyPath = normalizeKeyPath(options.keyPath || DEFAULT_REG_KEY, 'reg');
  const cmdKeyPath = `${keyPath}\\shell\\open\\command`;

  try {
    const res = spawnSync('reg.exe', ['query', cmdKeyPath, '/ve'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Ensures the qc:// custom URL protocol scheme is registered.
 * If missing on Windows, silently registers it via register_protocol.ps1.
 * On macOS/Linux, returns a clean no-op result.
 *
 * @param {object} [options]
 * @param {string} [options.keyPath] - Registry key path (default: HKCU:\Software\Classes\qc)
 * @param {string} [options.platform] - OS platform (default: process.platform)
 * @param {boolean} [options.silent] - Suppress informational logs (default: true)
 * @param {string} [options.scriptPath] - Custom path to register_protocol.ps1
 * @returns {{ ok: boolean, registered: boolean, changed: boolean, skipped?: boolean, error?: string }}
 */
export function ensureProtocolRegistered(options = {}) {
  const platform = options.platform || process.platform;
  const silent = options.silent !== false;

  if (platform !== 'win32') {
    return {
      ok: true,
      registered: false,
      changed: false,
      skipped: true,
      reason: 'unsupported-platform',
    };
  }

  const keyPath = options.keyPath || DEFAULT_REG_KEY;

  if (isProtocolRegistered({ keyPath, platform })) {
    if (!silent) {
      console.log(`[QC Protocol] Protocol handler is already registered in ${keyPath}`);
    }
    return {
      ok: true,
      registered: true,
      changed: false,
    };
  }

  // Not registered: self-heal by invoking register_protocol.ps1
  const scriptPath = options.scriptPath || REGISTER_SCRIPT;
  const psKeyPath = normalizeKeyPath(keyPath, 'ps');

  if (!existsSync(scriptPath)) {
    const err = `Registration script not found at ${scriptPath}`;
    if (!silent) {
      console.error(`[QC Protocol Error] ${err}`);
    }
    return {
      ok: false,
      registered: false,
      changed: false,
      error: err,
    };
  }

  try {
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-KeyPath',
        psKeyPath,
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000,
      }
    );

    if (res.status === 0) {
      if (!silent) {
        console.log(`[QC Protocol] Successfully registered protocol handler in ${keyPath}`);
      }
      return {
        ok: true,
        registered: true,
        changed: true,
      };
    }

    const errorMsg = (res.stderr || res.stdout || 'Unknown PowerShell registration failure').trim();
    if (!silent) {
      console.error(`[QC Protocol Error] Registration failed: ${errorMsg}`);
    }
    return {
      ok: false,
      registered: false,
      changed: false,
      error: errorMsg,
    };
  } catch (err) {
    if (!silent) {
      console.error(`[QC Protocol Error] Execution error: ${err.message}`);
    }
    return {
      ok: false,
      registered: false,
      changed: false,
      error: err.message,
    };
  }
}

// Standalone CLI execution (e.g. invoked via npm postinstall)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = ensureProtocolRegistered({ silent: false });
  if (!result.ok && !result.skipped) {
    process.exit(1);
  }
  process.exit(0);
}
