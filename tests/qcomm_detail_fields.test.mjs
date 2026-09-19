// Tests for detail_fields.mjs — the sole owner of the Detail Field
// Provenance policy (CONTEXT.md, ADR 0008). Moved here from
// qcomm_run_case.test.mjs (mergeDetailFields) and qcomm_finalize_case.test.mjs
// (the merge-branch overwrite/fill-blank assertions) when those two files'
// halves of this policy were consolidated (#265).
//     node --test tests/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mergeDetailFields,
  detailFieldsDiffer,
  applyDetailFieldOverrides,
  MERGE_FIELDS,
  DRIFT_CHECK_FIELDS,
} from '../.claude/skills/qcomm/scripts/detail_fields.mjs';
import { DETAIL_KEYS } from '../.claude/skills/qcomm/scripts/finalize_header.mjs';

describe('MERGE_FIELDS / DRIFT_CHECK_FIELDS', () => {
  it('MERGE_FIELDS is DETAIL_KEYS plus the header/description/product/updated fields', () => {
    for (const k of DETAIL_KEYS) assert.ok(MERGE_FIELDS.includes(k));
    for (const k of ['description', 'title', 'status', 'priority', 'severity', 'product', 'updated']) {
      assert.ok(MERGE_FIELDS.includes(k), `MERGE_FIELDS missing ${k}`);
    }
  });

  // status/priority/updated are deliberately excluded — see detail_fields.mjs's
  // docstring for why (search-row-owned field, and a portal counter that
  // churns on its own schedule, respectively).
  it('DRIFT_CHECK_FIELDS excludes status, priority, and updated', () => {
    for (const k of ['status', 'priority', 'updated']) assert.ok(!DRIFT_CHECK_FIELDS.includes(k));
    for (const k of DETAIL_KEYS) assert.ok(DRIFT_CHECK_FIELDS.includes(k));
  });
});

describe('mergeDetailFields', () => {
  it('prefers detailRaw over a differing raw value (regression: case 08417053)', () => {
    const raw = { contactName: 'Sang Bui' };
    const detailRaw = { contactName: 'Duc Hoang' };
    const merged = mergeDetailFields(raw, detailRaw, ['contactName']);
    assert.equal(merged.contactName, 'Duc Hoang');
  });

  it('keeps using detailRaw when raw is empty', () => {
    const merged = mergeDetailFields({ contactName: '' }, { contactName: 'Duc Hoang' }, ['contactName']);
    assert.equal(merged.contactName, 'Duc Hoang');
  });

  it('falls back to raw when detailRaw is absent/empty for that field', () => {
    const merged = mergeDetailFields({ contactName: 'Sang Bui' }, { contactName: '' }, ['contactName']);
    assert.equal(merged.contactName, 'Sang Bui');
  });

  it('returns raw unchanged when detailRaw itself is null/absent', () => {
    const raw = { contactName: 'Sang Bui' };
    const merged = mergeDetailFields(raw, null, ['contactName']);
    assert.equal(merged, raw);
    assert.equal(merged.contactName, 'Sang Bui');
  });

  it('leaves fields outside the given list untouched regardless of either value', () => {
    const raw = { contactName: 'Sang Bui', unrelated: 'raw-value' };
    const detailRaw = { contactName: 'Duc Hoang', unrelated: 'detail-value' };
    const merged = mergeDetailFields(raw, detailRaw, ['contactName']);
    assert.equal(merged.unrelated, 'raw-value');
  });

  it('records which fields detailRaw actually supplied, as raw.detailFields', () => {
    const raw = { title: 'old' };
    const detailRaw = { title: 'new', severity: '' };
    const merged = mergeDetailFields(raw, detailRaw, ['title', 'severity']);
    assert.deepEqual(merged.detailFields, ['title']);
  });
});

describe('detailFieldsDiffer', () => {
  it('returns false when detailRaw or cached is absent', () => {
    assert.equal(detailFieldsDiffer(null, { title: 'x' }, ['title']), false);
    assert.equal(detailFieldsDiffer({ title: 'x' }, null, ['title']), false);
  });

  it('returns true when a checked field disagrees with the cache', () => {
    const detailRaw = { title: 'RENAMED TITLE' };
    const cached = { title: 'Old Title' };
    assert.equal(detailFieldsDiffer(detailRaw, cached, ['title']), true);
  });

  it('returns false when every checked field matches the cache', () => {
    const detailRaw = { title: 'Stable Title', severity: 'S2' };
    const cached = { title: 'Stable Title', severity: 'S2' };
    assert.equal(detailFieldsDiffer(detailRaw, cached, ['title', 'severity']), false);
  });

  it('ignores a blank/unread field on the probe rather than treating it as drift', () => {
    const detailRaw = { title: '' };
    const cached = { title: 'Old Title' };
    assert.equal(detailFieldsDiffer(detailRaw, cached, ['title']), false);
  });

  it('only compares the fields given, not every key present on either object', () => {
    const detailRaw = { title: 'Stable Title', status: 'Open' };
    const cached = { title: 'Stable Title', status: 'Closed' };
    assert.equal(detailFieldsDiffer(detailRaw, cached, ['title']), false);
  });
});

describe('applyDetailFieldOverrides', () => {
  // Bug: run_case.mjs re-scrapes the Detail tab on every run and merges it into
  // raw (title/severity/etc. — see mergeDetailFields), but an update run used
  // to only "fill blanks" for those fields. A case renamed in the portal after
  // the first capture never updated locally: the frozen first-capture title
  // persisted forever even though the Detail-tab re-scrape saw the new value
  // on every single run. A field the Detail tab actually rendered this run
  // (raw.detailFields) must overwrite the cache, same as status/priority already do.
  it('refreshes title/severity from a successful Detail-tab re-scrape on an update run', () => {
    const out = { title: 'NR SA attach failure', severity: '' };
    const raw = { title: 'NR SA attach failure — RENAMED', severity: 'S1', detailFields: ['title', 'severity'] };
    const { changed } = applyDetailFieldOverrides(out, raw, ['title', 'severity']);
    assert.equal(out.title, 'NR SA attach failure — RENAMED', 'live Detail-tab title must win on an update run, not the frozen first-capture title');
    assert.equal(out.severity, 'S1');
    assert.equal(changed, true);
  });

  // detailFields is per-FIELD provenance, not the per-capture detailExtracted
  // flag: a field the Detail tab genuinely doesn't render for this case (e.g.
  // no Product field) stays out of detailFields even though `raw[k]` still
  // holds whatever the Feed-tab region of the page happened to match —
  // documented in mergeDetailFields's docstring as "can stumble onto a
  // non-empty value ... wrong DOM region". Only detailExtracted-gating (no
  // per-field list) would let that Feed-tab noise overwrite a good cached value.
  it('does not let Feed-tab noise overwrite a cached field the Detail tab did not actually re-render', () => {
    const out = { product: 'SM8650' };
    const raw = { product: 'garbage-from-feed', detailFields: ['title'] };
    const { changed } = applyDetailFieldOverrides(out, raw, ['product']);
    assert.equal(out.product, 'SM8650', 'a field the Detail tab did not re-render must never be clobbered by Feed-tab noise');
    assert.equal(changed, false);
  });

  // detailExtracted is a per-CAPTURE flag ("the Detail tab switch worked and
  // extractCase() returned something"), not per-FIELD provenance: a field the
  // Detail tab genuinely doesn't render for this case stays at whatever the
  // Feed-tab region of `raw` happened to hold. Trusting detailExtracted alone
  // (no per-field list) lets that Feed-tab noise overwrite a good cached value.
  it('keeps the cached title when the Detail-tab re-scrape failed (thin/degraded capture)', () => {
    const out = { title: 'NR SA attach failure' };
    const raw = { title: '' }; // Feed-tab alone left title blank; Detail switch failed
    const { changed } = applyDetailFieldOverrides(out, raw, ['title']);
    assert.equal(out.title, 'NR SA attach failure', 'a degraded capture must never clobber the cached title');
    assert.equal(changed, false);
  });

  it('fills a blank cached field from raw when the Detail tab did not supply provenance for it', () => {
    const out = { accountName: '' };
    const raw = { accountName: 'VinFast Auto LLC' };
    const { changed } = applyDetailFieldOverrides(out, raw, ['accountName']);
    assert.equal(out.accountName, 'VinFast Auto LLC');
    assert.equal(changed, false, 'filling a blank is not a change worth reporting in the verdict');
  });

  it('only reports changed for a field whose value actually differs from the cache', () => {
    const out = { title: 'Same Title' };
    const raw = { title: 'Same Title', detailFields: ['title'] };
    const { changed } = applyDetailFieldOverrides(out, raw, ['title']);
    assert.equal(changed, false);
  });

  it('mutates out in place and also returns it via the changed flag on the same object', () => {
    const out = { title: 'old' };
    const raw = { title: 'new', detailFields: ['title'] };
    const result = applyDetailFieldOverrides(out, raw, ['title']);
    assert.equal(out.title, 'new');
    assert.deepEqual(result, { changed: true });
  });
});
