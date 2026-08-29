// cap.mjs - pure character-cap guard for qualcomm-case-summary.
// A hard input-size safety guard against a pathological comment body (e.g. a huge
// embedded trace log) blowing up the summarization step's input size. Not a
// summarization or log-detection step: no attempt to find/strip log content.

export const CHAR_CAP = 20000;

export function applyCharCap(body, cap = CHAR_CAP) {
  return body.length > cap ? body.slice(0, cap) : body;
}

export function applyCharCapToComments(comments, cap = CHAR_CAP) {
  return comments.map((c) => ({ ...c, body: applyCharCap(c.body, cap) }));
}
