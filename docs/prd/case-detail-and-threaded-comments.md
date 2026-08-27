# Case Detail Schema + Threaded Comments

> **Partially superseded 2026-08-27** (case 08516422 review): §3's "Variant A" — strict
> Oldest → Newest, no renumbering by thread — is no longer what's persisted. `case.json`/`case.md`
> now order comments newest-first with each Reply grouped immediately after its parent
> (`scrape_case.mjs`'s `orderCommentsForPresentation`). See ADR 0002's addendum. §1/§2 (field
> schema, `parentId` derivation) are unaffected and still current.

## Problem Statement

`case.json` currently carries two synthesized duplicate fields (`customer` — a copy of
`accountName`; `created` — a copy of `openedAt`; plus a third, `raisedBy`, derived from both) that
exist only because `extract_case.js`'s `sectionValue()` helper couldn't originally trust a single
label match. Every Detail-tab field that isn't found on the portal is persisted as `""`, which is
indistinguishable from "the portal showed this field but it was blank" — consumers can't tell
"missing" from "empty" apart.

Separately, `case.json`'s `comments` array is flat with no reply relationship: a Chatter Reply
(nested under a Post via `ul.cuf-replies`/`li.cuf-reply`) is stored as an ordinary Comment
indistinguishable from a top-level Post once `isReply` is stripped in `scrape_case.mjs`'s
`finalize()`. `case.md`'s chronological list renders every comment identically, so a reader can't
tell a Reply apart from the Post it responds to.

This spec fixes both: a clean field table with one empty-value convention, and a `parentId` link
that lets `case.md` render Replies visually subordinate to their parent while keeping strict
Oldest → Newest numbering.

## Background

Produced by wayfinder map [#105](https://github.com/congtubkbn/qualcomm-case-agent/issues/105),
synthesizing:
- [#106](https://github.com/congtubkbn/qualcomm-case-agent/issues/106) — `parentId` DOM-derivation
  algorithm, nesting-depth finding, id-timing constraint.
- [#107](https://github.com/congtubkbn/qualcomm-case-agent/issues/107) — full downstream/producer
  consumer sweep for the field-drop and null-convention changes.
- [#108](https://github.com/congtubkbn/qualcomm-case-agent/issues/108) — full Detail-tab field
  inventory across all 4 locally cached cases.
- [#109](https://github.com/congtubkbn/qualcomm-case-agent/issues/109) — chosen `case.md`
  threaded-rendering layout (Variant A).

`data/cases/` will be wiped and re-captured once this lands — **no migration path needed**; the
existing `migrate_case.mjs`/`migrate_case_detail.mjs` scripts are unrelated to this change and stay
untouched.

## Solution

### 1. `case.json` field table

Every field below comes from `sectionValue()` in `extract_case.js`, whose empty-value default
changes from `""` to `null` **uniformly, no per-field exception** (including `title`/`status`/
`priority`/`caseRecordType`, which are also Feed-tab-visible and in practice almost never actually
empty — verified no consumer assumes a raw, un-guarded string: `cases_overview.mjs`'s every read of
`status`/`priority`/`title` already goes through `|| 'Unknown'`/`|| ''`, which treats `null`
identically to `""`).

| Field | Detail-tab label(s) searched | Type | Notes |
|---|---|---|---|
| `caseNumber` | — (from URL/search context) | `string` | Unaffected — never `sectionValue()`-derived. |
| `title` | `Subject`, `Case Subject` | `string \| null` | |
| `status` | `Status`, `Case Status` | `string \| null` | |
| `priority` | `Priority`, `Case Priority` | `string \| null` | |
| `severity` | `Severity`, `Case Severity` | `string \| null` | Empty in 4/4 cached cases — tracked separately in [#111](https://github.com/congtubkbn/qualcomm-case-agent/issues/111), not re-investigated here. |
| `product` | `Chipset`, `Product`, `Product Name` | `string \| null` | Empty in 4/4 cached cases — see #111. |
| `accountName` | `Account Name`, `Account`, `Customer`, `Customer Name` | `string \| null` | |
| `contactName` | `Contact Name`, `Contact`, `Case Contact`, `Contact:` | `string \| null` | |
| `customerProject` | `Customer Project`, `Customer Project Name`, `Project`, `Project Name` | `string \| null` | |
| `customerTracking` | `Customer Tracking`, `Customer Tracking Number`, `Customer Tracking#` | `string \| null` | **New.** Absent from all 4 cached cases — label list is a best guess, unverified against a live case that actually has it. Flag as TBD-verify on first real hit; do not treat the guessed labels as settled DOM fact. |
| `relatedCRs` | `Related CRs`, `Related CR`, `Related Change Requests`, `Change Requests`, `CRs` | `string \| null` | |
| `caseRecordType` | `Case Record Type Name`, `Case Record Type`, `Record Type`, `Record Type Name` | `string \| null` | Only "Wireless Device" seen in local cache — other record types unverified. |
| `openedAt` | `Date/Time Opened`, `Date Opened`, `Created Date`, `Created At`, `Opened Date`, `Opened` | `string \| null` | |
| `closedAt` | `Date/Time Closed`, `Date Closed`, `Closed Date`, `Closed At`, `Closed` | `string \| null` | |
| `updated` | `Last Modified Date`, `Modified Date`, `Last Modified` | `string \| null` | Empty in 4/4 cached cases — see #111. |
| `description` | `Description`, `Description Information`, `Case Description`, `Problem Description`, `Subject Description` | `string \| null` | |
| `url` | — (`location.href`) | `string` | Unaffected. |
| `displayedCommentCount` | — (feed status text) | `number \| null` | Unaffected by this change. |
| `comments` | — | `Comment[]` | See §2. |

**Dropped fields:** `customer` (dup of `accountName`), `created` (dup of `openedAt`), `raisedBy`
(`contactName \|\| customer \|\| ""` — synthesized from a field that's itself being dropped, and
every consumer that read it can read `contactName` directly).

Untouched, out of scope: `capture`, `hash`, `extractedAt` (pipeline/integrity metadata).

### 2. `Comment.parentId` — flat threading

A `Comment` gains one new field:

```
parentId: string | null   // id of the Comment this one replies to; null for a top-level Post
```

No `depth` field is persisted — it's always `0` or `1` (single-level nesting only; Chatter's
`FeedItem`/`FeedComment` model has no reply-to-reply), so `case.md` derives it from `parentId`
truthiness at render time instead of storing a redundant value. No raw `data-feed-item-id`/
`data-comment-id` capture either — the existing content-hash `id` (`scrape_case.mjs`'s
`assignIds()`) is the real stable identity Comments already carry; `parentId` only needs to *point
at* that id, not replace how it's computed.

**Derivation (per #106), in two steps because the content-hash id isn't known until after
`assignIds()` runs:**

1. **`extract_case.js`** (DOM-walk time, inside the existing `qsa("article").map(...)` loop):
   track `lastTopLevelIndex` as the loop walks; emit a run-scoped `parentIndex` (array index, not
   an id) — `null` for a Post, `lastTopLevelIndex` for a Reply. Must be computed against the
   **pre-filter** array (before `.filter(c => c.body.length > 0)` drops any empty comment) or
   resolved to post-filter positions before leaving the file — a `parentIndex` captured before the
   filter runs is stale afterward.
2. **`scrape_case.mjs`**, immediately after `assignIds()` (existing call, ~L746) and **before**
   `mergeComments`/`sortCommentsChronological` (~L755/L780) — the array is still in DOM order at
   that point, which is what makes "index adjacency = thread adjacency" hold: resolve each
   `parentIndex` into the *new* content-hash `id` of the comment at that index, drop `parentIndex`
   and `isReply` from the persisted record (add `parentIndex` to the existing `role, company,
   displayPosition, isReply` strip list at `finalize()`'s `out.comments.map(...)`, ~L862 — keep
   `parentId` itself OUT of that strip list, since it's the field being added).

Resolving `parentId` any later (after chronological sort) is unsound — index-adjacency in the
sorted array no longer implies DOM/thread adjacency once timestamp interpolation or an incremental
`--merge` interleaves multiple threads.

### 3. `case.md` rendering — Variant A (chosen in #109)

In the Chronological Timeline section, a Reply (`parentId != null`) gets:
- Heading prefixed with `↳` (vs. a plain `###` heading for a Post).
- Body rendered as a Markdown blockquote.
- Numbering **stays strict chronological** (`1..N`) regardless of nesting — no renumbering by
  thread.

Reference implementation: branch `prototype/109-reply-layouts`,
`.claude/skills/qualcomm-case-agent/scripts/render_case.prototype-109.mjs` (throwaway, not merged —
fold Variant A into `render_case.mjs`'s real loop once `parentId` lands in `case.json`).

### 4. Downstream consumer checklist (from #107's sweep)

Nothing in the codebase crashes on either half of this change — the codebase is defensively coded
(`typeof x === 'string'`, `x || ''`, truthy guards) almost everywhere, and those patterns already
treat `null` like `""`. Two producer-side spots are worse than silent — they become **permanent
false-positive warnings** if left unfixed:

| File | Line(s) | Change needed |
|---|---|---|
| `extract_case.js` | ~121-124 (`sectionValue`), ~387-388, 395, 398 | `sectionValue()`'s base case returns `null` not `""`; delete the `customer`/`created`/`raisedBy` derivation lines and their 3 keys in the returned object; add `customerTracking` derivation. |
| `extract_case.js` | ~331-364 (comment-walk loop) | Emit `parentIndex` per §2 step 1. |
| `scrape_case.mjs` | `HEADER_KEYS` L120 | Remove `'customer'`. |
| `scrape_case.mjs` | `DETAIL_KEYS` L123-132 | Remove `'raisedBy'`; add `'customerTracking'`. |
| `scrape_case.mjs` | ~735, 737 (`descRaw`) | Drop `customer`/`created` reads; `synthesizeDescriptionComment`'s fallback (~L339, L343) loses its `raw.customer`/`raw.created` branches, falls through to its next existing fallback. |
| `scrape_case.mjs` | ~767, 785 (merge-fill loops) | Remove `'created'` from the field-copy lists (`customer` was never in these two lists). |
| `scrape_case.mjs` | ~793-798 (cross-fill block) | Delete entirely — no more `customer`⇄`accountName`/`created`⇄`openedAt`/`raisedBy` cross-fill. |
| `scrape_case.mjs` | `thinHeader`, ~L849 | Remove `'customer'` from `['status', 'priority', 'customer']` — leaving it in permanently false-positives once `out.customer` is `undefined`. |
| `scrape_case.mjs` | `finalize()`'s comment strip, ~L862 | Add `parentId` to the **kept** set (i.e. do NOT add it to the destructured-out strip list) per §2 step 2. |
| `verify_case.mjs` | `OPTIONAL_FIELDS_WARN_IF_EMPTY`, L24 | Remove `'created'`, `'customer'` — same permanent-false-positive risk, this time in the QA gate. |
| `render_case.mjs` | L109-120 | Delete the `Customer`/`Created` rows; simplify Account Name to `['Account Name', data?.accountName]` (drop the now-always-true `!== data?.customer` suppression check); add a `Customer Tracking` row; implement Variant A per §3. |
| `find_case_link.js` | L56 | Remove the `customer` field capture from the header/search-row pass. |
| `fast_landing.mjs` | L141, L271 | Same removal, plus drop the `customer` key from the cached-fields object literal at L271. |
| `run_case.mjs` | `mergeDetailFields(...)` call, ~L424-442 | Remove `'customer'`, `'created'`, `'raisedBy'` from the merged-fields list; add `'customerTracking'`. |
| `docs/DESIGN.md` §5.1 | ~L200 (hand-written, **not** caught by `npm run docs:check`) | Manually update the `case.json` schema block. |
| `.claude/skills/qualcomm-case-agent/references/consumer-guide.md` | L23-52 | Remove `"customer"` from the schema example; document the `null`-for-empty convention and `parentId`. |
| `.claude/skills/qualcomm-case-agent/references/extraction.md` | L303 | Update the raw-extractor-output example shape. |
| `.claude/skills/qualcomm-case-agent/references/workflow.md` | L102-103, L119 | Prose pass — lower priority. |

### 5. Test suite checklist (from #107)

- `tests/render_case.test.mjs` — drop `customer`/`created` from fixtures; delete the now-failing
  Customer/Created row assertions; add a test pinning "Account Name always renders now."
- `tests/cases_overview_e2e.test.mjs` — update raw-capture fixtures to set `accountName`/`openedAt`
  directly instead of relying on the removed `customer`→`accountName`/`created`→`openedAt`
  cross-fill.
- `tests/scrape_case.test.mjs` — rewrite `synthesizeDescriptionComment`'s "prioritizes
  contactName/openedAt over customer/created" test, and the "Detail metadata persistence" describe
  block's cross-fill assertions (`saved.customer === saved.accountName`, etc.) — these directly test
  logic being deleted, not just consumers of it.
- `tests/extract_case.test.mjs` — update raw-output assertions (L362, L643) that currently expect
  `.customer` in the extractor's output.
- `tests/description_first_comment.test.mjs` — drop `customer:` from fixtures.
- `tests/run_case.test.mjs` — drop `customer: '...'` from the L511 fixture (unrelated to the
  `STATUS_EXIT.created` verdict-status constant, which is untouched).
- `tests/migrate_case.test.mjs`, `tests/migrate_case_detail.test.mjs` — **no change**; these test
  legacy-cache migration, out of scope per the wipe-and-recapture decision.
- New: a `parentId` derivation test in `tests/extract_case.test.mjs` / `tests/scrape_case.test.mjs`
  against case 08633581's real 1-post-3-reply shape (per #106's empirical verification), and a
  `case.md` Variant-A rendering test in `tests/render_case.test.mjs`.

## Out of Scope

- Investigating why `severity`/`product`/`updated` are empty in every cached case, and the
  Detail-tab-switch failure on case 08633581 — tracked in
  [#111](https://github.com/congtubkbn/qualcomm-case-agent/issues/111).
- Migrating already-cached `case.json` files to the new schema — `data/cases/` is wiped and
  re-captured instead.
- Adopting `data-feed-item-id`/`data-comment-id` as the raw id source (a #106 side finding) — the
  existing content-hash `id` mechanism is unchanged.
- Verifying the `customerTracking` label list against a live case — ships as a best guess, flagged
  TBD.

## Implementation Tickets

Split for a follow-up implementation effort — see `docs/issues/`:

1. [`01-case-level-field-schema.md`](../issues/01-case-level-field-schema.md) — null convention,
   drop `customer`/`created`/`raisedBy`, add `customerTracking`.
2. [`02-comment-threading.md`](../issues/02-comment-threading.md) — `parentId` derivation +
   resolution.
3. [`03-threaded-case-md-rendering.md`](../issues/03-threaded-case-md-rendering.md) — Variant A
   fold-in, blocked by 02.
4. [`04-downstream-docs-and-tests.md`](../issues/04-downstream-docs-and-tests.md) — doc updates +
   full test rewrite, blocked by 01-03.
