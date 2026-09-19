// Sole owner of the Detail Field Provenance policy (CONTEXT.md, ADR 0008):
// deciding, per Detail-tab field, whether a fresh portal value should
// overwrite the cached case.json or the cached value should win.
//
// Two callers, two halves of the same policy:
//   - run_case.mjs (live-probe half): mergeDetailFields folds a Detail-tab
//     re-scrape into `raw` and records provenance; detailFieldsDiffer feeds
//     the fast no-update probe's drift check.
//   - finalize_case.mjs (persist-time half): applyDetailFieldOverrides
//     applies that same provenance to the cached case on an update run.
//
// MERGE_FIELDS is the one field list both halves share. Issue #265: this
// list used to be duplicated by hand in each file (run_case.mjs's
// DETAIL_MERGE_FIELDS and finalize_case.mjs's inline array literal), and the
// two copies had already drifted onto different orderings once.

import { DETAIL_KEYS } from './finalize_header.mjs';

// Detail-tab metadata fields merged into `raw` every run (see mergeDetailFields
// below) and applied to the cache on an update run (see applyDetailFieldOverrides).
export const MERGE_FIELDS = [
  ...DETAIL_KEYS, 'description', 'title', 'status', 'priority', 'severity', 'product', 'updated',
];

// Fields the fast no-update probe checks for drift (see detailFieldsDiffer).
// Deliberately NOT MERGE_FIELDS minus a filter — this list is a
// separate, explicit provenance decision and must stay that way so a future
// edit to MERGE_FIELDS can't silently change it too:
//   - status/priority: search-row-owned on a merge run, not Detail-tab-owned —
//     finalize_case.mjs's HEADER_KEYS loop always overwrites them from the
//     fresh search row (run_case.mjs always passes header.status/priority),
//     and a genuine change there is already caught by finalize's
//     headerChanged. Comparing the Detail tab's status/priority against a
//     cache written from the search row compares two different sources of
//     truth for the same field and would misfire on every run.
//   - updated (Last Modified Date): the portal churns it on its own schedule
//     independent of anything worth reporting, so it would defeat the fast
//     path even when nothing user-visible moved.
export const DRIFT_CHECK_FIELDS = [
  ...DETAIL_KEYS, 'description', 'title', 'severity', 'product',
];

// The fast no-update probe short-circuits BEFORE finalize() ever runs (no
// write, no detailChanged plumbing — cdp_portal_driver.mjs returns noUpdate
// straight from the probe). A Detail-tab-only change (case renamed,
// re-severitized, …) with zero new comments must not be swallowed by that
// shortcut just because the Chatter feed itself looks unchanged — so the
// probe path re-checks the one other thing finalize() would have caught.
// Field provenance mirrors finalize_case.mjs's detailFields gate: only a field
// THIS probe's Detail-tab read actually supplied counts, never a stale/blank
// or wrong-DOM-region value.
export function detailFieldsDiffer(detailRaw, cached, fields) {
  if (!detailRaw || !cached) return false;
  for (const f of fields) {
    const v = String(detailRaw[f] || '').trim();
    if (!v) continue;
    if (v !== String(cached[f] || '').trim()) return true;
  }
  return false;
}

/**
 * Detail tab is the only tab that actually renders `fields`; Feed-tab `raw` can still
 * stumble onto a non-empty value for them (wrong DOM region), so detailRaw wins whenever
 * present, and raw is the fallback only when detailRaw didn't capture the field.
 * Mutates and returns `raw`. Also records which field names detailRaw actually supplied,
 * as `raw.detailFields` — a field this case's Detail tab genuinely doesn't render (e.g.
 * no Severity picklist) is NOT in that list even though `raw[f]` still holds the Feed-tab
 * fallback value, so applyDetailFieldOverrides can tell "current truth from a live
 * Detail-tab read" apart from "stale Feed-tab noise" per field, not just per capture.
 */
export function mergeDetailFields(raw, detailRaw, fields) {
  if (!detailRaw) return raw;
  raw.detailFields = raw.detailFields || [];
  for (const f of fields) {
    if (detailRaw[f]) {
      raw[f] = detailRaw[f];
      raw.detailFields.push(f);
    }
  }
  return raw;
}

/**
 * Persist-time half of the policy: applies `raw`'s Detail Field Provenance
 * (`raw.detailFields`, set by mergeDetailFields above) onto the cached `out`
 * object finalize_case.mjs's --merge branch is building. A field a field
 * THIS run's Detail tab actually rendered (raw.detailFields) is current
 * truth and overwrites the cache, the same way status/priority already do
 * via HEADER_KEYS — so a case renamed or re-severitized in the portal is
 * reflected on its next update run instead of staying frozen at whatever the
 * first capture saw. `raw.detailExtracted` alone is NOT enough to gate this:
 * it only means the tab switch worked, not that this particular field
 * rendered — a field absent from this case's Detail tab (e.g. no Severity
 * picklist) leaves `raw[k]` holding whatever the Feed-tab region of the page
 * happened to match, which must never clobber a good cached value. So:
 * overwrite only when this field is in detailFields; otherwise FILL BLANKS
 * ONLY. Mutates `out` in place, returns `{ changed }` — `changed` is true iff
 * some field's cached value differed from a freshly-provenanced value
 * (distinct from finalize_case.mjs's comment-hash `changed` and CLI-flag-only
 * `headerChanged`; see finalize_case.mjs's mergeVerdict).
 */
export function applyDetailFieldOverrides(out, raw, fields) {
  const detailFields = Array.isArray(raw.detailFields) ? raw.detailFields : [];
  let changed = false;
  for (const k of fields) {
    const freshVal = String(raw[k] || '').trim();
    if (!freshVal) continue;
    const prev = String(out[k] || '').trim();
    if (detailFields.includes(k)) {
      if (prev !== freshVal) changed = true;
      out[k] = raw[k];
    } else if (!prev) {
      out[k] = raw[k];
    }
  }
  return { changed };
}
