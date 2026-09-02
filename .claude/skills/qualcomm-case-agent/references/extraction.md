# Qualcomm Support Portal Extraction Reference

**Normal runs never need this file** — `run_case.mjs` drives extraction automatically in code. This document serves as the selector and extractor reference for maintainers and recovery flows (e.g., when a verdict returns `blocked` during diagnosis, or when Salesforce Lightning DOM changes require updating `scripts/extract_case.js`).

The pipeline evaluates `scripts/extract_case.js` (or an updated copy) via Chrome DevTools Protocol (CDP) `Runtime.evaluate` (`CdpClient.eval()`) against the **already-expanded live DOM**. The script's final evaluated expression is the raw case object. The extractor inspects the live DOM directly in browser context and hands the resulting raw JSON to `finalize_case.mjs` for normalization, deduplication, and persistence.

> **Pre-condition — expansion is already done.** The expansion loop fully expands the page before extraction: it clicks **"View More Posts"** to a fixpoint, expands every **"Expand Post"** link (top-level and nested Chatter replies), and clicks the **"Description"** button. Do not re-navigate or reload the case URL — doing so discards the expanded DOM. Extract from the page in its fully expanded state.

> **Live DOM verification.** The portal's DOM is only accessible after authentication and may evolve over time. Maintainers should inspect the container/field structure from the live DOM, update `scripts/extract_case.js` as needed, evaluate in browser context, and validate via `finalize_case.mjs`.

## Step 1 — Extract the Case via Extractor Script

The canonical extractor script is located at **`scripts/extract_case.js`**, configured for Salesforce Lightning structures. The target case folder (`data/cases/<CODE>/`) is prepared at the start of capture.

Three essential rules govern browser script evaluation:

1. **Wrap in an IIFE; do NOT use a bare top-level `return`.** CDP script evaluation runs in expression context (similar to a REPL). A bare `return extractCase();` at the top level throws `SyntaxError: Illegal return statement`. Encapsulate logic inside a function and let the IIFE execution be the final evaluated expression.
2. **Return the Object, not `JSON.stringify(object)`.** The CDP evaluation runtime serializes the object automatically. Returning a stringified string causes redundant escaping.
3. **Ensure UTF-8 clean output** when persisting raw capture results to disk for finalization.

Sanity-check the raw extraction file, then finalize:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('data/cases/<CODE>/case.raw.json','utf8')); console.log(j.caseNumber, j.comments.length, j.displayedCommentCount)"
node ".claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json"
# On exit 0, finalize_case.mjs cleans up its own case.raw.json scratch file
```

`finalize_case.mjs` validates the extraction:
- Rejects a 0-comment capture (protects existing valid cache from overwrite).
- Asserts `genuineCommentCount(comments, description) >= displayedCommentCount` (insufficient count exits with code 5 to trigger further expansion/re-extraction).
- Computes SHA-256 `hash` and timestamps `extractedAt`.
- Persists canonical artifacts `data/cases/<CODE>/case.json` and `data/cases/<CODE>/case.md`, and updates root `_index.json`.

`finalize_case.mjs` normalizes fields before persisting:
- Assigns stable content-derived hashes for comment IDs (`assignIds`).
- Resolves and injects `parentId` from DOM-order `parentIndex`.
- Normalizes relative timestamps into absolute ISO-8601 strings (preserving original text in `rawTimestamp`).
- Generates 1–2 sentence preview summaries (`summary`).
- Strips transient extraction fields (`isReply`, `parentIndex`, `displayPosition`).
- Reorders comments for presentation (newest activity first with replies grouped under parent posts).

## Update Runs (`--merge`) — Incremental Capture of Cached Cases

When updating an existing cached case (`--mode update` or auto-detected update mode), the DOM contains newly added posts fully expanded while older posts remain collapsed. Run the extractor over the DOM and finalize with `--merge`:

```bash
node ".claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json" --merge --status "<STATUS>" --priority "<PRIORITY>"
```

### Deterministic Merge Mechanics

- **Deduplication Key:** `author` + whitespace-normalized first 120 characters of `body`. Relative timestamps are excluded from deduplication because Chatter's relative timestamps ("13h ago") drift across runs while text prefixes remain stable.
- **Verbatim Preservation:** Existing comments are merged by stable content ID (`commentId`). Cached comment bodies and timestamps are preserved verbatim — a truncated re-capture never overwrites a full cached body. Legacy `enrichment` fields are dropped on read.
- **Header Metadata Precedence:** `--status`, `--priority`, and `--severity` flags override cached values (the current search row or Detail tab reflects real-time status).
- **Completeness Assertion:** The completeness check executes against the merged comment set before computing the content hash.
- **Verdict Emission:** Outputs `newComments`, `newCommentIds`, `headerChanged`, and `changed`. If `newComments: 0` and no headers changed, the verdict reports `no-update`.
- `--merge` invoked without an existing `data/cases/<CODE>/case.json` exits with code 2 to mandate a full capture.

**Header Metadata on Detail Tab:** Header fields (Title/Subject, Status, Priority, Severity, Customer Project, Account Name) reside on the case **Detail tab** and global search results row rather than the Chatter Feed view. `extract_case.js` initializes these fields to `""`; `run_case.mjs` switches to the Detail tab to extract them or accepts `--title`/`--status`/`--priority`/`--severity` flags.

## Selector Mappings & Salesforce Lightning DOM Structures

DOM structures and selector mappings for Qualcomm Support portal (Salesforce Lightning):

| Field / Feature | Confirmed Structure / Selector Pattern | Notes |
|-----------------|----------------------------------------|-------|
| Case URL pattern | `https://support.qualcomm.com/s/case/<SFID>/<slug>` | Resolved via global search results or direct navigation |
| Case number | `document.title` → `"Case: <CODE>"` | Match `/Case:\s*(\d[\w-]*)/` with colon+digit to prevent false matches on list views |
| Subject (title) | Detail tab / Search results row | Captured from global search hit or Detail tab `lightning-formatted-text` |
| Status | Detail tab / Search results table cell | Detail tab contains inline edit button `button.test-id__inline-edit-trigger` (`"Edit Status"`) inside `.slds-form-element__control` |
| Priority | Detail tab / Search results table cell | E.g. `"1 - Critical"` |
| Chipset / Product / Customer Project / Account | Detail tab (`lightning-record-layout-item`) | Field values wrapped in `lightning-formatted-text` or `lightning-formatted-lookup` |
| Related CRs | Detail tab (`lightning-record-layout-item`) | Label container carries `lightning-helptext` (`"Help Related CRs"`). Assistive text must not leak as field value |
| Affordance: Lookup Preview | Lookup fields & author links `a > span.slds-assistive-text` (`"Preview"`) | Trailing `"Preview"` text stripped from name/link |
| Affordance: Inline-edit trigger | Form control `button.test-id__inline-edit-trigger` (`"Edit <Field>"`) | Trailing `\nEdit <Field>` stripped from field values |
| Affordance: Help tooltip prefix | Label container `lightning-helptext` (`"Help <Field>"`) | Leaked `"Help <Field>"` stripped; empty field yields empty string |
| Description | Detail tab / synthesized first comment | Initial case problem description from Detail tab; synthesized into chronological first comment |
| Top-level Feed post | `article.cuf-feedItem:not(.cuf-comment)` | Top-level post container. Direct child of feed list, NOT inside `ul.cuf-replies` |
| Nested Chatter reply | `ul.cuf-replies article.cuf-comment` | Marked with `.cuf-comment` and nested within `ul.cuf-replies` |
| → author | First `<a>` inside article in DOM order | Actor name link (e.g. "Duc Hoang", "Sushmita Suresh Rao") |
| → timestamp (top-level) | `span.cuf-timestamp[title]` / `a.cuf-timestamp` | Top-level posts provide absolute date string (e.g. `"August 10, 2026 at 7:59 PM"`) in `title` attribute or link text (see fallback chain in `extract_case.js`) |
| → timestamp (nested reply) | `span.cuf-timestamp > a.cuf-timestamp` (no `title`) | Replies render relative text only (e.g. `"12 days ago"`); normalized at capture time to absolute ISO strings |
| → body (clean) | **`.feedBodyInner`** (alias `.cuf-feedBodyText`) | Post text excluding headers/footers. `domLines()` reconstructs structural line breaks (`<p>`, `<div>`, `<br>`) bypassing `innerText` layout dependencies; `cleanBody()` removes separator noise |
| Feed item count | `status "N Chatter Feed Items"` (`role="status"`) | Counts **top-level** feed items only (excluding nested replies). Match `/(\d+)\s+Chatter\s+Feed\s+Items?/i` |
| Attachments | `.cuf-feedItemAttachments .slds-file` | Attachment cards containing download link `a[href*='/sfc/servlet.shepherd/version/download/']` and title `span.slds-file__text-title` |

---

### Salesforce Lightning DOM Patterns & Affordances

#### 1. Field-Value Inline-Edit Affordance Markup

Markup pattern on Detail tab (e.g. Status field):

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

- **Extraction Hazard:** Reading `innerText` of `.slds-form-element` or `.slds-form-element__control` concatenates the value text with button assistive text `<span class="slds-assistive-text">Edit Status</span>`, producing `"Closed-Customer Requested\nEdit Status"`.
- **Target Seam:** Strip `button.test-id__inline-edit-trigger`, `.inline-edit-trigger`, `.slds-button_icon`, or remove trailing `\s*Edit\s+<Field>` / `.slds-assistive-text` nodes before extracting value.

---

#### 2. Field-Label Help / Tooltip Affordance Markup

Markup pattern on Detail tab (e.g. Related CRs field):

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

- **Extraction Hazard:** When the field value element is empty, naive container traversal finds the nearest non-label text element: `<button>` or `<span class="slds-assistive-text">Help Related CRs</span>` inside `lightning-helptext`, falsely capturing `"Help Related CRs"` as the field value.
- **Target Seam:** Exclude `lightning-helptext`, `button.slds-button_icon`, and `[class*='helptext']` from candidate value elements, or ignore text matching `/^Help\s+/i`.

---

#### 3. Top-Level Post Timestamps vs Nested-Reply Timestamps

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

- **Structural Differences:**
  - Top-level posts provide an absolute date string (e.g. `"August 10, 2026 at 7:59 PM"`) on `span.cuf-timestamp[title]` and in `a.cuf-timestamp` text.
  - Nested replies in `.cuf-replies` render only relative text (e.g. `"12 days ago"`) and lack `title` or `datetime` attributes containing absolute timestamps.
  - Nested replies require capture-time timestamp normalization to absolute ISO-8601 strings based on capture execution time.

---

#### 4. Comment Attachments Markup

Chatter Feed attachment markup:

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

- **File Name Selectors:**
  - `span.slds-file__text-title[title]` or text content
  - `a.slds-file__text[title]`
  - `a.cuf-attachmentThumbnail[download]` or `[title]`
- **Portal URL Endpoints:**
  - Direct Download URL: `a.slds-file__crop[href]` / `a[href*='/sfc/servlet.shepherd/version/download/']`
  - Document Preview URL: `a.slds-file__text[href]` / `a[href*='/contentdocument/']`

---

#### 5. Distinguishability of Top-Level Posts vs Nested Replies

- **Top-Level Posts:**
  - Render as `<article class="cuf-feedItem ...">` directly under the feed container.
  - Do NOT contain `.cuf-comment`.
  - Are NOT nested within `ul.cuf-replies` or `li.cuf-reply`.
- **Nested Replies:**
  - Render as `<article class="cuf-comment cuf-feedItem" data-comment-id="...">`.
  - Always have class `.cuf-comment`.
  - Always reside inside `ul.cuf-replies > li.cuf-reply` under their parent feed post.
- **Count-Unit Differentiation:**
  - The portal badge (`status "N Chatter Feed Items"`) counts top-level posts only, whereas DOM queries like `document.querySelectorAll("article")` encounter both top-level posts and nested replies.
  - Extractor distinguishes them via `article.classList.contains('cuf-comment')` or `article.closest('ul.cuf-replies')`.
  - Completeness gate asserts top-level post count against `displayedCommentCount` without treating nested replies as count anomalies.

---

## The Extractor Script

The canonical extractor is **`scripts/extract_case.js`**, evaluated via CDP `Runtime.evaluate` (`CdpClient.eval()`). It encapsulates the three execution rules (IIFE / return-object / UTF-8) and selector mappings, operating directly against the already-expanded DOM.

### Raw Extractor Output Schema

```js
{
  caseNumber: string,
  title: string,
  status: string,
  priority: string,
  severity: string,
  product: string,
  accountName: string,
  contactName: string,
  customerProject: string,
  customerTracking: string,
  relatedCRs: string,
  caseRecordType: string,
  openedAt: string,
  closedAt: string,
  updated: string,
  description: string,
  url: string,
  displayedCommentCount: number,
  comments: Array<{
    id: string,
    timestamp: string,
    author: string,
    body: string,
    isReply: boolean,
    parentIndex: number | null,
    displayPosition: number,
    attachments: Array<{ name: string, url: string }>
  }>
}
```

### Post-Extraction: Identity & Comment Threading Pipeline

Raw extractor output undergoes multi-stage processing inside `finalize_case.mjs` before persisting canonical `case.json`:

1. **Content-Derived Comment IDs (`assignIds`)**:
   - Positional IDs (`c1`, `c2`, ...) drift across captures as comment threads grow.
   - `finalize_case.mjs` computes stable content IDs:
     `commentId(c) = 'c' + sha256(norm(author) + '|' + norm(body).slice(0, 120)).slice(0, 12)`.
   - Content IDs are position-independent and survive relative timestamp drift. Genuine duplicates (same author with identical 120-character prefix) receive a collision suffix (`-2`, `-3`) and are noted in the verdict.
   - Positional IDs in legacy caches are migrated on read (`migrateIds`), dropping stale `enrichment` fields.

2. **`parentId` Resolution Ordering Constraint**:
   - `extract_case.js` tags each comment with `isReply` (via `.cuf-comment` or `ul.cuf-replies`) and `parentIndex` (referencing `lastTopLevelIndex` in initial DOM traversal order).
   - Resolving `parentIndex` into `parentId` in `finalize_case.mjs` follows a strict sequence:
     - **Must run AFTER `assignIds`**: `fresh.comments[c.parentIndex].id` must resolve to the parent post's assigned content ID.
     - **Must run BEFORE `sortCommentsChronological` / `mergeComments`**: Reordering comments by timestamp changes array indices. Resolving `parentIndex` against a reordered array causes invalid parent references or out-of-bounds errors.
   - Resolved `c.parentId` stores the parent post's content ID (`null` for top-level posts and orphaned replies).

3. **Single-Level Nesting Invariant**:
   - Salesforce Chatter enforces single-level nesting: feed items are either top-level posts (`article.cuf-feedItem:not(.cuf-comment)`) or direct replies (`ul.cuf-replies article.cuf-comment`).
   - The hierarchy is strictly **Post → Reply only** (no reply-to-reply nesting).
   - In `case.json`, every reply's `parentId` references a top-level post (never another reply).

4. **Chronological Sorting & Presentation Ordering**:
   - `sortCommentsChronological` orders comments ascending (Oldest → Newest). Missing timestamps are interpolated between known sibling bounds, breaking ties with `displayPosition` (`getBoundingClientRect().top`).
   - `orderCommentsForPresentation` establishes final persisted ordering in `case.json`: **newest activity first, with each reply grouped immediately after its parent post**. Both top-level posts and thread replies are ordered newest-first.

5. **Canonical Persisted Comment Schema**:
   - Transient extraction fields (`isReply`, `parentIndex`, `displayPosition`, and legacy `role`/`company`) are removed prior to persistence.
   - Summaries (`summary`) are generated via `extractSummary(body)` (1–2 concise sentences with salutations and expand markers stripped).
   - The canonical persisted comment shape in `case.json`:
     ```js
     {
       id: string,              // Stable content-derived ID (e.g. "ca1b2c3d4e5f6")
       timestamp: string,       // ISO-8601 absolute timestamp string
       rawTimestamp?: string,   // Preserved original relative text if normalized (e.g. "12 days ago")
       author: string,          // Author display name
       body: string,            // Cleaned comment body text
       attachments: Array<{ name: string, url: string }>,
       parentId: string | null, // Parent post content ID, or null if top-level
       summary: string          // Concise 1-2 sentence preview summary
     }
     ```

## Completeness Cross-Check

The portal displays a total item count (e.g. `status "N Chatter Feed Items"`), captured as **`displayedCommentCount`** in raw extraction. `finalize_case.mjs` asserts:

```
genuineCommentCount(comments, description) >= displayedCommentCount
```

- **Genuine Comments:** `genuineCommentCount()` excludes the synthesized description comment so that initial problem description does not mask a missing Chatter post.
- **Nested Replies Excess:** The Salesforce Chatter badge counts top-level posts only, while extraction captures both top-level posts and nested replies. Therefore, `capturedCount > displayedCount` is an expected, passing state (logged with an informational note). Only `capturedCount < displayedCount` triggers an under-capture exit code 5.
- `displayedCommentCount` is persisted in `case.json` for integrity tracking; `render_case.mjs` generates a warning banner in `case.md` if captured count is fewer than displayed.

## Validation Invariants

Before accepting extracted data:
- `comments.length` matches the count observed on the expanded page.
- No comment contains an empty `body` when visibly populated on screen.
- All timestamps parse to valid dates, sorting newest-first with stable ordering.

## Virtualized Lists

If post-expansion extraction returns `comments.length < displayedCommentCount` due to DOM virtualization (off-screen rows unmounting):
- Perform **progressive extraction**: scroll incrementally (`window.scrollBy(0, 600)`), re-evaluate extraction, and merge comments into a map keyed by stable content ID or `author|first40(body)`.
- Repeat until all displayed items are captured or scroll height ceases growing.
- Hand assembled raw JSON to `finalize_case.mjs`.

## Large Cases & Token Budget

When case data is large, write raw JSON directly to disk or extract in stages. Do not truncate comment bodies or logs.

## Attachments

Attachment endpoints in `comments[].attachments` point directly to portal download endpoints (`/s/sfc/servlet.shepherd/version/download/...`). These can be retrieved within an authenticated session when required.

