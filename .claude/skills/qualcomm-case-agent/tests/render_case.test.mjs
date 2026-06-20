// tests/render_case.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');
const RENDER = join(SKILL_ROOT, 'scripts', 'render_case.mjs');
const TMP = join(SKILL_ROOT, 'tests', '_tmp_render');

function writeFixture(name, data) {
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, `${name}.json`);
  writeFileSync(p, JSON.stringify(data), 'utf8');
  return p;
}

function cleanup(stem) {
  for (const ext of ['.json', '.md', '.html', '.report.md']) {
    const p = join(TMP, stem + ext);
    if (existsSync(p)) unlinkSync(p);
  }
}

test('render with enrichment: report.md contains engineerSummary', () => {
  const fixture = {
    caseNumber: 'CASE-00001',
    title: 'Test case',
    status: 'Open',
    comments: [{ id: 'c1', timestamp: '2024-01-01', company: 'ACME', author: 'Alice', role: 'Eng', body: 'Hello', analysisLog: [], attachments: [] }],
    displayedCommentCount: 1,
    hash: 'abc',
    extractedAt: '2024-01-01T00:00:00Z',
    enrichment: {
      engineerSummary: 'THIS_SUMMARY',
      rootCause: 'THIS_ROOT_CAUSE',
      recommendedActions: ['Action 1'],
      tags: ['NR', 'n78'],
      timeline: [{ date: '2024-01-01', event: 'Opened' }],
      commentSummaries: { c1: 'Comment summary here' },
      enrichedAt: '2024-01-01T01:00:00Z',
    },
  };
  const p = writeFixture('CASE-00001', fixture);
  execSync(`node "${RENDER}" "${p}"`);
  const report = readFileSync(join(TMP, 'CASE-00001.report.md'), 'utf8');
  assert.ok(report.includes('THIS_SUMMARY'), 'report should contain engineerSummary');
  assert.ok(report.includes('THIS_ROOT_CAUSE'), 'report should contain rootCause');
  cleanup('CASE-00001');
});

test('render without enrichment: report.md renders without crashing', () => {
  const fixture = {
    caseNumber: 'CASE-00002',
    title: 'Raw only case',
    status: 'Open',
    comments: [{ id: 'c1', timestamp: '2024-01-01', company: 'ACME', author: 'Bob', role: 'Eng', body: 'Raw body', analysisLog: [], attachments: [] }],
    displayedCommentCount: 1,
    hash: 'def',
    extractedAt: '2024-01-01T00:00:00Z',
  };
  const p = writeFixture('CASE-00002', fixture);
  execSync(`node "${RENDER}" "${p}"`);
  const report = readFileSync(join(TMP, 'CASE-00002.report.md'), 'utf8');
  assert.ok(report.includes('CASE-00002'), 'report should contain case number');
  cleanup('CASE-00002');
});

test('render: comment summary shown from enrichment.commentSummaries', () => {
  const fixture = {
    caseNumber: 'CASE-00003',
    title: 'Summary test',
    status: 'Open',
    comments: [{ id: 'myid', timestamp: '2024-01-01', company: 'X', author: 'Y', role: 'Z', body: 'body text', analysisLog: [], attachments: [] }],
    displayedCommentCount: 1,
    hash: 'ghi',
    extractedAt: '2024-01-01T00:00:00Z',
    enrichment: {
      engineerSummary: '',
      rootCause: '',
      recommendedActions: [],
      tags: [],
      timeline: [],
      commentSummaries: { myid: 'COMMENT_SUMMARY_TEXT' },
      enrichedAt: '2024-01-01T01:00:00Z',
    },
  };
  const p = writeFixture('CASE-00003', fixture);
  execSync(`node "${RENDER}" "${p}"`);
  const md = readFileSync(join(TMP, 'CASE-00003.md'), 'utf8');
  assert.ok(md.includes('COMMENT_SUMMARY_TEXT'), '.md should show comment summary from enrichment.commentSummaries');
  cleanup('CASE-00003');
});
