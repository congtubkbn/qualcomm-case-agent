// tests/guard_secrets.test.mjs — pre-commit guard: staged secrets/session paths must be refused.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findForbiddenStagedPaths } from '../tools/guard_secrets.mjs';

describe('findForbiddenStagedPaths', () => {
  it('returns empty for an empty staging list', () => {
    assert.deepEqual(findForbiddenStagedPaths([]), []);
  });

  it('flags a file under the DPAPI secrets directory', () => {
    const result = findForbiddenStagedPaths(['data/.secrets/qualcomm.token']);
    assert.deepEqual(result, ['data/.secrets/qualcomm.token']);
  });

  it('flags a file under the Chrome profile directory', () => {
    const result = findForbiddenStagedPaths(['data/chrome-profile/Default/Cookies']);
    assert.deepEqual(result, ['data/chrome-profile/Default/Cookies']);
  });

  it('flags a file under a Chrome profile directory nested anywhere (e.g. assets/)', () => {
    const result = findForbiddenStagedPaths(['assets/chrome-profile/Default/Cookies']);
    assert.deepEqual(result, ['assets/chrome-profile/Default/Cookies']);
  });

  it('flags a session JSON file', () => {
    const result = findForbiddenStagedPaths(['data/qualcomm-session.json']);
    assert.deepEqual(result, ['data/qualcomm-session.json']);
  });

  it('flags a session JSON file matched via the *.session.json convention', () => {
    const result = findForbiddenStagedPaths(['data/foo.session.json']);
    assert.deepEqual(result, ['data/foo.session.json']);
  });

  it('leaves a normal source file untouched', () => {
    assert.deepEqual(findForbiddenStagedPaths(['tools/gen_design.mjs']), []);
  });

  it('leaves a normal case file untouched', () => {
    assert.deepEqual(findForbiddenStagedPaths(['data/cases/08603854/case.json']), []);
  });

  it('does not flag a near-miss path whose name merely contains "session"', () => {
    const result = findForbiddenStagedPaths([
      'docs/session-notes.md',
      'tests/session_report.test.mjs',
      'data/cases/sessions_summary.json',
      'data/cases/qualcommsession.json',
    ]);
    assert.deepEqual(result, []);
  });

  it('flags only the offending paths out of a mixed staging list', () => {
    const staged = [
      'tools/gen_design.mjs',
      'data/.secrets/token.bin',
      'docs/DESIGN.md',
      'data/chrome-profile/Default/Preferences',
    ];
    const result = findForbiddenStagedPaths(staged);
    assert.deepEqual(result, [
      'data/.secrets/token.bin',
      'data/chrome-profile/Default/Preferences',
    ]);
  });

  it('normalizes Windows-style backslash separators before matching', () => {
    const result = findForbiddenStagedPaths(['data\\chrome-profile\\Default\\Cookies']);
    assert.deepEqual(result, ['data\\chrome-profile\\Default\\Cookies']);
  });
});
