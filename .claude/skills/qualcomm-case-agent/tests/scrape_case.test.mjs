// tests/scrape_case.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHash,
  countAssert,
  isFixpoint,
  selectExitCode,
  validateSelectors,
  EXIT,
} from '../scripts/scrape_case.mjs';

// computeHash
test('computeHash: same input → same hash', () => {
  const raw = {
    displayedCommentCount: 2,
    comments: [
      { id: 'c1', timestamp: '2024-01-01', author: 'Alice', body: 'Hello', analysisLog: [] },
      { id: 'c2', timestamp: '2024-01-02', author: 'Bob',   body: 'World', analysisLog: ['log1'] },
    ],
  };
  assert.strictEqual(computeHash(raw), computeHash(raw));
});

test('computeHash: body change → different hash', () => {
  const base = { displayedCommentCount: 1, comments: [{ id: 'c1', timestamp: '2024-01-01', author: 'Alice', body: 'Hello', analysisLog: [] }] };
  const changed = { displayedCommentCount: 1, comments: [{ id: 'c1', timestamp: '2024-01-01', author: 'Alice', body: 'CHANGED', analysisLog: [] }] };
  assert.notStrictEqual(computeHash(base), computeHash(changed));
});

test('computeHash: returns 64-char hex string', () => {
  const raw = { displayedCommentCount: 0, comments: [] };
  assert.match(computeHash(raw), /^[0-9a-f]{64}$/);
});

test('computeHash: excludes extractedAt from hash', () => {
  const raw1 = { displayedCommentCount: 1, comments: [{ id: 'c1', timestamp: 't', author: 'a', body: 'b', analysisLog: [] }], extractedAt: '2024-01-01T00:00:00Z' };
  const raw2 = { ...raw1, extractedAt: '2024-06-01T12:00:00Z' };
  assert.strictEqual(computeHash(raw1), computeHash(raw2));
});

// countAssert
test('countAssert: counts match → ok', () => {
  assert.deepStrictEqual(countAssert(5, 5), { ok: true });
});

test('countAssert: captured < displayed → not ok', () => {
  const r = countAssert(3, 5);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.captured, 3);
  assert.strictEqual(r.displayed, 5);
});

test('countAssert: displayed is null → ok with warning', () => {
  const r = countAssert(3, null);
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.warning === 'string' && r.warning.length > 0);
});

test('countAssert: captured > displayed → ok (extra elements not a failure)', () => {
  assert.deepStrictEqual(countAssert(6, 5), { ok: true });
});

// isFixpoint
test('isFixpoint: identical passes → true', () => {
  const pass = { clicked: 0, count: 5, h: 1000 };
  assert.strictEqual(isFixpoint(pass, pass), true);
});

test('isFixpoint: clicked > 0 → false', () => {
  assert.strictEqual(isFixpoint({ clicked: 0, count: 5, h: 1000 }, { clicked: 1, count: 5, h: 1000 }), false);
});

test('isFixpoint: count changed → false', () => {
  assert.strictEqual(isFixpoint({ clicked: 0, count: 5, h: 1000 }, { clicked: 0, count: 6, h: 1000 }), false);
});

test('isFixpoint: scrollHeight changed → false', () => {
  assert.strictEqual(isFixpoint({ clicked: 0, count: 5, h: 1000 }, { clicked: 0, count: 5, h: 1100 }), false);
});

// selectExitCode
test('selectExitCode: configMissing → 6', () => {
  assert.strictEqual(selectExitCode({ configMissing: true }), EXIT.CONFIG_MISSING);
});

test('selectExitCode: authNeeded → 3', () => {
  assert.strictEqual(selectExitCode({ authNeeded: true }), EXIT.AUTH_NEEDED);
});

test('selectExitCode: notFound → 4', () => {
  assert.strictEqual(selectExitCode({ notFound: true }), EXIT.NOT_FOUND);
});

test('selectExitCode: incomplete → 5', () => {
  assert.strictEqual(selectExitCode({ incomplete: true }), EXIT.INCOMPLETE);
});

test('selectExitCode: no flags → 0', () => {
  assert.strictEqual(selectExitCode({}), EXIT.OK);
});

// validateSelectors
test('validateSelectors: empty object → invalid', () => {
  const r = validateSelectors({});
  assert.strictEqual(r.valid, false);
  assert.ok(r.missingKeys.length > 0);
});

test('validateSelectors: null values → invalid', () => {
  const r = validateSelectors({ fields: null, comments: null, displayedCommentCount: null });
  assert.strictEqual(r.valid, false);
});

test('validateSelectors: all required keys present → valid', () => {
  const r = validateSelectors({
    fields: { title: 'h1' },
    comments: { container: '.comment', body: '.body' },
    displayedCommentCount: '.count-badge',
  });
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.missingKeys, []);
});
