// secret_store.mjs — DPAPI secret store for Qualcomm ID password (issue #126).
//
// Reads and clears DPAPI-encrypted password stored in data/.secrets/qid.bin.
// Never logs, echoes, or returns the password anywhere except direct return.

import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { SECRET_PATH } from './_paths.mjs';

/**
 * Decrypt and return the stored Qualcomm ID password, or null if missing/failed.
 *
 * @param {string} [secretPath=SECRET_PATH]
 * @returns {string|null} Plaintext password, or null if missing or decryption fails.
 */
export function readPassword(secretPath = SECRET_PATH) {
  if (!secretPath || !existsSync(secretPath)) {
    return null;
  }

  const escapedPath = secretPath.replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName System.Security; $enc = [IO.File]::ReadAllBytes('${escapedPath}'); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))`;

  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 10000,
  });

  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
    return null;
  }

  return r.stdout;
}

/**
 * Delete the stored secret file (idempotent no-op if already missing).
 *
 * @param {string} [secretPath=SECRET_PATH]
 */
export function clearSecret(secretPath = SECRET_PATH) {
  if (!secretPath) return;
  try {
    if (existsSync(secretPath)) {
      unlinkSync(secretPath);
    }
  } catch {
    // Idempotent: ignore if already removed or vanished
  }
}
