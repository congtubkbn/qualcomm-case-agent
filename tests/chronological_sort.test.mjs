// tests/chronological_sort.test.mjs
// Unit tests for chronological comment timestamp parsing and Oldest -> Newest sorting.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs', import.meta.url));
const m = await import(new URL('../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs', import.meta.url));

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
});

describe('mergeComments chronological ordering', () => {
  it('maintains strict oldest -> newest ordering after merging fresh comments into cache', () => {
    const cached = m.assignIds([
      comment('Bob', 'initial post', '5 days ago'),
      comment('Alice', 'middle post', '3 days ago'),
    ]).comments;

    const freshScraped = m.assignIds([
      comment('Carol', 'brand new update', '1 hour ago'),
      comment('Alice', 'middle post', '3 days ago'),
    ]).comments;

    const { merged, newIds } = m.mergeComments(cached, freshScraped);
    assert.equal(merged.length, 3);
    assert.deepEqual(newIds, [m.commentId(comment('Carol', 'brand new update', '1 hour ago'))]);

    // Comment 0 = oldest (Bob), Comment 1 = middle (Alice), Comment 2 = newest (Carol)
    assert.equal(merged[0].author, 'Bob');
    assert.equal(merged[1].author, 'Alice');
    assert.equal(merged[2].author, 'Carol');
  });
});

describe('finalize end-to-end chronological persistence', () => {
  it('writes case.json where comment 0 is oldest and comment N-1 is newest', () => {
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
    assert.equal(saved.comments[0].author, 'Bob');     // 6 days ago (oldest)
    assert.equal(saved.comments[1].author, 'Alice');   // 2 days ago
    assert.equal(saved.comments[2].author, 'Carol');   // 2 hours ago (newest)
  });
});
