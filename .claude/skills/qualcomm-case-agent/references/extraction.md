# Qualcomm Support portal extraction — extractor script + selectors — reference

**Normal runs never need this file** — `run_case.mjs` drives extraction in code. This is the
selector/extractor reference for **manual-flow.md**: when a verdict comes back `blocked`
and you're diagnosing the capture, or when the live DOM has changed and `scripts/extract_case.js`
needs editing. The pipeline evaluates the bundled `scripts/extract_case.js` (or an edited copy) via
CDP `Runtime.evaluate` (`CdpClient.eval()`) against the **already-expanded live DOM**. The script's
final expression is the case OBJECT. There is no selector config file — the extractor inspects
the live DOM, runs directly in browser context, and hands the raw JSON to `finalize_case.mjs` to finalize.

> **Pre-condition — expansion is already done.** The expansion loop fully expands the page:
> it clicks **"View More Posts"** to a fixpoint, every **"Expand Post"** link (top-level + nested
> Chatter replies), and the **"Description"** button. Do not re-open / re-navigate the case URL — that
> would discard the expanded DOM. Extract from the page in its fully expanded state.

> **Do not blind-run the template.** The portal's DOM is only visible after login and changes over
> time. The robust loop is: read the real container/field structure from the live DOM → adapt the
> extractor if needed → evaluate in browser context → validate and finalize.

## Step 1 — Extract the case via extractor script

A ready-made extractor is bundled at **`scripts/extract_case.js`** — a clean default keyed on the
confirmed Salesforce Lightning structure (lock-in table below). The case folder already exists
(`intake.mjs` created `data/cases/<CODE>/` up front).

Three key rules baked into that script — keep them if you hand-edit the extractor for a DOM that
differs:

1. **Wrap in an IIFE; do NOT use a bare top-level `return`.** Browser script evaluation runs in EXPRESSION
   context (like a REPL) — `return extractCase();` at the top level throws `SyntaxError: Illegal return
   statement`. Put the logic in a function and let the IIFE call be the final expression.
2. **Return the OBJECT, not `JSON.stringify(object)`.** The evaluation runtime serializes the object.
3. **Ensure UTF-8 clean output** when saving raw results to disk for finalization.

Sanity-check the raw file, then finalize:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('data/cases/<CODE>/case.raw.json','utf8')); console.log(j.caseNumber, j.comments.length, j.displayedCommentCount)"
node ".claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json"
# on exit 0 the script deletes its own case.raw.json scratch file — no manual del/rm needed
```

`finalize_case.mjs` rejects a 0-comment capture (wrong page / failed pull — never overwrites a good cache),
asserts `genuineCommentCount(comments, description) >= displayedCommentCount` (short → exit 5, expand more and re-extract),
stamps the SHA-256 `hash` + `extractedAt`, writes `data/cases/<CODE>/case.json`, and updates the root
`_index.json`. It never drives the browser. However, `finalize_case.mjs` **does transform and normalize**
fields before persisting: it rewrites comment IDs to stable content-derived hashes (`assignIds`),
resolves/injects `parentId` from DOM-order `parentIndex`, normalizes relative timestamps into absolute
ISO-8601 strings (preserving `rawTimestamp`), extracts preview summaries (`summary`), strips transient
within-run extraction fields (`isReply`, `parentIndex`, `displayPosition`), and reorders comments
for presentation (newest-first with replies grouped under their parent) before computing the content hash
and writing canonical `case.json`.

## Update runs (`--merge`) — partial capture of a cached case

When the case is already cached and the user confirmed an update (SKILL.md Intake cache check +
PHASE 1.5B), the DOM holds the NEW posts fully expanded while old posts stay collapsed/truncated.
Run the SAME extractor over that DOM, then finalize with `--merge`:

```bash
node ".claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json" --merge --status "<STATUS>" --priority "<PRIORITY>"
```

What the merge does (all in code, deterministic):

- **Dedup key = author + whitespace-normalized first 120 chars of body.** Timestamps are excluded
  on purpose — Chatter's relative times ("13h ago") drift between runs, and old posts arrive
  truncated; the prefix survives both. (Known limit: editing the first 120 chars of an old comment
  makes it look new.)
- Comments are merged by stable content ID (`commentId`): cached comments and timestamps are kept
  **verbatim** — a truncated re-capture never overwrites a full cached body. A legacy `enrichment`
  field (if present in an older cache) is dropped on read rather than preserved. Merged comments
  are presented newest-first, with replies grouped immediately under their parent post (see
  threading pipeline below).
- `url` + `displayedCommentCount` are refreshed; `--status`/`--priority`/`--severity` flags override the cache
  (fresh PHASE 1 row is the current truth); other raw fields only fill blanks. `--title` not needed.
- Completeness assert runs on the MERGED set; the hash is recomputed over it.
- Emits `newComments` / `newCommentIds` / `headerChanged` / `changed` — `newComments: 0` with
  nothing else changed = "no update".
- `--merge` without an existing `data/cases/<CODE>/case.json` → exit 2 (run a full extraction).

**Header metadata (title/status/priority/severity) is NOT on the Feed view** — it lives on the case
**Detail tab** and the **PHASE 1 search-results row** (which exposes Subject, Status, Priority, Customer
Project; note that `customer` was dropped as a synthesized duplicate per issue #108, and `accountName` is
the canonical Detail tab field). `extract_case.js` leaves those fields `""`; fill them by editing the raw
JSON from what PHASE 1 already captured, passing `--title`/`--status`/`--priority`/`--severity` flags to
`finalize_case.mjs`, or clicking the "Detail" tab and re-reading before finalizing.

## Selector lock-in & live DOM shapes (confirmed from cases 08550063 [2026-06-22] & 08642051 [2026-08-23])

Confirmed from live DOM inspections and accessibility trees of the Qualcomm Support portal (Salesforce Lightning),
verified after login with a real Chrome session. These are the structures the `eval` extractor maps to.

| Field / Feature | Confirmed structure / pattern | Observation Date | Notes |
|-----------------|------------------------------|------------------|-------|
| Case URL pattern | `https://support.qualcomm.com/s/case/<SFID>/<slug>` | 2026-06-22 | real URL captured via `agent-browser eval "location.href"` after clicking search result |
| Case number | `document.title` → `"Case: <CODE>"` | 2026-06-22 | **most reliable.** Match `/Case:\s*(\d[\w-]*)/` — require colon+digit so Cases list view title cannot false-match |
| Subject (title) | Detail tab + PHASE 1 search row | 2026-06-22 | search results row exposes Subject; fill from there or Detail tab |
| Status | Detail tab / search-results table `cell` | 2026-08-23 | Detail tab holds inline edit button `button.test-id__inline-edit-trigger` (`"Edit Status"`) inside `.slds-form-element__control` |
| Priority | Detail tab / search-results table `cell` | 2026-06-22 | e.g. `"1 - Critical"` |
| Chipset / Product / Customer Project / Account | Detail tab fields (`lightning-record-layout-item`) | 2026-08-23 | click "Detail" tab to read; field values wrapped in `lightning-formatted-text` / `lightning-formatted-lookup` |
| Related CRs | Detail tab (`lightning-record-layout-item`) | 2026-08-23 | Label container carries `lightning-helptext` (`"Help Related CRs"`). If value is empty, assist text must not leak as value |
| Affordance: Lookup Preview | Lookup fields & author links `a > span.slds-assistive-text` (`"Preview"`) | 2026-06-22 | Trailing `"Preview"` stripped from name/link text |
| Affordance: Inline-edit trigger | Form element control `button.test-id__inline-edit-trigger` (`"Edit <Field>"`) | 2026-08-23 | Trailing `\nEdit <Field>` stripped from field values |
| Affordance: Help tooltip prefix | Field label container `lightning-helptext` (`"Help <Field>"`) | 2026-08-23 | Leaked `"Help <Field>"` stripped / yields empty when field is empty |
| Description | Detail tab / synthesized first comment | 2026-08-23 | Original problem description from Detail tab; synthesized into chronological first comment |
| Top-level Feed post | `article.cuf-feedItem:not(.cuf-comment)` | 2026-08-23 | Top-level post container. Direct child of feed list, NOT inside `ul.cuf-replies` |
| Nested Chatter reply | `ul.cuf-replies article.cuf-comment` | 2026-08-23 | Distinctly marked with `.cuf-comment` and nested inside `.cuf-replies` |
| → author | first `<a>` inside article in DOM order | 2026-08-23 | e.g. "Duc Hoang", "Sushmita Suresh Rao" (happens to be actorName link; not selected by that class) |
| → timestamp (top-level) | `span.cuf-timestamp[title]` / `a.cuf-timestamp` | 2026-08-23 | Top-level posts provide absolute date string (e.g. `"August 10, 2026 at 7:59 PM"`) in `title` attribute or link text (see `extractTimestamp()` in `extract_case.js` for full multi-tier fallback chain) |
| → timestamp (nested reply) | `span.cuf-timestamp > a.cuf-timestamp` (no title attribute) | 2026-08-23 | Replies render relative text only (e.g. `"12 days ago"`), omitting absolute timestamp in `title`/`datetime`; normalized at capture time to absolute ISO strings |
| → body (clean) | **`.feedBodyInner`** (alias `.cuf-feedBodyText`) | 2026-08-23 | Just post text (excludes header/footer). `domLines()` reconstructs structural line breaks (<p>/<div>/<br>) bypassing `innerText` layout dependency; `cleanBody()` strips Chatter separator mojibake |
| Feed item count | `status "N Chatter Feed Items"` (role=status) | 2026-08-23 | Counts **top-level** feed items only (excluding nested replies). Match `/(\d+)\s+Chatter\s+Feed\s+Items?/i` |
| Attachments | `.cuf-feedItemAttachments .slds-file` | 2026-08-23 | Cards containing download link `a[href*='/sfc/servlet.shepherd/version/download/']` and title `span.slds-file__text-title` |

---

### Detailed Live DOM Recordings (Observed 2026-08-23)

#### 1. Field-Value Inline-Edit Affordance Markup
*Observed on Detail tab in Case 08642051 (Status field).*

```html
<div class="slds-form-element slds-hint-parent">
  <span class="test-id__field-label slds-form-element__label">Status</span>
  <div class="slds-form-element__control slds-grid itemBody">
    <span class="test-id__field-value slds-form-element__static slds-grow word-break-ie11 is-read-only">
      <span class="uiOutputText">Closed-Customer Requested</span>
    </span>
    <button class="slds-button slds-button_icon test-id__inline-edit-trigger inline-edit-trigger slds-button_icon-small slds-shrink-none" title="Edit Status" type="button">
      <lightning-primitive-icon variant="bare">
        <svg class="slds-button__icon slds-button__icon_hint" aria-hidden="true" focusable="false" viewBox="0 0 520 520">
          <use xlink:href="/_slds/icons/utility-sprite/svg/symbols.svg#edit"></use>
        </svg>
      </lightning-primitive-icon>
      <span class="slds-assistive-text">Edit Status</span>
    </button>
  </div>
</div>
```

- **Defect Cause:** Reading `innerText` of `.slds-form-element` or `.slds-form-element__control` concatenates the value text with the button assistive text `<span class="slds-assistive-text">Edit Status</span>`, producing `"Closed-Customer Requested\nEdit Status"`.
- **Target Seam:** Strip `button.test-id__inline-edit-trigger`, `.inline-edit-trigger`, `.slds-button_icon`, or remove trailing `\s*Edit\s+<Field>` / `.slds-assistive-text` nodes before extracting value.

---

#### 2. Field-Label Help/Tooltip Affordance Markup
*Observed on Detail tab in Case 08642051 (Related CRs field).*

```html
<div class="slds-form-element slds-hint-parent">
  <div class="slds-form-element__label-container slds-grow">
    <label class="slds-form-element__label" for="input-related-crs">
      <span>Related CRs</span>
    </label>
    <lightning-helptext class="slds-m-left_xx-small">
      <button class="slds-button slds-button_icon slds-button_icon-small" aria-describedby="help-related-crs" type="button">
        <lightning-primitive-icon variant="bare">
          <svg class="slds-button__icon slds-button__icon_hint" aria-hidden="true">
            <use xlink:href="/_slds/icons/utility-sprite/svg/symbols.svg#info"></use>
          </svg>
        </lightning-primitive-icon>
        <span class="slds-assistive-text">Help Related CRs</span>
      </button>
      <div class="slds-popover slds-popover_tooltip slds-nubbin_bottom-left slds-fall-into-ground" id="help-related-crs" role="tooltip">
        <div class="slds-popover__body">Change request tracking numbers associated with this case</div>
      </div>
    </lightning-helptext>
  </div>
  <div class="slds-form-element__control slds-grid itemBody">
    <span class="test-id__field-value slds-form-element__static slds-grow is-read-only">
      <!-- Empty when no CR is linked -->
    </span>
  </div>
</div>
```

- **Defect Cause:** When the field value element is empty, `sectionValue` traverses the container looking for any non-label text element. It encounters the `<button>` or `<span class="slds-assistive-text">Help Related CRs</span>` inside `lightning-helptext`, extracting `"Help Related CRs"` as the value.
- **Target Seam:** Exclude `lightning-helptext`, `button.slds-button_icon`, and `[class*='helptext']` from candidate value elements, or ignore text matching `/^Help\s+/i`.

---

#### 3. Nested-Reply Timestamps vs Top-Level Post Timestamps
*Observed on Feed view in Case 08642051.*

**Top-level post timestamp markup:**
```html
<article class="cuf-feedItem cuf-feedItemBody cuf-feedItemWrap slds-card" data-feed-item-id="0D5dK00000...">
  <div class="feeditemuserandtimestamp slds-media__body">
    <a class="cuf-actorName" href="/s/profile/005...">Duc Hoang</a>
    <span class="cuf-timestamp uiOutputDateTime" title="August 10, 2026 at 7:59 PM">
      <a class="cuf-timestamp" href="/s/feeditem/0D5...">August 10, 2026 at 7:59 PM</a>
    </span>
  </div>
  <div class="feedBodyInner">Dear QC RRC team...</div>
</article>
```

**Nested Chatter reply timestamp markup:**
```html
<ul class="cuf-replies slds-p-horizontal_small">
  <li class="cuf-reply">
    <article class="cuf-comment cuf-feedItem" data-comment-id="0D7dK00000...">
      <div class="cuf-commentHeader slds-media__body">
        <a class="cuf-actorName" href="/s/profile/005...">Duc Hoang</a>
        <span class="cuf-timestamp uiOutputDateTime">
          <a class="cuf-timestamp" href="javascript:void(0);">12 days ago</a>
        </span>
      </div>
      <div class="feedBodyInner"># FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip...</div>
    </article>
  </li>
</ul>
```

- **Fallback Hypothesis Confirmation:**
  - **Verdict: CONFIRMED.**
  - Top-level posts provide an absolute date string (e.g. `"August 10, 2026 at 7:59 PM"`) on `span.cuf-timestamp[title]` and in `a.cuf-timestamp` text.
  - Nested replies in `.cuf-replies` render only the relative text link (`"12 days ago"`) and lack any `title` or `datetime` attribute containing an absolute timestamp.
  - Consequently, nested replies always trigger the relative-text extraction path and require capture-time normalization to absolute ISO timestamps (as implemented in issue #87).

---

#### 4. Comment Attachments Markup
*Observed on Chatter Feed comments carrying `.zip` log bundles in Case 08642051.*

```html
<div class="cuf-feedItemAttachments slds-post__content slds-m-top_x-small">
  <div class="cuf-attachment slds-file slds-file_card slds-has-title">
    <figure>
      <a href="/s/sfc/servlet.shepherd/version/download/068dK0000012345?asPdf=false&amp;operationContext=CHATTER" class="slds-file__crop cuf-attachmentThumbnail" title="FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip" download="FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip">
        <span class="slds-assistive-text">FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip</span>
      </a>
    </figure>
    <div class="slds-file__title slds-file__title_card">
      <div class="slds-media slds-media_small slds-media_center">
        <div class="slds-media__body">
          <a href="/s/contentdocument/069dK0000012345" class="slds-file__text" title="FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip">
            <span class="slds-file__text-title slds-truncate" title="FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip">FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip</span>
          </a>
        </div>
      </div>
    </div>
  </div>
</div>
```

- **Display Name Location:**
  - `span.slds-file__text-title[title]` or inner text: `"FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip"`
  - `a.slds-file__text[title]`
  - `a.cuf-attachmentThumbnail[download]` or `[title]`
- **Resolvable Portal URL Location:**
  - Direct Download URL: `a.slds-file__crop[href]` / `a[href*='/sfc/servlet.shepherd/version/download/']`
  - Document Preview URL: `a.slds-file__text[href]` / `a[href*='/contentdocument/']`

---

#### 5. Distinguishability of Nested Replies vs Top-Level Posts
*Observed on Chatter Feed hierarchy in Case 08642051.*

- **Top-Level Posts:**
  - Render as `<article class="cuf-feedItem ...">` directly under the main feed feed-item container.
  - Do NOT have the `.cuf-comment` class.
  - Are NOT enclosed within `ul.cuf-replies` or `li.cuf-reply`.
- **Nested Replies:**
  - Render as `<article class="cuf-comment cuf-feedItem" data-comment-id="...">`.
  - ALWAYS have the class `.cuf-comment`.
  - ALWAYS reside inside `ul.cuf-replies > li.cuf-reply` under their parent feed post.
- **Count-Unit Resolution:**
  - **Question:** The portal badge (`status "N Chatter Feed Items"`) counts top-level posts only (e.g. 3), whereas `document.querySelectorAll("article")` captures both top-level posts and nested replies (e.g. 4 total articles). Can the extractor distinguish them?
  - **Answer: YES.** Top-level posts and nested replies are unequivocally distinguishable via `article.classList.contains('cuf-comment')` or `article.closest('ul.cuf-replies')`.
  - **Impact on Gate Design:** The completeness gate can compare top-level posts directly against `displayedCommentCount`, and count nested replies separately, rather than treating any excess as an unassertable mismatch.

---

## The extractor script

The canonical extractor is **`scripts/extract_case.js`** (run via `eval -b`, see Step 2). It already
encodes the three rules above (IIFE / return-object / shell-redirect) and the lock-in selectors, and it
extracts from the already-expanded DOM with no expansion logic inside. Open it to see the exact logic;
edit it in place when the live DOM differs rather than writing a throwaway extractor — fixes there help
every future run. Key shape it returns:

```js
{ caseNumber, title, status, priority, severity, product, accountName, contactName, customerProject,
  customerTracking, relatedCRs, caseRecordType, openedAt, closedAt, updated,
  description, url, displayedCommentCount,
  comments: [ { id, timestamp, author, body, isReply, parentIndex, displayPosition, attachments } ] }
```

### Post-extraction: identity and comment-threading pipeline (#105-#109)

The raw extractor output undergoes multi-stage processing inside `finalize_case.mjs` before writing canonical `case.json`:

1. **Content-derived comment IDs (`assignIds`)**:
   - Extractor-provided IDs (`c1`, `c2`, ...) are positional and drift across re-captures as threads grow.
   - `finalize_case.mjs` assigns stable content IDs: `commentId(c) = 'c' + sha256(norm(author) + '|' + norm(body).slice(0, 120)).slice(0, 12)`.
   - Content IDs are position-independent and survive relative timestamp drift. Genuine duplicates (same author with matching 120-char prefix) receive a collision suffix (`-2`, `-3`) and are reported in the verdict.
   - Legacy caches with positional IDs are migrated on read (`migrateIds`), dropping any stale `enrichment` field.

2. **`parentId` resolution ordering constraint**:
   - `extract_case.js` tags each comment with `isReply` (via `.cuf-comment` or within `ul.cuf-replies`) and `parentIndex` (pointing to `lastTopLevelIndex` in the initial DOM traversal order).
   - In `finalize_case.mjs`, resolving `parentIndex` into `parentId` has a strict ordering constraint:
     - **Must run AFTER `assignIds`**: `fresh.comments[c.parentIndex].id` must resolve to the parent's newly assigned content ID.
     - **Must run BEFORE `sortCommentsChronological` / `mergeComments`**: reordering comments by timestamp destroys original DOM array indices. Resolving `parentIndex` against a reordered array would point to the wrong post or cause an out-of-bounds error.
   - Once resolved, `c.parentId` holds the parent post's content ID (or `null` for top-level posts and orphaned replies).

3. **Single-level-nesting invariant**:
   - Salesforce Chatter enforces single-level nesting: feed items are either top-level posts (`article.cuf-feedItem:not(.cuf-comment)`) or direct replies (`ul.cuf-replies article.cuf-comment`).
   - The hierarchy is strictly **Post → Reply only** (no Reply-to-Reply).
   - In `case.json`, every reply's `parentId` points directly to a top-level post (never to another reply).

4. **Chronological sorting & presentation ordering**:
   - `sortCommentsChronological` sorts comments ascending (Oldest → Newest). Missing timestamps are interpolated between known sibling bounds, and ties are broken using `displayPosition` (`getBoundingClientRect().top`).
   - `orderCommentsForPresentation` establishes the final persisted order in `case.json`: **newest activity first, with each reply grouped immediately after its parent post** (superseding PRD #105-#109's strict Oldest → Newest "Variant A"). Both top-level posts and same-thread replies are ordered newest-first.

5. **Persisted comment schema vs raw extractor shape**:
   - Transient extraction fields (`isReply`, `parentIndex`, `displayPosition`, and legacy `role`/`company`) are scrubbed before persistence.
   - Previews (`summary`) are generated via `extractSummary(body)` (1-2 sentences, salutations and expand markers stripped).
   - The canonical persisted comment shape in `case.json`:
     ```js
     {
       id: string,              // Stable content-derived id (e.g. "ca1b2c3d4e5f6")
       timestamp: string,       // ISO-8601 absolute timestamp string
       rawTimestamp?: string,   // Preserved original relative text if normalized (e.g. "12 days ago")
       author: string,          // Author display name
       body: string,            // Cleaned comment body text
       attachments: Array<{ name: string, url: string }>,
       parentId: string | null, // Parent post content id, or null if top-level
       summary: string          // Concise 1-2 sentence preview summary
     }
     ```

## Completeness cross-check (the strongest "got everything" signal)

The portal shows a total (e.g. `status "N Chatter Feed Items"`). Capture it as **`displayedCommentCount`**
in the raw JSON. `finalize_case.mjs` asserts:

```
genuineCommentCount(comments, description) >= displayedCommentCount   // else exit 5 — expand more / fix the extractor, re-extract
```

- **Genuine comments**: `genuineCommentCount()` excludes the synthesized description comment so it does not mask a missing Chatter post.
- **Nested replies excess**: The Salesforce Chatter badge counts top-level posts only, while our extractor captures both top-level posts and nested replies. Therefore, `capturedCount > displayedCount` is an expected, passing outcome (passes with an informational warning). Only `capturedCount < displayedCount` triggers an under-capture exit 5 error.

Store `displayedCommentCount` even when it matches — the renderer shows a ⚠ banner in
`case.report.md` / `case.html` if a future run captures fewer than displayed.

## Validation (before trusting the JSON)

- `comments.length` == the comment count seen in the confirming snapshot.
- No comment whose `body` is empty but was visibly non-empty on screen.
- Timestamps parse to dates → sort comments **newest-first** with a stable sort.

## Virtualized lists — when one eval can't hold everything

If after full expansion the evaluation still returns `comments.length < displayedCommentCount`, the
Feed is **virtualized** (off-screen rows unmount) — the full set is never in the DOM at once. Switch to
**progressive extraction**: scroll a step (`window.scrollBy(0, 600)`), re-evaluate
the extractor, and merge comments into a `Map` keyed by a STABLE id (permalink / `id`, else
`timestamp|author|first40(body)`). Repeat until `map.size === displayedCommentCount` or scrollHeight
stops growing. Then assemble the merged comments into the raw JSON and finalize as usual.

## Large cases / token budget

If the verbatim JSON is very large, have the evaluation write it directly to disk or extract
in chunks, then assemble. Never truncate comment bodies or logs to save tokens.

## Attachments (optional)

Attachment URLs captured in `comments[].attachments` point directly to portal download endpoints (`/s/sfc/servlet.shepherd/version/download/...`). These can be downloaded via authenticated session when required.
