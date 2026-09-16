// scripts/finalize_description.mjs
//
// Description-as-first-comment policy (PRD #53 / Issues #54-56): synthesizes
// the Case's description field into a presentation comment when the portal
// feed does not already carry it, and derives the 1-2 sentence preview
// summary persisted on every comment.

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
