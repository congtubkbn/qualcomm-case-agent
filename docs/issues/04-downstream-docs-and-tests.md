---
ID: #115
Status: AFK
Blocked by: [#112, #113, #114]
Type: Tracer Bullet
---

## Parent
Part of #105 — spec: `docs/prd/case-detail-and-threaded-comments.md`

## What to build
Update the hand-maintained docs and rewrite the test suite left stale by
[`01`](01-case-level-field-schema.md), [`02`](02-comment-threading.md), and
[`03`](03-threaded-case-md-rendering.md).

### Docs
1. `docs/DESIGN.md` §5.1 (hand-written, **not** caught by `npm run docs:check`, ~L200): update the
   `case.json` schema block — drop `customer`/`created`, add `customerTracking`/`parentId`, note the
   `null`-for-empty convention.
2. `.claude/skills/qualcomm-case-agent/references/consumer-guide.md` (L23-52): remove `"customer"`
   from the schema example; document the `null`-for-empty convention and `parentId`.
3. `.claude/skills/qualcomm-case-agent/references/extraction.md` (L303): update the raw-extractor
   -output example shape.
4. `.claude/skills/qualcomm-case-agent/references/workflow.md` (L102-103, L119): prose pass
   referencing `customer` as a field name.

### Tests
5. `tests/render_case.test.mjs`: drop `customer`/`created` from fixtures; delete the Customer/
   Created row assertions (L108-109); add a test pinning "Account Name always renders now"; add a
   Variant-A threaded-rendering test (per #03).
6. `tests/cases_overview_e2e.test.mjs`: update raw-capture fixtures (L94-95, L189-190) to set
   `accountName`/`openedAt` directly instead of relying on the removed cross-fill.
7. `tests/scrape_case.test.mjs`: rewrite `synthesizeDescriptionComment`'s "prioritizes contactName/
   openedAt over customer/created" test (~L312-325) and the "Detail metadata persistence" describe
   block's cross-fill assertions (~L710-832) — these test logic being deleted, not just consumers.
   Add a `parentId` derivation test against case 08633581's real shape, and a 2-phase `--merge`
   test (per #02's acceptance criteria).
8. `tests/extract_case.test.mjs`: update raw-output assertions (L362, L643) expecting `.customer`.
9. `tests/description_first_comment.test.mjs`: drop `customer:` from fixtures.
10. `tests/run_case.test.mjs`: drop `customer: '...'` from the L511 fixture (the unrelated
    `STATUS_EXIT.created` verdict constant at L186 stays untouched).
11. `tests/migrate_case.test.mjs`, `tests/migrate_case_detail.test.mjs`: **no change** — legacy-
    cache migration, out of scope per the wipe-and-recapture decision.

## Acceptance criteria
- [ ] `npm test` passes in full.
- [ ] `npm run docs:check` passes (generated §7 unaffected by this change, but confirm no drift).
- [ ] No `*.md` file under `docs/` or `.claude/skills/qualcomm-case-agent/references/` still shows
      `customer`/`created`/`raisedBy` in a `case.json` schema example.
- [ ] Grep for `\.customer\b`/`\.created\b`/`\.raisedBy\b` across `tests/` and `.claude/skills/`
      returns zero remaining field-access hits (verdict-enum and unrelated-word hits excluded, per
      #107's original sweep).

## Blocked by
[`01-case-level-field-schema.md`](01-case-level-field-schema.md),
[`02-comment-threading.md`](02-comment-threading.md),
[`03-threaded-case-md-rendering.md`](03-threaded-case-md-rendering.md) — docs and tests describe the
landed behavior, not the other way around.
