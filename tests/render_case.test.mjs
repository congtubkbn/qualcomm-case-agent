// QA coverage for render_case.mjs — previously untested. This script turns
// case.json (Chatter feed content from OTHER companies on a shared support
// portal — not fully trusted input) into a single-file case.html that a human
// opens locally. The main risk surface is HTML injection/XSS from comment
// bodies, titles, attachment names/hrefs; secondary risk is a crash on
// missing/malformed fields wiping no files (it writes 4 files with no
// atomicity) or a BOM-prefixed case.json (other scripts in this repo
// explicitly strip a BOM; this one must too, for consistency).
//
// render_case.mjs has no exports — it's a top-level script driven by argv —
// so it is exercised the same way scrape_case.test.mjs drives finalize():
// spawn it against a real file and inspect what it wrote.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/render_case.mjs', import.meta.url));

function renderFixture(data) {
  const dir = mkdtempSync(join(tmpdir(), 'qc-render-'));
  const jsonPath = join(dir, 'case.json');
  writeFileSync(jsonPath, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  const r = spawnSync(process.execPath, [SCRIPT, jsonPath], { encoding: 'utf8' });
  return {
    dir, exit: r.status, stdout: r.stdout, stderr: r.stderr,
    html: () => readFileSync(join(dir, 'case.html'), 'utf8'),
    md: () => readFileSync(join(dir, 'case.md'), 'utf8'),
    report: () => readFileSync(join(dir, 'case.report.md'), 'utf8'),
    txt: () => readFileSync(join(dir, 'case.txt'), 'utf8'),
  };
}

const comment = (author, body, extra = {}) => ({ author, body, timestamp: '2 days ago', ...extra });

const MINIMAL = {
  caseNumber: '08460319', title: 'NR SA attach failure', status: 'Open', priority: 'P2',
  comments: [comment('Alice', 'RRC reject on n78')],
};

describe('render_case: happy path', () => {
  it('writes all four artifacts with the expected identifiers', () => {
    const r = renderFixture(MINIMAL);
    assert.equal(r.exit, 0);
    assert.match(r.html(), /08460319/);
    assert.match(r.html(), /NR SA attach failure/);
    assert.match(r.md(), /RRC reject on n78/);
    assert.match(r.report(), /Case Report/);
    assert.match(r.txt(), /RRC reject on n78/);
  });

  it('exits 2 with a usage message when no path is given', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage:/);
  });
});

describe('render_case: HTML/XSS safety (comment content is third-party, not trusted)', () => {
  it('escapes a <script> tag in a comment body instead of emitting it live', () => {
    const r = renderFixture({
      ...MINIMAL,
      comments: [comment('Mallory', '<script>alert(document.cookie)</script>')],
    });
    const html = r.html();
    assert.ok(!html.includes('<script>alert(document.cookie)</script>'),
      'raw <script> tag must never appear unescaped in case.html');
    assert.match(html, /&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/);
  });

  it('escapes an attribute-breakout attempt in the case title', () => {
    const r = renderFixture({ ...MINIMAL, title: `"><img src=x onerror=alert(1)>` });
    const html = r.html();
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'),
      'title must not be able to break out of the <title>/<h1> context');
  });

  it('escapes HTML in engineer-analysis fields (root cause, summary, key points)', () => {
    const r = renderFixture({
      ...MINIMAL,
      comments: [comment('Alice', 'RRC reject on n78', { id: 'c1' })],
      enrichment: {
        engineerSummary: '<img src=x onerror=alert(1)>',
        rootCause: '<svg onload=alert(2)>',
        commentAnalyses: {
          c1: { summary: 's', role: 'Analysis', keyPoints: ['<b>bold-injected</b>'], citations: [] },
        },
      },
    });
    const html = r.html();
    assert.ok(!/<img src=x onerror=alert\(1\)>/.test(html));
    assert.ok(!/<svg onload=alert\(2\)>/.test(html));
    assert.ok(!html.includes('<b>bold-injected</b>'));
  });

  it('escapes an injection in an attachment file name', () => {
    const r = renderFixture({
      ...MINIMAL,
      comments: [comment('Bob', 'see log', {
        attachments: [{ name: '<script>evil()</script>.log', href: 'https://support.qualcomm.com/f/x' }],
      })],
    });
    assert.ok(!r.html().includes('<script>evil()</script>'));
  });

  // Comment attachments come from the live Chatter feed of a SHARED portal —
  // other companies on the same case can post them, not just the signed-in
  // account. `esc()` alone does not stop a `javascript:`/`data:` URI from
  // reaching `href="..."` verbatim, which would execute on click.
  it('neutralizes a javascript: URI in an attachment href', () => {
    const r = renderFixture({
      ...MINIMAL,
      comments: [comment('Mallory', 'see attachment', {
        attachments: [{ name: 'evil.log', href: 'javascript:alert(document.cookie)' }],
      })],
    });
    assert.ok(!r.html().includes('href="javascript:'), 'a javascript: href must never reach the DOM live');
  });

  it('neutralizes a data: URI in an attachment href', () => {
    const r = renderFixture({
      ...MINIMAL,
      comments: [comment('Mallory', 'see attachment', {
        attachments: [{ name: 'evil.html', href: 'data:text/html,<script>alert(1)</script>' }],
      })],
    });
    assert.ok(!r.html().includes('href="data:'));
  });

  it('keeps a normal https:// attachment href intact', () => {
    const r = renderFixture({
      ...MINIMAL,
      comments: [comment('Bob', 'see log', {
        attachments: [{ name: 'ok.log', href: 'https://support.qualcomm.com/f/abc123' }],
      })],
    });
    assert.match(r.html(), /href="https:\/\/support\.qualcomm\.com\/f\/abc123"/);
  });

  it('neutralizes a javascript: URI in the case URL footer link', () => {
    const r = renderFixture({ ...MINIMAL, url: 'javascript:alert(1)' });
    assert.ok(!r.html().includes('href="javascript:'));
  });
});

describe('render_case: malformed / missing data does not crash', () => {
  it('tolerates a case with no comments array at all', () => {
    const { comments, ...noComments } = MINIMAL;
    const r = renderFixture(noComments);
    assert.equal(r.exit, 0);
    assert.match(r.html(), /Comments \(newest first\)/);
  });

  it('tolerates an empty comments array', () => {
    const r = renderFixture({ ...MINIMAL, comments: [] });
    assert.equal(r.exit, 0);
  });

  it('tolerates missing optional header fields (status/priority/customer/product)', () => {
    const r = renderFixture({ caseNumber: '08460319', title: 'x', comments: [comment('A', 'b')] });
    assert.equal(r.exit, 0);
    assert.ok(!r.md().includes('**Status:**'));
  });

  it('falls back to "Untitled case" when title is missing, without crashing', () => {
    const { title, ...noTitle } = MINIMAL;
    const r = renderFixture(noTitle);
    assert.equal(r.exit, 0);
    assert.match(r.html(), /Untitled case/);
  });

  it('reads a UTF-8 BOM-prefixed case.json (same tolerance as scrape_case.mjs)', () => {
    const r = renderFixture('﻿' + JSON.stringify(MINIMAL));
    assert.equal(r.exit, 0);
    assert.match(r.html(), /08460319/);
  });

  it('exits non-zero on malformed JSON rather than writing partial/garbage artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-render-'));
    const jsonPath = join(dir, 'case.json');
    writeFileSync(jsonPath, '{ not valid json', 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, jsonPath], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.throws(() => readFileSync(join(dir, 'case.html'), 'utf8'));
  });

  it('supports the legacy flat commentSummaries schema alongside commentAnalyses', () => {
    const c = comment('Alice', 'RRC reject on n78', { id: 'c1' });
    const r = renderFixture({
      ...MINIMAL, comments: [c],
      enrichment: { commentSummaries: { c1: 'legacy one-line summary' } },
    });
    assert.match(r.html(), /legacy one-line summary/);
    assert.match(r.md(), /legacy one-line summary/);
  });
});
