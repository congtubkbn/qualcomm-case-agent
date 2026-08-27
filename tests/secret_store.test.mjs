// Tests for secret_store.mjs (DPAPI secret store, issue #126).
//
// Verifies readPassword() and clearSecret() behavior:
// - Missing file -> returns null, never spawns a subprocess
// - Existing file -> calls powershell to decrypt via DPAPI, returns plaintext
// - Subprocess failure -> returns null
// - clearSecret() -> deletes file, idempotent when missing
//
// Run:
//     node --experimental-test-module-mocks --test tests/secret_store.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-secret-store-'));
process.env.QUALCOMM_ROOT = QUALCOMM_ROOT;

const SCRIPTS = new URL('../.claude/skills/qualcomm-case-agent/scripts/', import.meta.url);

let seq = 0;
const importSecretStore = () => import(new URL(`secret_store.mjs?t=${++seq}`, SCRIPTS));

function mockSpawnSync(t, { stdout = '', stderr = '', status = 0, error = null } = {}) {
  const calls = [];
  t.mock.module('node:child_process', {
    exports: {
      spawnSync: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { stdout, stderr, status, error };
      },
    },
  });
  return calls;
}

describe('secret_store — readPassword', () => {
  it('returns null when the secret file is missing and does not spawn a subprocess', async (t) => {
    const calls = mockSpawnSync(t, { stdout: 'should-not-be-called' });
    const { readPassword } = await importSecretStore();

    const missingPath = join(QUALCOMM_ROOT, 'data', '.secrets', 'non_existent.bin');
    const result = readPassword(missingPath);

    assert.equal(result, null);
    assert.equal(calls.length, 0, 'must not spawn subprocess when file is missing');
  });

  it('returns plaintext decrypted password when secret file exists', async (t) => {
    const secretsDir = join(QUALCOMM_ROOT, 'data', '.secrets');
    mkdirSync(secretsDir, { recursive: true });
    const secretFile = join(secretsDir, 'qid.bin');
    writeFileSync(secretFile, Buffer.from([1, 2, 3, 4]));

    const calls = mockSpawnSync(t, { stdout: 'mySecretPass123', status: 0 });
    const { readPassword } = await importSecretStore();

    const result = readPassword(secretFile);

    assert.equal(result, 'mySecretPass123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell');
    assert.ok(calls[0].args.some(a => a.includes('ProtectedData') || a.includes('Unprotect')));
  });

  it('returns null when powershell decrypt process fails', async (t) => {
    const secretsDir = join(QUALCOMM_ROOT, 'data', '.secrets');
    mkdirSync(secretsDir, { recursive: true });
    const secretFile = join(secretsDir, 'qid_corrupt.bin');
    writeFileSync(secretFile, Buffer.from([255, 255]));

    const calls = mockSpawnSync(t, { stdout: '', stderr: 'Decryption failed', status: 1 });
    const { readPassword } = await importSecretStore();

    const result = readPassword(secretFile);

    assert.equal(result, null);
    assert.equal(calls.length, 1);
  });

  it('uses default SECRET_PATH when no path is provided', async (t) => {
    const secretsDir = join(QUALCOMM_ROOT, 'data', '.secrets');
    mkdirSync(secretsDir, { recursive: true });
    const defaultSecretFile = join(secretsDir, 'qid.bin');
    writeFileSync(defaultSecretFile, Buffer.from([1, 2, 3]));

    const calls = mockSpawnSync(t, { stdout: 'defaultPathPass', status: 0 });
    const { readPassword } = await importSecretStore();

    const result = readPassword();
    assert.equal(result, 'defaultPathPass');
    assert.equal(calls.length, 1);
  });

  it('returns null when path is null or undefined and no file exists', async (t) => {
    const calls = mockSpawnSync(t);
    const { readPassword } = await importSecretStore();
    assert.equal(readPassword(null), null);
    assert.equal(readPassword(''), null);
    assert.equal(calls.length, 0);
  });
});

describe('secret_store — clearSecret', () => {
  it('deletes the secret file when it exists', async () => {
    const secretsDir = join(QUALCOMM_ROOT, 'data', '.secrets');
    mkdirSync(secretsDir, { recursive: true });
    const secretFile = join(secretsDir, 'to_delete.bin');
    writeFileSync(secretFile, Buffer.from([1, 2, 3]));
    assert.equal(existsSync(secretFile), true);

    const { clearSecret } = await importSecretStore();
    clearSecret(secretFile);

    assert.equal(existsSync(secretFile), false);
  });

  it('clears default SECRET_PATH when no argument is given', async () => {
    const secretsDir = join(QUALCOMM_ROOT, 'data', '.secrets');
    mkdirSync(secretsDir, { recursive: true });
    const defaultSecretFile = join(secretsDir, 'qid.bin');
    writeFileSync(defaultSecretFile, Buffer.from([1, 2, 3]));
    assert.equal(existsSync(defaultSecretFile), true);

    const { clearSecret } = await importSecretStore();
    clearSecret();

    assert.equal(existsSync(defaultSecretFile), false);
  });

  it('is a no-op when the secret file is already gone or path is falsy', async () => {
    const missingPath = join(QUALCOMM_ROOT, 'data', '.secrets', 'already_gone.bin');
    assert.equal(existsSync(missingPath), false);

    const { clearSecret } = await importSecretStore();
    assert.doesNotThrow(() => {
      clearSecret(missingPath);
      clearSecret(null);
      clearSecret('');
    });
  });
});
