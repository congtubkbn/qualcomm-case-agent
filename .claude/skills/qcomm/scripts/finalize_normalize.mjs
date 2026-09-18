// scripts/finalize_normalize.mjs
//
// Timestamp and author-role normalization policy: Chatter relative timestamps
// ("13h ago") resolved to absolute ISO-8601 against a capture reference date,
// chronological ordering with a display-position tie-break, and author role
// classification (Qualcomm / Customer / System) used by the renderer.

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
    // order (dom_extractor.js's QC.extractCase()). originalIndex is only a fallback for comments
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
