// scripts/finalize_case.mjs
//
// Persistence post-processor for the AGENT-DRIVEN extraction.
//
// This script does NOT drive the browser. The agent expands the case via
// agent-browser snapshot->click (SKILL.md PHASE 1.5), then extracts the raw
// case object from the already-expanded live DOM with ONE `agent-browser eval`
// (selectors from references/extraction.md lock-in table). The agent writes
// that raw JSON to a file and hands it here to be finalized:
//
//     node finalize_case.mjs <CASE_CODE> <rawJsonPath>              (full capture)
//     node finalize_case.mjs <CASE_CODE> <rawJsonPath> --merge      (update run)
//
// Finalize = completeness assert -> stamp hash + extractedAt -> write the
// canonical data/cases/<CODE>/case.json -> update root _index.json.
//
// --merge (update run on an already-cached case): the raw file is a PARTIAL
// capture — only the new posts were expanded; old posts may be collapsed/
// truncated in the DOM. The script keeps every cached comment verbatim,
// prepends only the comments not already cached (dedup by author + body
// prefix), and recomputes the hash. It never blanks a cached field from a
// thinner fresh capture.
//
// COMMENT IDENTITY is content-derived (`commentId` = hash of author + body
// prefix), assigned HERE for every persisted comment. Ids used to be positional
// (`c1`, `c2`, … from the extractor), which meant a full re-capture of a thread
// that gained a post re-keyed every comment. Content ids are stable across runs
// and independent of position. A cache still carrying legacy ids is migrated on
// read (`migrateIds`).
//
// Why a script at all (vs the agent writing JSON directly): the SHA-256 hash
// (incremental "no update" detection) and the _index.json merge must be
// deterministic and identical across runs — that belongs in code, not the model.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './_paths.mjs';
import { afterFinalize } from './overview_store.mjs';

// ---- Exit codes (exported so tests can import) ----
export const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  INCOMPLETE: 5,
};

// ---- Pure helpers ----

// Hash only the raw, verbatim fields. Stable field order = stable hash across
// runs. `id` is deliberately NOT hashed: it is derived from the author + body that are
// already in here, so hashing it would add nothing but a dependency on the id
// scheme. (Caches written before ids became content-derived therefore re-hash
// once on their next capture — one no-op `updated` verdict, no data change.)
// displayedCommentCount is NOT hashed: it comes from a portal-rendered status
// badge that drifts between reads of an identical thread (observed on 08503838:
// 8 -> 2 with all 11 bodies unchanged), so hashing it turned pure render noise
// into a phantom `updated` verdict carrying newComments: 0. The hash covers
// verbatim comment content only — the thing an "is this case changed?" question
// is actually asking about.
export function computeHash(raw) {
  const lines = [
    ...raw.comments.map(c =>
      `${c.timestamp || ''}|${c.author || ''}|${c.body || ''}`
    ),
  ];
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

// A post whose "Expand Post" control never got clicked (or got clicked but
// never actually expanded — see run_case.mjs's stuck-loop detection) still
// extracts fine, just with the collapsed teaser text plus the control's own
// label trailing the body (Chatter renders it as a sibling INSIDE the same
// container extract_case.js reads). This is root-cause-agnostic: it catches a
// stuck click loop, a selector drift, or any other way a post ends up
// half-captured, by looking at the one thing that's always true of a genuine
// full expansion — the label is gone from the body.
const COLLAPSED_BODY_RE = /\bExpand Post\s*$/i;

// Only check comments NEW to this capture — a --merge (and a full re-capture
// of a cache) deliberately leaves OLD posts collapsed (see expand_step.js) and
// keeps their cached verbatim bodies, so those legitimately still carry the
// label in the freshly re-extracted DOM. Checking the whole list would reject
// every routine update run.
export function findCollapsed(comments, newIds) {
  const fresh = new Set(newIds);
  return (comments || []).filter(c => fresh.has(c.id) && COLLAPSED_BODY_RE.test(c.body));
}

// Completeness gate comparison (Issue #91):
// The Salesforce Chatter badge ("N Chatter Feed Items") counts only top-level posts,
// whereas our Feed extractor captures both top-level posts AND nested replies (e.g. articles inside ul.cuf-replies).
// Therefore:
// 1. capturedCount < displayedCount => under-capture: agent missed items, must fail/retry.
// 2. capturedCount > displayedCount => valid excess due to nested replies; passes with informative warning.
// 3. capturedCount == displayedCount => exact match; passes.
// 4. displayedCount == null => portal badge omitted; persists with warning.
export function countAssert(capturedCount, displayedCount) {
  if (displayedCount == null) {
    return { ok: true, warning: 'displayedCommentCount not provided' };
  }
  if (capturedCount < displayedCount) {
    return { ok: false, captured: capturedCount, displayed: displayedCount };
  }
  if (capturedCount > displayedCount) {
    return {
      ok: true,
      captured: capturedCount,
      displayed: displayedCount,
      warning: `Captured ${capturedCount} comments exceeding displayed badge total of ${displayedCount} (nested replies present)`,
    };
  }
  return { ok: true };
}

// Header fields the agent already holds in-context from the PHASE 1 search row.
// Passing them as flags lets the script backfill the big raw file in CODE — the
// agent never re-Reads case.raw.json just to add a title (O(1) tokens, not O(case size)).
export const HEADER_KEYS = ['title', 'status', 'priority', 'severity'];

// Salesforce Lightning Detail tab metadata fields persisted to canonical case.json.
export const DETAIL_KEYS = [
  'contactName',
  'openedAt',
  'closedAt',
  'customerProject',
  'customerTracking',
  'accountName',
  'relatedCRs',
  'caseRecordType',
];

// Parse `--title "..."` style flags into an overrides object. Only HEADER_KEYS honored.
// Also supports `--ref-date <date>` for test reference date injection.
export function parseHeaderFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-zA-Z-]+)$/.exec(argv[i]);
    if (m && argv[i + 1] != null) {
      if (HEADER_KEYS.includes(m[1])) {
        out[m[1]] = argv[++i];
      } else if (m[1] === 'ref-date' || m[1] === 'reference-date') {
        out.refDate = argv[++i];
      }
    }
  }
  return out;
}

// ---- Identity + merge helpers ----

// Stable identity for dedup across runs. Timestamps are EXCLUDED on purpose:
// Chatter shows relative times ("13h ago") that drift between runs. Author +
// whitespace-normalized body prefix survives both the drift and the collapsed
// (truncated) rendering of old posts in a partial update capture. Known limit:
// an edit inside the first 120 chars of an old comment makes it look new.
export function commentKey(c) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  return `${norm(c.author)}|${norm(c.body).slice(0, 120)}`;
}

// Content-derived comment id: the same comment gets the same id in every run,
// whatever position it now occupies in the feed. This is what makes merge/dedup
// stable across a full re-capture.
export function commentId(c) {
  return `c${createHash('sha256').update(commentKey(c), 'utf8').digest('hex').slice(0, 12)}`;
}

// Assign content ids to a comment list. Two comments with the same key are a
// genuine ambiguity (the same author posting the same opening 120 chars twice),
// so they are kept as distinct comments with a `-N` suffix and REPORTED rather
// than silently collapsed into one.
export function assignIds(comments) {
  const used = new Map();
  const collisions = [];
  const out = (comments || []).map(c => {
    const base = commentId(c);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    if (n > 1) collisions.push(base);
    return { ...c, id: n === 1 ? base : `${base}-${n}` };
  });
  return { comments: out, collisions };
}

// Bring a cached case written with the old positional ids (c1, c2, …) or with
// raw DOM ids onto content ids. A cache already on content ids, with no legacy
// `enrichment` field, is returned untouched. A legacy `enrichment` field (from
// before this pipeline dropped analysis support) is dropped rather than carried
// forward — nothing produces it any more, so there is nothing to re-key it onto.
export function migrateIds(cached) {
  const before = cached.comments || [];
  const { comments } = assignIds(before);
  const remap = new Map();
  before.forEach((c, i) => { if (c.id !== comments[i].id) remap.set(c.id, comments[i].id); });
  if (!remap.size && !('enrichment' in cached)) return cached;

  const { enrichment, ...rest } = cached;
  return { ...rest, comments };
}

// Levenshtein edit distance — used only to compare a handful of same-author
// candidates (see possibleEdits below), never the whole thread.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

// 1.0 = identical, 0.0 = nothing in common (normalized edit distance).
function bodySimilarity(a, b) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  const maxLen = Math.max(x.length, y.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(x, y) / maxLen;
}

// I3: an edit to an old comment's body gives it a new content id (identity is
// content-derived, D19), so it reads as a brand new comment here — silently.
// This does not try to resolve that ambiguity (guessing wrong would silently
// overwrite a different comment's verbatim body, which is worse — D9/V4), it
// only surfaces same-author, high-similarity matches for a human to check.
const POSSIBLE_EDIT_SIMILARITY = 0.55;

/**
 * Checks if a timestamp string contains Salesforce/Chatter UI tooltip noise.
 */
export function isBlacklistedTs(s) {
  if (!s || typeof s !== 'string') return true;
  const lower = s.toLowerCase();
  return (
    lower.includes('click for single-item view') ||
    lower.includes('expand post') ||
    lower.includes('chatter feed item') ||
    lower.includes('view more comments') ||
    lower.includes('more comments')
  );
}

/**
 * Splits a single line into sentences. A run of consecutive terminator
 * chars ("?!", "...") ends together as one boundary — a bare fragment like
 * "!" must never survive as its own "sentence" (it would consume a
 * meaningful-sentence slot and silently drop what follows). The one
 * exception: a LONE '.' only ends a sentence when followed by whitespace or
 * end-of-string, since a dot inside a token (".zip", ".log", a dotted build
 * version) has no whitespace after it and must stay part of the running
 * sentence instead of forking a bogus split.
 */
function splitSentences(line) {
  const sentences = [];
  let cur = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    cur += ch;
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i + 1;
      while (j < line.length && (line[j] === '.' || line[j] === '!' || line[j] === '?')) {
        cur += line[j];
        j++;
      }
      const isLoneDot = ch === '.' && j - i === 1;
      const next = line[j];
      if (!isLoneDot || next === undefined || /\s/.test(next)) {
        sentences.push(cur);
        cur = '';
      }
      i = j;
      continue;
    }
    i++;
  }
  if (cur.trim()) sentences.push(cur);
  return sentences;
}

/**
 * Extracts a concise 1-2 sentence preview summary from raw comment body,
 * stripping common email greetings/salutations.
 */
export function extractSummary(body) {
  if (!body || typeof body !== 'string') return '';
  let text = body.replace(/\s*Expand Post\s*$/i, '').trim();
  // Strip common salutation lines (Dear ..., Hi ..., Hello ..., etc.)
  text = text.replace(/^(?:(?:dear|hi|hello|hey|good\s+(?:morning|afternoon|evening))\b[^\n,:]*[,\n:]*)+/i, '').trim();
  if (!text) return '';

  // Split into sentences. Numbered/bulleted list lines are kept whole
  // instead of being run through the sentence splitter: a naked "1." would
  // otherwise match as its own bogus "sentence" (the digit is a non-
  // terminator, the following "." is), silently dropping the rest of that
  // line and degenerating multi-step bodies into "1. 2." fragments.
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const sentences = [];
  for (const line of lines) {
    if (/^(?:\d+[.)]|[-*•])\s/.test(line)) {
      sentences.push(line);
    } else {
      sentences.push(...splitSentences(line));
    }
  }
  const meaningful = sentences
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 0 && !/^(?:thanks|thank you|regards|best regards|sincerely|cheers)[,.\s]*$/i.test(s));

  if (!meaningful.length) return '';
  let summary = meaningful.slice(0, 2).join(' ');
  if (summary.length > 300) {
    summary = summary.slice(0, 297) + '...';
  }
  return summary.replace(/\s*Expand Post\s*$/i, '').trim();
}

/**
 * Synthesizes an initial comment representing the case problem statement
 * from raw case description, if non-empty.
 */
export function synthesizeDescriptionComment(raw) {
  if (!raw) return null;
  const desc = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!desc) return null;

  const author = (typeof raw.contactName === 'string' && raw.contactName.trim())
    ? raw.contactName.trim()
    : 'Reporter';

  const timestamp = (typeof raw.openedAt === 'string' && raw.openedAt.trim())
    ? raw.openedAt.trim()
    : '';

  return {
    author,
    timestamp,
    body: raw.description,
    attachments: [],
  };
}

/**
 * Checks if a comment matching the case description is already present.
 */
export function hasDescriptionComment(comments, description) {
  if (!Array.isArray(comments) || !description || typeof description !== 'string') return false;
  const target = description.trim();
  if (!target) return false;
  return comments.some(c => c && typeof c.body === 'string' && c.body.trim() === target);
}

// The synthesized description comment is a presentation convenience derived
// from the Case's description field, not a captured Chatter feed item — the
// completeness gate must compare against genuine portal comments only.
export function genuineCommentCount(comments, description) {
  const total = Array.isArray(comments) ? comments.length : 0;
  return hasDescriptionComment(comments, description) ? total - 1 : total;
}

/**
 * Classifies author role into 'Qualcomm', 'Customer', or 'System' based on author name, company, and body clues.
 */
export function classifyRole(author, company = '', context = '', body = '') {
  const combined = ((author || '') + ' ' + (company || '') + ' ' + (context || '')).toLowerCase();
  if (
    combined.includes('qualcomm') ||
    combined.includes('@qualcomm.com') ||
    combined.includes('@qti.qualcomm.com') ||
    combined.includes('qcom') ||
    combined.includes('qti') ||
    combined.includes('qualcomm technologies') ||
    combined.includes('qualcomm support') ||
    combined.includes('qualcomm employee') ||
    combined.includes('qualcomm engineer')
  ) {
    return 'Qualcomm';
  }
  if (combined.includes('system') || combined.includes('automated process')) {
    return 'System';
  }
  const bodyLower = (body || '').toLowerCase();
  const firstLines = bodyLower.slice(0, 250);
  const lastLines = bodyLower.slice(-250);
  if (
    /^(?:dear|hi|hello)\s+customer\b/i.test(firstLines.trim()) ||
    /\bqualcomm\s+team\b/i.test(bodyLower) ||
    /\bqualcomm\s+support\b/i.test(bodyLower) ||
    /\bqualcomm\s+case\s+team\b/i.test(bodyLower) ||
    /(?:regards|thanks|sincerely)[,\s]+.*qualcomm/i.test(lastLines)
  ) {
    return 'Qualcomm';
  }
  if (/^(?:dear|hi|hello)\s+(?:qcom|qualcomm)\b/i.test(firstLines.trim())) {
    return 'Customer';
  }
  const authorLower = (author || '').toLowerCase();
  if (['aiden an', 'seunghoon lee', 'hoon lee', 'cs lee', 'kyungnam ken lee'].includes(authorLower)) {
    return 'Qualcomm';
  }
  return 'Customer';
}

/**
 * Normalizes and parses various timestamp formats into epoch milliseconds.
 * Supports ISO-8601, standard date strings, and Chatter relative formats.
 */
export function parseTimestamp(ts, referenceDate = new Date()) {
  if (!ts || typeof ts !== 'string') return 0;
  const s = ts.trim();
  if (!s) return 0;

  const now = referenceDate instanceof Date ? referenceDate.getTime() : (Number(referenceDate) || Date.now());

  // 1. Relative seconds / just now
  if (/^(?:just\s+now|right\s+now|a\s+few\s+seconds?\s+ago|seconds?\s+ago)$/i.test(s)) {
    return now;
  }
  const secMatch = s.match(/^(\d+)\s*s(?:ec(?:ond)?s?)?\s*ago$/i);
  if (secMatch) {
    return now - Number(secMatch[1]) * 1000;
  }

  // 2. Relative minutes
  const minMatch = s.match(/^(\d+)\s*(?:m|min(?:ute)?s?)\s*ago$/i);
  if (minMatch) {
    return now - Number(minMatch[1]) * 60 * 1000;
  }

  // 3. Relative hours
  const hrMatch = s.match(/^(\d+)\s*(?:h|hr|hours?|hrs?)\s*ago$/i);
  if (hrMatch) {
    return now - Number(hrMatch[1]) * 3600 * 1000;
  }

  // 4. Relative days
  const dayMatch = s.match(/^(\d+)\s*(?:d|days?)\s*ago$/i);
  if (dayMatch) {
    return now - Number(dayMatch[1]) * 86400 * 1000;
  }

  // 5. Relative weeks
  const wkMatch = s.match(/^(\d+)\s*(?:w|weeks?|wks?)\s*ago$/i);
  if (wkMatch) {
    return now - Number(wkMatch[1]) * 7 * 86400 * 1000;
  }

  // 6. Relative months
  const moMatch = s.match(/^(\d+)\s*(?:mo|month|months?|mos?)\s*ago$/i);
  if (moMatch) {
    return now - Number(moMatch[1]) * 30 * 86400 * 1000;
  }

  // 7. Relative years
  const yrMatch = s.match(/^(\d+)\s*(?:y|yr|years?|yrs?)\s*ago$/i);
  if (yrMatch) {
    return now - Number(yrMatch[1]) * 365 * 86400 * 1000;
  }

  // 8. Yesterday / Today
  if (/^yesterday/i.test(s)) {
    return now - 86400 * 1000;
  }
  if (/^today/i.test(s)) {
    return now;
  }

  // 9. Standard Date format (e.g. ISO 8601 or 'August 20, 2026 at 3:45 PM')
  const cleanDateStr = s.replace(/\bat\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const parsed = Date.parse(cleanDateStr);
  if (!isNaN(parsed)) {
    return parsed;
  }

  return 0;
}

/**
 * Checks if a timestamp string is a relative Chatter format (e.g. "12 days ago", "Just now", "Yesterday").
 */
export function isRelativeTimestamp(ts) {
  if (!ts || typeof ts !== 'string') return false;
  const s = ts.trim();
  if (!s) return false;
  return (
    /^(?:just\s+now|right\s+now|a\s+few\s+seconds?\s+ago|seconds?\s+ago)$/i.test(s) ||
    /^(\d+)\s*s(?:ec(?:ond)?s?)?\s*ago$/i.test(s) ||
    /^(\d+)\s*(?:m|min(?:ute)?s?)\s*ago$/i.test(s) ||
    /^(\d+)\s*(?:h|hr|hours?|hrs?)\s*ago$/i.test(s) ||
    /^(\d+)\s*(?:d|days?)\s*ago$/i.test(s) ||
    /^(\d+)\s*(?:w|weeks?|wks?)\s*ago$/i.test(s) ||
    /^(\d+)\s*(?:mo|month|months?|mos?)\s*ago$/i.test(s) ||
    /^(\d+)\s*(?:y|yr|years?|yrs?)\s*ago$/i.test(s) ||
    /^yesterday\b/i.test(s) ||
    /^today\b/i.test(s)
  );
}

/**
 * Normalizes any relative or non-ISO absolute Chatter timestamp to an ISO-8601
 * string resolved against capture reference date, retaining raw portal string
 * in `rawTimestamp`.
 */
export function normalizeComment(comment, referenceDate = new Date()) {
  if (!comment || typeof comment !== 'object') return comment;
  const rawTs = comment.timestamp || '';
  if (isBlacklistedTs(rawTs)) {
    return { ...comment, timestamp: '' };
  }
  const epoch = parseTimestamp(rawTs, referenceDate);
  if (epoch > 0) {
    return {
      ...comment,
      timestamp: new Date(epoch).toISOString(),
      rawTimestamp: comment.rawTimestamp || rawTs,
    };
  }
  return comment;
}

/**
 * Normalizes all comments in an array.
 */
export function normalizeComments(comments, referenceDate = new Date()) {
  if (!Array.isArray(comments)) return [];
  return comments.map(c => normalizeComment(c, referenceDate));
}

/**
 * Sorts comments strictly in chronological order (Oldest -> Newest).
 * If some comments have missing/unparseable timestamps, interpolate their position
 * based on their sequence in the input array and adjacent sibling timestamps
 * rather than mapping them to epoch 0.
 */
export function sortCommentsChronological(comments, referenceDate = new Date()) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const n = comments.length;

  // 1. Initial timestamp parsing
  const parsedTimes = comments.map(c => parseTimestamp(c.timestamp, referenceDate));

  // 2. Identify indices with known timestamps (> 0)
  const knownIndices = [];
  for (let i = 0; i < n; i++) {
    if (parsedTimes[i] > 0) {
      knownIndices.push(i);
    }
  }

  const times = [...parsedTimes];
  const STEP_MS = 1000; // 1 second spacing for extrapolations/offsets

  if (knownIndices.length === 0) {
    // All timestamps missing: preserve original index sequence
    const base = referenceDate.getTime();
    for (let i = 0; i < n; i++) {
      times[i] = base + i * STEP_MS;
    }
  } else if (knownIndices.length === 1) {
    // Single known timestamp: offset relative to it preserving index direction
    const k = knownIndices[0];
    const base = times[k];
    for (let i = 0; i < n; i++) {
      times[i] = base + (i - k) * STEP_MS;
    }
  } else {
    // Determine overall trend of known timestamps (increasing vs decreasing)
    const firstK = knownIndices[0];
    const lastK = knownIndices[knownIndices.length - 1];
    const isIncreasing = times[lastK] >= times[firstK];

    // Interpolate gaps between known indices
    for (let idx = 0; idx < knownIndices.length - 1; idx++) {
      const startIdx = knownIndices[idx];
      const endIdx = knownIndices[idx + 1];
      const startTime = times[startIdx];
      const endTime = times[endIdx];

      for (let i = startIdx + 1; i < endIdx; i++) {
        const fraction = (i - startIdx) / (endIdx - startIdx);
        times[i] = startTime + fraction * (endTime - startTime);
      }
    }

    // Extrapolate before first known index (indices 0 .. firstK - 1)
    for (let i = 0; i < firstK; i++) {
      if (isIncreasing) {
        // Earlier index is older
        times[i] = times[firstK] - (firstK - i) * STEP_MS;
      } else {
        // Earlier index is newer (DOM order where newest is at top)
        times[i] = times[firstK] + (firstK - i) * STEP_MS;
      }
    }

    // Extrapolate after last known index (indices lastK + 1 .. n - 1)
    for (let i = lastK + 1; i < n; i++) {
      if (isIncreasing) {
        // Later index is newer
        times[i] = times[lastK] + (i - lastK) * STEP_MS;
      } else {
        // Later index is older
        times[i] = times[lastK] - (i - lastK) * STEP_MS;
      }
    }
  }

  const indexed = comments.map((c, i) => ({
    c,
    originalIndex: i,
    effectiveTime: times[i],
  }));

  indexed.sort((a, b) => {
    if (a.effectiveTime !== b.effectiveTime) {
      return a.effectiveTime - b.effectiveTime;
    }
    // Tied timestamp (e.g. both "15 days ago"): prefer displayPosition, the
    // article's on-page vertical offset captured independently of extraction
    // order (extract_case.js). originalIndex is only a fallback for comments
    // that never got a displayPosition (e.g. legacy cached data).
    const aPos = a.c.displayPosition;
    const bPos = b.c.displayPosition;
    if (typeof aPos === 'number' && typeof bPos === 'number' && aPos !== bPos) {
      return aPos - bPos;
    }
    return a.originalIndex - b.originalIndex;
  });

  return indexed.map(item => item.c);
}

// Final PRESENTATION order for case.json/case.md (supersedes PRD #105-109's
// strict Oldest -> Newest "Variant A"): newest activity first, with each reply
// grouped immediately after its parent (both threads and same-thread replies
// ordered newest-first). Input must already be ascending (sortCommentsChronological's
// output) — that ascending order is what lets "last-seen sibling = newest sibling"
// hold without re-parsing timestamps a second time.
export function orderCommentsForPresentation(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const byId = new Map(comments.map(c => [c.id, c]));
  const childrenOf = new Map();
  const topLevel = [];
  for (const c of comments) {
    const parent = c.parentId != null && c.parentId !== c.id ? byId.get(c.parentId) : null;
    if (parent) {
      if (!childrenOf.has(parent.id)) childrenOf.set(parent.id, []);
      childrenOf.get(parent.id).push(c);
    } else {
      topLevel.push(c);
    }
  }
  const out = [];
  for (let i = topLevel.length - 1; i >= 0; i--) {
    const parent = topLevel[i];
    out.push(parent);
    const kids = childrenOf.get(parent.id);
    if (kids) {
      for (let j = kids.length - 1; j >= 0; j--) out.push(kids[j]);
    }
  }
  return out;
}

// Merge raw comments not already cached and enforce chronological sorting (Oldest -> Newest).
// Cached comments are kept verbatim — an update run never rewrites old bodies.
// Both lists must already carry content ids (see assignIds), so dedup is an id
// lookup rather than a second, separately-drifting heuristic.
export function mergeComments(cachedComments, rawComments, referenceDate = new Date()) {
  const cache = cachedComments || [];
  const have = new Set(cache.map(c => c.id));
  const fresh = [];
  const possibleEdits = [];
  for (const c of rawComments || []) {
    if (have.has(c.id)) continue;
    have.add(c.id);
    fresh.push(c);
    const author = String(c.author || '').trim();
    const candidate = cache
      .filter(o => String(o.author || '').trim() === author)
      .map(o => ({ o, similarity: bodySimilarity(o.body, c.body) }))
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (candidate && candidate.similarity >= POSSIBLE_EDIT_SIMILARITY) {
      possibleEdits.push({ author, oldId: candidate.o.id, newId: c.id });
    }
  }
  const freshChronological = [...fresh].reverse();
  const merged = sortCommentsChronological([...cache, ...freshChronological], referenceDate);
  return { merged, newIds: fresh.map(c => c.id), possibleEdits };
}

// ---- Main ----
export function finalize(caseCode, rawPath, header = {}, merge = false, options = {}) {
  if (!existsSync(rawPath)) {
    return { code: EXIT.BAD_ARGS, reason: `raw JSON not found: ${rawPath}` };
  }

  // options.casesDir lets a direct/programmatic caller (tests, and any future
  // script) point finalize() at a throwaway directory instead of the real
  // DATA_DIR — every read AND write below goes through this, not just the
  // overview sync at the bottom. A prior version of this override only reached
  // afterFinalize(), so an in-process test call using a real case code (e.g.
  // "08603854", used throughout this test suite) silently overwrote that real
  // case's cached data via DATA_DIR — confirmed on a real checkout, not
  // hypothetical.
  const casesDir = options.casesDir || DATA_DIR;
  const indexPath = join(casesDir, '_index.json');

  const rawText = readFileSync(rawPath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText);
  } catch (e) {
    return { code: EXIT.BAD_ARGS, reason: `raw JSON parse error: ${e.message}` };
  }

  if (!raw || !Array.isArray(raw.comments)) {
    return { code: EXIT.BAD_ARGS, reason: 'raw.comments must be an array' };
  }

  // A real Qualcomm case always has at least the opening post. Zero comments means
  // the extractor ran on the wrong view (Feed not loaded, drifted to the Cases list,
  // session expired) — reject so a failed pull never OVERWRITES a good cached case.
  if (raw.comments.length === 0) {
    return { code: EXIT.INCOMPLETE, reason: 'extracted 0 comments — likely wrong page / failed capture; not persisting', caseCode };
  }

  // Reference date for resolving relative Chatter timestamps (e.g. "12 days ago")
  // into absolute ISO strings at capture time. Injected via options or --ref-date for tests.
  const refDate = options.referenceDate
    ? (options.referenceDate instanceof Date ? options.referenceDate : new Date(options.referenceDate))
    : (header.refDate ? new Date(header.refDate) : new Date());

  // Read the cache once — BOTH paths need it, to union comments rather than
  // letting a thinner fresh capture silently drop one already confirmed to exist.
  const casePath = join(casesDir, caseCode, 'case.json');
  let cached = null;
  if (existsSync(casePath)) {
    try {
      const t = readFileSync(casePath, 'utf8');
      cached = migrateIds(JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t));
    } catch (e) {
      if (merge) {
        return { code: EXIT.BAD_ARGS, reason: `cached case.json parse error: ${e.message}`, caseCode };
      }
      // Full capture over an unreadable cache: the fresh pull replaces it wholesale.
      process.stderr.write(`Warning: cached case.json unreadable (${e.message}), replacing it\n`);
    }
  }
  if (merge && !cached) {
    return { code: EXIT.BAD_ARGS, reason: `--merge but no cached case.json at ${casePath} — run a full extraction (no --merge) first`, caseCode };
  }

  // Inject description as initial comment if non-empty and not already present.
  // Inject description as initial comment if non-empty and not already present.
  const descRaw = {
    description: String(raw.description || (cached && cached.description) || '').trim(),
    contactName: String(raw.contactName || (cached && cached.contactName) || '').trim(),
    openedAt: String(raw.openedAt || (cached && cached.openedAt) || '').trim(),
  };
  const descComment = synthesizeDescriptionComment(descRaw);
  let rawComments = normalizeComments(raw.comments || [], refDate);
  if (descComment && !hasDescriptionComment(rawComments, descRaw.description)) {
    rawComments.push(normalizeComment(descComment, refDate));
  }

  // Identity is assigned HERE, in code, for every comment we persist.
  const fresh = assignIds(rawComments);

  // Resolve parentId from parentIndex while fresh.comments is still in DOM order
  for (const c of fresh.comments) {
    if (c.parentId === undefined) {
      if (c.parentIndex != null && fresh.comments[c.parentIndex]) {
        c.parentId = fresh.comments[c.parentIndex].id;
      } else {
        c.parentId = null;
      }
    }
  }

  // `out` is the object that gets persisted. Full capture: the raw itself.
  // Update run (--merge): the cached case with only the NEW comments prepended.
  let out;
  let mergeInfo = null;
  let newIds = [];
  let possibleEdits = [];
  if (merge) {
    const merge0 = mergeComments(cached.comments || [], fresh.comments, refDate);
    newIds = merge0.newIds;
    possibleEdits = merge0.possibleEdits;
    // Start from the cache: every already-captured field survives.
    out = { ...cached, comments: merge0.merged };
    // Fresh page values that are always current truth:
    if (raw.displayedCommentCount != null) out.displayedCommentCount = raw.displayedCommentCount;
    // Capture evidence always describes THIS run, never the previous one.
    if (raw.capture) out.capture = raw.capture;
    if (String(raw.url || '').trim()) out.url = raw.url;
    // Everything else from the partial capture only FILLS BLANKS — a collapsed
    // Description/Detail panel must never clobber a good cached value.
    for (const k of ['description', 'product', 'updated', ...DETAIL_KEYS, ...HEADER_KEYS]) {
      if (!String(out[k] || '').trim() && String(raw[k] || '').trim()) out[k] = raw[k];
    }
    mergeInfo = { newIds, oldHash: cached.hash, cached };
  } else {
    // Full capture: header/description/etc. are complete by definition and
    // replace the cache. Comments are UNIONED with whatever is already
    // cached, not replaced — a thinner fresh extraction (Chatter feed lazy-
    // load stopping short, a transient portal hiccup) must never silently
    // DROP comments already confirmed to exist; a comment missing from one
    // capture is not proof it is gone for good. This is the same dedup as
    // --merge; a full run can only grow the comment list, never shrink it.
    const cachedComments = cached ? (cached.comments || []) : [];
    const merge0 = mergeComments(cachedComments, fresh.comments, refDate);
    newIds = merge0.newIds;
    possibleEdits = merge0.possibleEdits;
    out = { ...raw, comments: merge0.merged };
    if (cached) {
      for (const k of ['description', 'product', 'updated', ...DETAIL_KEYS]) {
        if (!String(out[k] || '').trim() && String(cached[k] || '').trim()) out[k] = cached[k];
      }
      mergeInfo = { newIds, oldHash: cached.hash, cached };
    }
  }

  // Normalize URL to always point to Communication tab (tabset-XXXX=1)
  if (typeof out.url === 'string' && out.url.trim()) {
    out.url = out.url.replace(/tabset-([a-zA-Z0-9_-]+)=\d+/gi, 'tabset-$1=1');
  }

  // Hard gate: a genuinely NEW comment that still carries the "Expand Post"
  // control label is a half-captured post, whatever the cause. Reject rather
  // than persist it — a truncated body silently baked into the cache is worse
  // than a capture that fails loud and gets retried.
  const collapsed = findCollapsed(out.comments, newIds);
  if (collapsed.length) {
    return {
      code: EXIT.INCOMPLETE,
      reason: `${collapsed.length} new comment(s) still show a collapsed "Expand Post" control — expansion incomplete, not persisting`,
      collapsedAuthors: collapsed.map(c => c.author),
      caseCode,
    };
  }

  // Completeness gate BEFORE any write — a short capture is not persisted.
  // Uses the genuine comment count: the synthesized description comment must
  // not pad the count and mask one real Chatter comment missing.
  const assertion = countAssert(genuineCommentCount(out.comments, out.description), out.displayedCommentCount);
  if (!assertion.ok) {
    return { code: EXIT.INCOMPLETE, ...assertion, caseCode };
  }

  // Header fields from CLI flags (PHASE 1 search row). Full capture: only fill
  // where the Feed extractor left them blank, so a real extracted value always
  // wins. Update run: flags WIN over the cache — they are the freshest truth
  // (Status/Priority change over a case's life; that's often the whole update).
  for (const k of HEADER_KEYS) {
    const v = String(header[k] || '').trim();
    if (!v) continue;
    if (merge || !String(out[k] || '').trim()) out[k] = v;
  }

  // Header gate: title drives the human-facing heading. The extractor leaves it
  // "" on the Feed view; the agent must backfill it from the PHASE 1 search row
  // (pass `--title`). An empty title is a failed pull dressed as success (the
  // renderer would fall back to "Untitled case"), so reject rather than persist.
  if (!String(out.title || '').trim()) {
    return {
      code: EXIT.INCOMPLETE,
      reason: 'empty title — backfill header fields (title/status/priority) from the PHASE 1 search row before finalizing',
      caseCode,
    };
  }

  // Soft signal for the remaining header fields — sometimes legitimately empty
  // (old/closed/draft cases), so warn but do NOT block.
  const thinHeader = ['status', 'priority'].filter(k => !String(out[k] || '').trim());

  // Comments must never carry role/company — scrub them here so an --merge or
  // full re-capture of a case cached before this field was dropped gets
  // cleaned on its next capture, with no separate migration pass.
  // displayPosition is also scrubbed: it's a getBoundingClientRect().top value
  // from ONE extraction pass (sortCommentsChronological's tie-break signal,
  // already consumed by mergeComments above), not durable content — persisting
  // it would let a future run's tie-break compare positions measured on two
  // different page loads, which is meaningless.
  // Preview is generated HERE, for every persisted comment — fresh, cached,
  // and the synthesized description comment alike — so this is the single
  // place a comment's preview is ever derived (see extractSummary above).
  out.comments = out.comments.map(({ role, company, displayPosition, isReply, parentIndex, ...rest }) => ({
    ...rest,
    parentId: rest.parentId ?? null,
    summary: extractSummary(rest.body),
  }));

  // Final PRESENTATION order: newest-first, replies grouped under their parent
  // (see orderCommentsForPresentation above — supersedes PRD #105-109's strict
  // Oldest -> Newest). Applied last, after ids/parentId/summary are settled, so
  // it only reorders — never recomputes — the array computeHash below covers.
  out.comments = orderCommentsForPresentation(out.comments);

  // Stamp identity + write canonical JSON.
  out.hash = computeHash(out);
  out.extractedAt = new Date().toISOString();

  // Per-case folder: data/cases/<CODE>/case.json — keeps all artifacts (render
  // md/html/txt, pdf) together. _index.json stays at casesDir root (cross-case).
  const caseDir = join(casesDir, caseCode);
  mkdirSync(caseDir, { recursive: true });
  const outPath = join(caseDir, 'case.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

  // Delete the raw scratch capture ourselves, now that the canonical case.json is
  // written. Previously the SKILL told the agent to `del`/`rm` it in a follow-up
  // shell line, which thrashed on Windows dialect (`del /F` in cmd vs Remove-Item
  // in PowerShell vs `rm` in Bash). Owning it here keeps cleanup cross-platform and
  // one turn shorter. Only runs on the success path (we're about to exit OK).
  try { rmSync(rawPath, { force: true }); } catch { /* non-fatal: leftover scratch is harmless */ }

  // Merge into _index.json.
  let index = {};
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      process.stderr.write('Warning: _index.json unreadable, starting fresh\n');
    }
  }
  index[caseCode] = {
    syncedAt: out.extractedAt,
    commentCount: out.comments.length,
    hash: out.hash,
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

  // Auto-sync cases overview and dashboard
  afterFinalize(caseCode, casesDir, options);

  // Verdict fields the agent branches on. Emitted whenever a cached case existed,
  // including a FULL re-capture of one — the agent sees exactly which comments
  // are genuinely new, whatever the capture mode.
  //   newComments > 0                      -> report the new comments, re-render
  //   newComments 0 but headerChanged      -> re-render only
  //   newComments 0, !headerChanged, !changed -> "no update", STOP
  const mergeVerdict = mergeInfo
    ? {
        newComments: mergeInfo.newIds.length,
        newCommentIds: mergeInfo.newIds,
        changed: out.hash !== mergeInfo.oldHash,
        headerChanged: HEADER_KEYS.some(k =>
          String(header[k] || '').trim() &&
          String(header[k]).trim() !== String(mergeInfo.cached[k] || '').trim()),
      }
    : {};

  return {
    code: EXIT.OK,
    caseCode,
    commentCount: out.comments.length,
    hash: out.hash,
    path: outPath,
    ...mergeVerdict,
    // Ambiguous identity is surfaced, never resolved silently (see assignIds).
    ...(fresh.collisions.length ? { idCollisions: fresh.collisions.length } : {}),
    // A same-author, high-similarity "new" comment may be an edit of an old one
    // (I3) — surfaced for a human to check, never auto-merged (see mergeComments).
    ...(possibleEdits.length ? { possibleEdits } : {}),
    ...(assertion.warning || thinHeader.length
      ? { warning: [assertion.warning, thinHeader.length ? `empty header fields: ${thinHeader.join(', ')}` : '']
          .filter(Boolean).join('; ') }
      : {}),
  };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Entry point guard — prevents finalize() running when imported for tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const caseCode = process.argv[2]?.trim().toUpperCase();
  const rawPath = process.argv[3]?.trim();
  if (!caseCode || !rawPath) {
    emit({ code: EXIT.BAD_ARGS, reason: 'usage: node finalize_case.mjs <CASE_CODE> <rawJsonPath> [--merge] [--title "..." --status "..." --priority "..."]' });
    process.exit(EXIT.BAD_ARGS);
  }
  const rest = process.argv.slice(4);
  const result = finalize(caseCode, rawPath, parseHeaderFlags(rest), rest.includes('--merge'));
  emit(result);
  process.exit(result.code);
}
