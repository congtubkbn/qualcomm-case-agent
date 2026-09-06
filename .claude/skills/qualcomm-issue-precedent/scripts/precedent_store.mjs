// Data/domain module: scans case directories for Reference Cases (a Case whose
// summary.json.executive.rootCause is a non-empty string), extracts verbatim
// technical signatures from their rootCause/resolution/comment text, and ranks
// them against a free-text query by deterministic keyword overlap.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../../qualcomm-case-agent/scripts/_paths.mjs';

export const DEFAULT_CASES_DIR = DATA_DIR;

// Scoring weights: title/rootCause outweigh flow; product is a soft boost, never a filter.
export const TITLE_WEIGHT = 3;
export const ROOT_CAUSE_WEIGHT = 3;
export const FLOW_WEIGHT = 1;
export const PRODUCT_BOOST_WEIGHT = 2;

// A candidate scoring below this has zero/near-zero keyword overlap with the query — kept in the
// results (never silently dropped) but tagged `lowConfidence` and excluded from the `limit` count
// so noisy-but-keyword-matching candidates can't crowd a genuinely relevant, differently-worded
// case out of the top N.
export const MIN_CONFIDENT_SCORE = 1;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'this', 'that',
  'it', 'as', 'by', 'from', 'do', 'does', 'not', 'no',
]);

const SIGNATURE_PATTERNS = [
  // Message/IE-name identifiers, e.g. RRC_CONN_RELEASE, EMM_CAUSE_ILLEGAL_UE
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  // Standalone ALL-CAPS identifiers with no underscore, e.g. PAGING, ATTACH, EPSFB
  /\b[A-Z]{3,}\b/g,
  // Cause codes, e.g. "cause 58", "Cause code #58", "cause=15", "cause 12345"
  /\bcause\s*(?:code)?\s*[:#=]?\s*\d+\b/gi,
  // Hex literals, e.g. 0x1A2B
  /\b0x[0-9A-Fa-f]+\b/g,
];

/**
 * Tokenizes free text into lowercase alphanumeric words, dropping stopwords and short tokens.
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return new Set(words.filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
}

/**
 * Counts tokens shared between two token sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function overlapCount(a, b) {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) n++;
  }
  return n;
}

/**
 * Extracts verbatim technical signatures (message/IE-name and cause-code tokens) from one
 * text field. Returns the exact matched substrings, deduplicated in first-seen order.
 * @param {string} text
 * @returns {string[]}
 */
export function extractSignaturesFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const pattern of SIGNATURE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const signature = match[0];
      if (!seen.has(signature)) {
        seen.add(signature);
        out.push(signature);
      }
    }
  }
  return out;
}

/**
 * Collects provenance-tagged signatures across a Reference Case's rootCause, resolution, and
 * verbatim case.json comment bodies. Each signature carries the field name or comment id it
 * came from; a signature already attributed to an earlier source is not repeated.
 * @param {{rootCause: string, resolution: string}} executive
 * @param {Array<{id?: string, body?: string}>} comments
 * @returns {Array<{signature: string, source: string}>}
 */
export function collectSignatures(executive, comments = []) {
  const sources = [
    ['rootCause', executive.rootCause],
    ['resolution', executive.resolution],
    ...comments.map((c, i) => [`comment:${c.id || i}`, c.body]),
  ];

  const seen = new Set();
  const out = [];
  for (const [source, text] of sources) {
    for (const signature of extractSignaturesFromText(text)) {
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push({ signature, source });
    }
  }
  return out;
}

/**
 * Builds one Reference Case record from a case directory, or null if the directory isn't a
 * valid case, has no summary.json, or its executive.rootCause isn't a non-empty string.
 * @param {string} caseDir
 * @param {string} [fallbackCaseNumber]
 * @returns {object|null}
 */
export function buildReferenceCase(caseDir, fallbackCaseNumber = '') {
  try {
    if (!existsSync(caseDir) || !statSync(caseDir).isDirectory()) return null;

    const caseJsonPath = join(caseDir, 'case.json');
    const summaryJsonPath = join(caseDir, 'summary.json');
    if (!existsSync(caseJsonPath) || !existsSync(summaryJsonPath)) return null;

    const caseJson = JSON.parse(readFileSync(caseJsonPath, 'utf8'));
    const summaryJson = JSON.parse(readFileSync(summaryJsonPath, 'utf8'));

    const rootCause = summaryJson?.executive?.rootCause;
    if (typeof rootCause !== 'string' || !rootCause.trim()) return null;

    const resolution = typeof summaryJson.executive.resolution === 'string' ? summaryJson.executive.resolution : '';
    const flow = typeof summaryJson.flow === 'string' ? summaryJson.flow : '';
    const comments = Array.isArray(caseJson.comments) ? caseJson.comments : [];

    return {
      caseNumber: caseJson.caseNumber || summaryJson.caseNumber || fallbackCaseNumber,
      title: caseJson.title || summaryJson.title || '',
      rootCause,
      resolution,
      flow,
      product: caseJson.product || '',
      url: caseJson.url || summaryJson.url || '',
      signatures: collectSignatures({ rootCause, resolution }, comments),
    };
  } catch {
    return null;
  }
}

/**
 * Scans every case directory and returns the Reference Case corpus (rootCause-present gate
 * applied; non-qualifying Cases are excluded entirely, not merely scored low).
 * @param {string} [casesDir]
 * @returns {object[]}
 */
export function buildReferenceCaseCorpus(casesDir = DEFAULT_CASES_DIR) {
  if (!existsSync(casesDir)) return [];

  const entries = readdirSync(casesDir, { withFileTypes: true });
  const corpus = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const record = buildReferenceCase(join(casesDir, entry.name), entry.name);
    if (record) corpus.push(record);
  }
  return corpus;
}

/**
 * Scores a Reference Case against a query's token set: title/rootCause outweigh flow, and a
 * shared product token adds a soft boost without ever excluding candidates that lack it.
 * @param {Set<string>} queryTokens
 * @param {{title: string, rootCause: string, flow: string, product: string}} candidate
 * @returns {number}
 */
export function scoreCandidate(queryTokens, candidate) {
  return (
    overlapCount(queryTokens, tokenize(candidate.title)) * TITLE_WEIGHT +
    overlapCount(queryTokens, tokenize(candidate.rootCause)) * ROOT_CAUSE_WEIGHT +
    overlapCount(queryTokens, tokenize(candidate.flow)) * FLOW_WEIGHT +
    overlapCount(queryTokens, tokenize(candidate.product)) * PRODUCT_BOOST_WEIGHT
  );
}

/**
 * Ranks the Reference Case corpus against a free-text query by deterministic keyword overlap,
 * highest score first (ties broken by ascending case number). Candidates scoring at or above
 * `minScore` are truncated to `limit`; candidates below it are never silently dropped — up to
 * `limit` of them are appended after, tagged `lowConfidence: true`, so a genuinely relevant case
 * with different wording (and therefore no keyword overlap) can't be pushed out of the results by
 * unrelated candidates that merely happen to share keywords.
 * @param {string} query
 * @param {string} [casesDir]
 * @param {number} [limit=10]
 * @param {number} [minScore]
 * @returns {object[]}
 */
export function searchPrecedents(query, casesDir = DEFAULT_CASES_DIR, limit = 10, minScore = MIN_CONFIDENT_SCORE) {
  const queryTokens = tokenize(query);
  const corpus = buildReferenceCaseCorpus(casesDir);
  const scored = corpus.map((candidate) => ({ ...candidate, score: scoreCandidate(queryTokens, candidate) }));
  const byScoreThenCaseNumber = (a, b) => b.score - a.score || String(a.caseNumber).localeCompare(String(b.caseNumber));

  const confident = scored.filter((c) => c.score >= minScore).sort(byScoreThenCaseNumber);
  const lowConfidence = scored
    .filter((c) => c.score < minScore)
    .sort(byScoreThenCaseNumber)
    .slice(0, limit)
    .map((c) => ({ ...c, lowConfidence: true }));

  return [...confident.slice(0, limit), ...lowConfidence];
}
