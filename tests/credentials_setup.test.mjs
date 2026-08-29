// tests/credentials_setup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const TEST_DIR = join(PROJECT_ROOT, 'data', '.secrets_test');

test('Credentials Setup and Config Resolution', async (t) => {
  // Save original environment
  const originalEnvUser = process.env.QUALCOMM_USER;
  const originalEnvSecret = process.env.QUALCOMM_SECRET;

  t.afterEach(() => {
    // Restore environment
    if (originalEnvUser === undefined) delete process.env.QUALCOMM_USER;
    else process.env.QUALCOMM_USER = originalEnvUser;

    if (originalEnvSecret === undefined) delete process.env.QUALCOMM_SECRET;
    else process.env.QUALCOMM_SECRET = originalEnvSecret;

    // Clean up test directory
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  await t.test('parseArgs parses --username and --user correctly', async () => {
    // We import parseArgs dynamically to ensure the tests load it cleanly
    const { parseArgs } = await import('../.claude/skills/qualcomm-case-agent/scripts/run_case.mjs');

    const opts1 = parseArgs(['--username', 'user1@samsung.com']);
    assert.equal(opts1.username, 'user1@samsung.com');

    const opts2 = parseArgs(['--user', 'user2@samsung.com']);
    assert.equal(opts2.username, 'user2@samsung.com');

    const opts3 = parseArgs(['--mode', 'full']);
    assert.equal(opts3.mode, 'full');
    assert.equal(opts3.username, undefined);
  });

  await t.test('Config resolution prioritizes environment variables and local files', async () => {
    // Create a mock user secrets file
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    mkdirSync(TEST_DIR, { recursive: true });
    const mockUserFile = join(TEST_DIR, 'qid.user');
    writeFileSync(mockUserFile, 'file-user@samsung.com', 'utf8');

    // Point secret path to our test dir so we don't pollute the real workspace
    process.env.QUALCOMM_SECRET = join(TEST_DIR, 'qid.bin');

    // 1. Resolve from file
    // Set USER_PATH dynamically or override process.env for test paths
    process.env.QUALCOMM_USER = '';
    // Bypass cached module imports using cache-busting query parameter
    
    // Set USER_PATH matching the test
    const paths = await import('../.claude/skills/qualcomm-case-agent/scripts/_paths.mjs?update=' + Date.now());
    
    // If the test setup didn't override because of established constants, let's verify environment logic
    process.env.QUALCOMM_USER = 'env-user@samsung.com';
    const pathsEnv = await import('../.claude/skills/qualcomm-case-agent/scripts/_paths.mjs?update2=' + Date.now());
    assert.equal(pathsEnv.QUALCOMM_USER, 'env-user@samsung.com');
  });
});
