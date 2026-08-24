---
ID: #112
Status: AFK
Blocked by: []
Type: Tracer Bullet
---

## Parent
Part of #105 — spec: `docs/prd/case-detail-and-threaded-comments.md`

## What to build
Change `case.json`'s Detail-tab-field empty-value convention from `""` to `null`, uniformly across
every `sectionValue()`-derived field (no per-field exception — `title`/`status`/`priority`/
`caseRecordType` included). Drop `customer` (dup of `accountName`), `created` (dup of `openedAt`),
and `raisedBy` (derived from `customer`, which is going away). Add `customerTracking` as a new
Detail-tab field.

1. `extract_case.js`: `sectionValue()` (~L121-124) returns `null` instead of `""` as its base case.
   Delete the `customer`/`created`/`raisedBy` derivation lines and their 3 keys in the returned
   object (~L387-388, 395, 398, 407, 415). Add `customerTracking = sectionValue(["Customer
   Tracking", "Customer Tracking Number", "Customer Tracking#"])` and include it in the returned
   object. (Label list is an unverified guess — flag as TBD in a code comment, don't treat as
   settled DOM fact.)
2. `scrape_case.mjs`:
   - `HEADER_KEYS` (L120): remove `'customer'`.
   - `DETAIL_KEYS` (L123-132): remove `'raisedBy'`, add `'customerTracking'`.
   - `descRaw` construction (~L735, 737): drop `customer`/`created` reads.
   - `synthesizeDescriptionComment` (~L332-351, fallback branches ~L339, L343): remove the
     `raw.customer`/`raw.created` fallback branches, fall through to the next existing fallback.
   - Merge-fill loops (~L767, L785): remove `'created'` from the field-copy lists.
   - Cross-fill block (~L793-798, the `if (out.accountName && !out.customer) ...` etc.): delete
     entirely.
   - `thinHeader` (~L849): remove `'customer'` from `['status', 'priority', 'customer']`.
3. `verify_case.mjs`: remove `'created'`, `'customer'` from `OPTIONAL_FIELDS_WARN_IF_EMPTY` (L24).
4. `find_case_link.js` (L56): remove the `customer` field capture from the header/search-row pass.
5. `fast_landing.mjs` (L141, L271): same removal; drop the `customer` key from the cached-fields
   object literal at L271.
6. `run_case.mjs`: in the `mergeDetailFields(...)` call (~L424-442), remove `'customer'`,
   `'created'`, `'raisedBy'`; add `'customerTracking'`.
7. `render_case.mjs` (L109-120): delete the `Customer`/`Created` rows; simplify Account Name to
   `['Account Name', data?.accountName]` (drop the now-always-true `!== data?.customer` check); add
   a `Customer Tracking` row.

## Acceptance criteria
- [ ] A fresh capture (or `--merge` re-run) of any case never emits `customer`, `created`, or
      `raisedBy` in `case.json`.
- [ ] Every Detail-tab field the portal doesn't show is `null` in `case.json`, not `""` — including
      `title`/`status`/`priority`/`caseRecordType` in the (currently unseen) case where they'd be
      empty.
- [ ] `customerTracking` appears in `case.json` (as `null` on all 4 currently-cached cases, until a
      real case with the field is captured) and renders as a row in `case.md` when non-null.
- [ ] `scrape_case.mjs`'s `thinHeader` warning and `verify_case.mjs`'s QA gate never fire on
      `customer`/`created` again (no permanent false-positive).
- [ ] `render_case.mjs`'s Account Name row always renders when `accountName` is present (no more
      suppression-when-equal-to-Customer).

## Notes
- Removing `'customer'` from `HEADER_KEYS` also shrinks the `headerChanged` signal at
  `scrape_case.mjs:919`, which feeds the `updated`-vs-`no-update` verdict. Harmless — a field that
  no longer exists can't change — but flagging so it's a considered effect, not a missed one; not
  covered in #107's original sweep.

## Blocked by
None (can start immediately — independent of #106's `parentId` finding)
