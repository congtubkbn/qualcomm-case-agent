// tests/qcomm_chronological_sort.test.mjs
// Unit tests for chronological comment timestamp parsing and Oldest -> Newest sorting.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qcomm/scripts/finalize_case.mjs', import.meta.url));
const m = await import(new URL('../.claude/skills/qcomm/scripts/finalize_case.mjs', import.meta.url));

const comment = (author, body, timestamp, extra = {}) => ({
  author,
  body,
  timestamp,
  ...extra,
});

describe('parseTimestamp', () => {
  const refDate = new Date('2026-08-22T12:00:00.000Z');

  it('parses standard ISO date strings', () => {
    const ts = '2026-08-20T10:30:00.000Z';
    const parsed = m.parseTimestamp(ts, refDate);
    assert.equal(parsed, Date.parse(ts));
  });

  it('parses formatted date strings with at or commas', () => {
    const parsed = m.parseTimestamp('August 20, 2026 at 3:45 PM', refDate);
    assert.ok(!isNaN(parsed));
    assert.equal(new Date(parsed).getFullYear(), 2026);
  });

  it('parses relative seconds and just now', () => {
    const justNow = m.parseTimestamp('Just now', refDate);
    assert.equal(justNow, refDate.getTime());

    const secs = m.parseTimestamp('30s ago', refDate);
    assert.equal(secs, refDate.getTime() - 30 * 1000);
  });

  it('parses relative minutes and hours', () => {
    const mins = m.parseTimestamp('15 mins ago', refDate);
    assert.equal(mins, refDate.getTime() - 15 * 60 * 1000);

    const hours = m.parseTimestamp('2 hours ago', refDate);
    assert.equal(hours, refDate.getTime() - 2 * 3600 * 1000);

    const hr = m.parseTimestamp('1 hr ago', refDate);
    assert.equal(hr, refDate.getTime() - 3600 * 1000);
  });

  it('parses relative days, weeks, months, years', () => {
    const days = m.parseTimestamp('3 days ago', refDate);
    assert.equal(days, refDate.getTime() - 3 * 86400 * 1000);

    const weeks = m.parseTimestamp('2 weeks ago', refDate);
    assert.equal(weeks, refDate.getTime() - 2 * 7 * 86400 * 1000);

    const months = m.parseTimestamp('1 month ago', refDate);
    assert.equal(months, refDate.getTime() - 30 * 86400 * 1000);

    const years = m.parseTimestamp('1 year ago', refDate);
    assert.equal(years, refDate.getTime() - 365 * 86400 * 1000);
  });

  it('parses Yesterday and Today relative formats', () => {
    const yesterday = m.parseTimestamp('Yesterday', refDate);
    assert.equal(yesterday, refDate.getTime() - 86400 * 1000);

    const today = m.parseTimestamp('Today', refDate);
    assert.equal(today, refDate.getTime());
  });

  it('gracefully handles empty, null or unknown formats without throwing', () => {
    assert.equal(m.parseTimestamp('', refDate), 0);
    assert.equal(m.parseTimestamp(null, refDate), 0);
    assert.equal(m.parseTimestamp(undefined, refDate), 0);
    assert.equal(m.parseTimestamp('some random text', refDate), 0);
  });
});

describe('isRelativeTimestamp & normalizeComment', () => {
  const refDate1 = new Date('2026-08-22T12:00:00.000Z');
  const refDate2 = new Date('2026-08-30T12:00:00.000Z');

  it('detects relative timestamps correctly', () => {
    assert.equal(m.isRelativeTimestamp('12 days ago'), true);
    assert.equal(m.isRelativeTimestamp('1 hour ago'), true);
    assert.equal(m.isRelativeTimestamp('Just now'), true);
    assert.equal(m.isRelativeTimestamp('Yesterday'), true);
    assert.equal(m.isRelativeTimestamp('August 20, 2026 at 3:45 PM'), false);
    assert.equal(m.isRelativeTimestamp('2026-08-20T10:30:00.000Z'), false);
    assert.equal(m.isRelativeTimestamp(''), false);
    assert.equal(m.isRelativeTimestamp(null), false);
  });

  it('resolves relative timestamp to absolute ISO form and retains rawTimestamp', () => {
    const raw = comment('Duc Hoang', 'log attached', '12 days ago');
    const normalized = m.normalizeComment(raw, refDate1);

    const expectedEpoch = refDate1.getTime() - 12 * 86400 * 1000;
    assert.equal(normalized.timestamp, new Date(expectedEpoch).toISOString());
    assert.equal(normalized.rawTimestamp, '12 days ago');
    assert.equal(normalized.body, 'log attached');
    assert.equal(normalized.author, 'Duc Hoang');
  });

  it('produces the same stored value when normalized against two different reference dates once absolute', () => {
    const raw = comment('Duc Hoang', 'log attached', '12 days ago');
    const normalizedAtT1 = m.normalizeComment(raw, refDate1);
    const normalizedAgainAtT2 = m.normalizeComment(normalizedAtT1, refDate2);

    assert.equal(normalizedAgainAtT2.timestamp, normalizedAtT1.timestamp);
    assert.equal(normalizedAgainAtT2.rawTimestamp, '12 days ago');
    assert.deepEqual(normalizedAgainAtT2, normalizedAtT1);
  });

  it('normalizes absolute non-ISO timestamps to ISO form and retains rawTimestamp (Issue #199)', () => {
    const absolute = comment('Alice', 'report', 'August 20, 2026 at 3:45 PM');
    const res1 = m.normalizeComment(absolute, refDate1);
    const res2 = m.normalizeComment(absolute, refDate2);

    const expected = new Date(Date.parse('August 20, 2026 3:45 PM')).toISOString();
    assert.equal(res1.timestamp, expected);
    assert.equal(res1.rawTimestamp, 'August 20, 2026 at 3:45 PM');
    assert.deepEqual(res1, res2);
  });

  it('normalizes a Chatter-rendered absolute timestamp missing title/datetime attrs (Issue #199)', () => {
    const raw = comment('Bob', 'log update', 'September 2, 2026 at 11:55 PM');
    const normalized = m.normalizeComment(raw, refDate1);

    assert.ok(!isNaN(Date.parse(normalized.timestamp)), 'timestamp should be a valid ISO string');
    assert.equal(normalized.rawTimestamp, 'September 2, 2026 at 11:55 PM');
  });

  it('leaves already-ISO timestamps functionally unaffected', () => {
    const iso = comment('Carol', 'update', '2026-08-20T10:30:00.000Z');
    const normalized = m.normalizeComment(iso, refDate1);

    assert.equal(Date.parse(normalized.timestamp), Date.parse('2026-08-20T10:30:00.000Z'));
  });
});

describe('sortCommentsChronological', () => {
  const refDate = new Date('2026-08-22T12:00:00.000Z');

  it('sorts comments strictly from oldest to newest with relative timestamps', () => {
    const raw = [
      comment('Alice', 'newest post', '1 hour ago'),
      comment('Bob', 'middle post', '1 day ago'),
      comment('Carol', 'oldest post', '5 days ago'),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].author, 'Carol'); // 5 days ago (oldest)
    assert.equal(sorted[1].author, 'Bob');   // 1 day ago
    assert.equal(sorted[2].author, 'Alice'); // 1 hour ago (newest)
  });

  it('sorts comments with ISO timestamps from oldest to newest', () => {
    const raw = [
      comment('Alice', 'c3', '2026-08-22T10:00:00Z'),
      comment('Bob', 'c1', '2026-08-20T08:00:00Z'),
      comment('Carol', 'c2', '2026-08-21T09:00:00Z'),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.deepEqual(sorted.map(c => c.author), ['Bob', 'Carol', 'Alice']);
  });

  it('breaks ties preserving chronological order when timestamps are equal', () => {
    const raw = [
      comment('Bob', 'older in same day', '2 days ago'),
      comment('Alice', 'newer in same day', '2 days ago'),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.equal(sorted[0].author, 'Bob');
    assert.equal(sorted[1].author, 'Alice');
  });

  it('interpolates missing timestamps at the beginning of a reverse-chronological DOM feed', () => {
    // In DOM order: newest comment at index 0 (missing timestamp), then 1 day ago, then 5 days ago
    const raw = [
      comment('Aiden', 'latest reply with missing timestamp', ''),
      comment('Bob', 'reply yesterday', '1 day ago'),
      comment('Carol', 'initial problem description', '5 days ago'),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].author, 'Carol'); // 5 days ago (oldest)
    assert.equal(sorted[1].author, 'Bob');   // 1 day ago (middle)
    assert.equal(sorted[2].author, 'Aiden'); // latest reply (newest - interpolated)
  });

  it('interpolates missing timestamps between known timestamps in chronological sequence', () => {
    const raw = [
      comment('Carol', 'opening post', '5 days ago'),
      comment('Bob', 'middle reply missing timestamp', ''),
      comment('Alice', 'latest resolution', '1 hour ago'),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].author, 'Carol');
    assert.equal(sorted[1].author, 'Bob');
    assert.equal(sorted[2].author, 'Alice');
  });

  it('preserves order when all timestamps are missing or empty', () => {
    const raw = [
      comment('User1', 'first', ''),
      comment('User2', 'second', ''),
      comment('User3', 'third', ''),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].author, 'User1');
    assert.equal(sorted[1].author, 'User2');
    assert.equal(sorted[2].author, 'User3');
  });

  it('handles single known timestamp with missing sibling timestamps', () => {
    const raw = [
      comment('User1', 'first', ''),
      comment('User2', 'second with timestamp', '2 days ago'),
      comment('User3', 'third', ''),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].author, 'User1');
    assert.equal(sorted[1].author, 'User2');
    assert.equal(sorted[2].author, 'User3');
  });

  it('sorts nested replies by actual post time relative to top-level posts (Issue #91)', () => {
    // Top-level post 1: 5 days ago (oldest)
    // Nested reply to post 1: 4 days ago
    // Top-level post 2: 2 days ago
    // Nested reply to post 2: 1 day ago (newest)
    const raw = [
      comment('Duc Hoang', 'Nested reply to top post 2', '1 day ago', { isReply: true }),
      comment('Alice', 'Top-level post 2', '2 days ago', { isReply: false }),
      comment('Duc Hoang', 'Nested reply to top post 1', '4 days ago', { isReply: true }),
      comment('Bob', 'Top-level post 1', '5 days ago', { isReply: false }),
    ];

    const sorted = m.sortCommentsChronological(raw, refDate);
    assert.equal(sorted.length, 4);
    assert.equal(sorted[0].body, 'Top-level post 1');
    assert.equal(sorted[1].body, 'Nested reply to top post 1');
    assert.equal(sorted[2].body, 'Top-level post 2');
    assert.equal(sorted[3].body, 'Nested reply to top post 2');
  });
});

describe('mergeComments chronological ordering', () => {
  it('maintains strict oldest -> newest ordering after merging fresh comments into cache', () => {
    const cached = m.assignIds([
      comment('Bob', 'initial post', '5 days ago'),
      comment('Alice', 'middle post', '3 days ago'),
    ]).comments;

    const freshFinalized = m.assignIds([
      comment('Carol', 'brand new update', '1 hour ago'),
      comment('Alice', 'middle post', '3 days ago'),
    ]).comments;

    const { merged, newIds } = m.mergeComments(cached, freshFinalized);
    assert.equal(merged.length, 3);
    assert.deepEqual(newIds, [m.commentId(comment('Carol', 'brand new update', '1 hour ago'))]);

    // Comment 0 = oldest (Bob), Comment 1 = middle (Alice), Comment 2 = newest (Carol)
    assert.equal(merged[0].author, 'Bob');
    assert.equal(merged[1].author, 'Alice');
    assert.equal(merged[2].author, 'Carol');
  });
});

describe('finalize end-to-end chronological persistence', () => {
  it('writes case.json where comment 0 is newest and comment N-1 is oldest (newest-first presentation order)', () => {
    const root = mkdtempSync(join(tmpdir(), 'qc-chrono-'));
    mkdirSync(join(root, 'data', 'cases', '08603854'), { recursive: true });

    // Raw extract from Chatter DOM (feed order: newest first at index 0)
    const rawFeed = {
      caseNumber: '08603854',
      title: 'Chrono Test Case',
      status: 'Open',
      priority: 'P2',
      displayedCommentCount: 3,
      comments: [
        comment('Carol', 'latest resolution', '2 hours ago'),
        comment('Alice', 'investigation in progress', '2 days ago'),
        comment('Bob', 'initial problem report', '6 days ago'),
      ],
    };

    const rawPath = join(root, 'data', 'cases', '08603854', 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify(rawFeed), 'utf8');

    const r = spawnSync(process.execPath, [SCRIPT, '08603854', rawPath], {
      encoding: 'utf8',
      env: { ...process.env, QUALCOMM_ROOT: root },
    });

    assert.equal(r.status, 0);

    const saved = JSON.parse(readFileSync(join(root, 'data', 'cases', '08603854', 'case.json'), 'utf8'));
    assert.equal(saved.comments.length, 3);
    assert.equal(saved.comments[0].author, 'Carol');   // 2 hours ago (newest)
    assert.equal(saved.comments[1].author, 'Alice');   // 2 days ago
    assert.equal(saved.comments[2].author, 'Bob');     // 6 days ago (oldest)
  });
});
