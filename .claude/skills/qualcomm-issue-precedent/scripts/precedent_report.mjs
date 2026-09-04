// Report module: renders the agent-synthesized precedent-check result (candidates + verdicts +
// evidence, from precedent_search.mjs and precedent_verdict.mjs) as Markdown and persists it
// under data/cases/_precedent/ — purely additive, never touching data/cases/<CODE>/, _index.json,
// or _overview.json (buildReferenceCaseCorpus already skips '_'-prefixed directories, so this
// output directory is never itself scanned as a case).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../../qualcomm-case-agent/scripts/_paths.mjs';

export const DEFAULT_PRECEDENT_DIR = join(DATA_DIR, '_precedent');

/**
 * Slugifies free text into a filesystem-safe, lowercase, hyphenated token (falls back to
 * "issue" for empty/non-string input).
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? slug.slice(0, 60) : 'issue';
}

/**
 * Builds the report's filename: a slug of the issue title plus a filesystem-safe timestamp.
 * @param {string} issueTitle
 * @param {Date} [now]
 * @returns {string}
 */
export function buildReportFilename(issueTitle, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${slugify(issueTitle)}-${stamp}.md`;
}

function renderCheckLine(check) {
  const { signature, table, source, result } = check;
  let outcome;
  if (result && result.matched === true) {
    outcome = `matched (evidence: ${result.evidence?.length ? result.evidence.join('; ') : 'none listed'})`;
  } else if (result && result.matched === false) {
    outcome = 'not matched';
  } else if (result && result.unavailable) {
    outcome = `unavailable (${result.reason})`;
  } else if (result && result.error) {
    outcome = `error (${result.reason})`;
  } else {
    outcome = 'unknown';
  }
  return `- \`${signature}\` (table: ${table}, source: ${source}) → ${outcome}`;
}

function renderCandidate(candidate) {
  const {
    caseNumber, title, url, product, rootCause, resolution, flow,
    signatures = [], checks = [], verdict = 'insufficient technical data to check',
  } = candidate;

  const lines = [`### [${caseNumber}] ${title || '(untitled case)'} — ${verdict}`, ''];
  if (product) lines.push(`- **Product**: ${product}`);
  if (url) lines.push(`- **Portal**: ${url}`);
  if (rootCause) lines.push(`- **Root Cause**: ${rootCause}`);
  if (resolution) lines.push(`- **Resolution**: ${resolution}`);
  if (flow) lines.push(`- **Flow**: ${flow}`);

  if (signatures.length === 0) {
    lines.push('', '_No extractable technical signature — suggestion only, not verified against the log._');
  } else if (checks.length > 0) {
    lines.push('', '**Signatures checked:**', ...checks.map(renderCheckLine));
    const checkedSet = new Set(checks.map((c) => c.signature));
    const unchecked = signatures.filter((s) => !checkedSet.has(s.signature));
    if (unchecked.length > 0) {
      lines.push('', `**Other extracted signatures (not checked):** ${unchecked.map((s) => `\`${s.signature}\``).join(', ')}`);
    }
  } else {
    lines.push('', `**Extracted signatures (none selected for checking):** ${signatures.map((s) => `\`${s.signature}\``).join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Renders the full precedent-check result as a Markdown report.
 * @param {{issueTitle: string, issueRepro?: string, query?: string, generatedAt?: string, candidates: object[]}} report
 * @returns {string}
 */
export function renderPrecedentReportMd(report) {
  const { issueTitle, issueRepro, query, generatedAt = new Date().toISOString(), candidates = [] } = report;

  const lines = [`# Precedent Check — ${issueTitle}`, '', `- **Generated**: ${generatedAt}`];
  if (query) lines.push(`- **Query**: ${query}`);
  if (issueRepro) lines.push(`- **Repro**: ${issueRepro}`);
  lines.push('', '## Candidates', '');

  if (candidates.length === 0) {
    lines.push('_No reference cases matched this issue._');
  } else {
    lines.push(candidates.map(renderCandidate).join('\n\n---\n\n'));
  }

  return lines.join('\n') + '\n';
}

/**
 * Renders and writes the precedent-check report, creating the precedent directory if needed.
 * @param {{issueTitle: string, issueRepro?: string, query?: string, candidates: object[]}} report
 * @param {string} [precedentDir]
 * @param {Date} [now]
 * @returns {{reportPath: string}}
 */
export function persistPrecedentReport(report, precedentDir = DEFAULT_PRECEDENT_DIR, now = new Date()) {
  if (!existsSync(precedentDir)) mkdirSync(precedentDir, { recursive: true });
  const filename = buildReportFilename(report.issueTitle, now);
  const reportPath = join(precedentDir, filename);
  writeFileSync(reportPath, renderPrecedentReportMd({ ...report, generatedAt: now.toISOString() }));
  return { reportPath };
}
