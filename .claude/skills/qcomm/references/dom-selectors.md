# Qualcomm Support Portal — DOM Selector Reference

Selector mappings and Salesforce Lightning DOM patterns for `QC.extractCase()` in the unified **`scripts/dom_extractor.js`** module. **Maintenance reference** — load when Salesforce DOM changes break extraction and selectors need updating.

For the extraction pipeline, finalization, and merge mechanics, see [`extraction.md`](extraction.md).

## Selector Mappings

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
| → timestamp (top-level) | `span.cuf-timestamp[title]` / `a.cuf-timestamp` | Top-level posts provide absolute date string (e.g. `"August 10, 2026 at 7:59 PM"`) in `title` attribute or link text (see fallback chain in `QC.extractTimestamp()`, `dom_extractor.js`) |
| → timestamp (nested reply) | `span.cuf-timestamp > a.cuf-timestamp` (no `title`) | Replies render relative text only (e.g. `"12 days ago"`); normalized at capture time to absolute ISO strings |
| → body (clean) | **`.feedBodyInner`** (alias `.cuf-feedBodyText`) | Post text excluding headers/footers. `domLines()` reconstructs structural line breaks (`<p>`, `<div>`, `<br>`) bypassing `innerText` layout dependencies; `cleanBody()` removes separator noise |
| Feed item count | `status "N Chatter Feed Items"` (`role="status"`) | Counts **top-level** feed items only (excluding nested replies). Match `/(\d+)\s+Chatter\s+Feed\s+Items?/i` |
| Attachments | `.cuf-feedItemAttachments .slds-file` | Attachment cards containing download link `a[href*='/sfc/servlet.shepherd/version/download/']` and title `span.slds-file__text-title` |

---

## Salesforce Lightning DOM Patterns & Affordances

### 1. Field-Value Inline-Edit Affordance Markup

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

### 2. Field-Label Help / Tooltip Affordance Markup

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

### 3. Top-Level Post Timestamps vs Nested-Reply Timestamps

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

### 4. Comment Attachments Markup

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

### 5. Distinguishability of Top-Level Posts vs Nested Replies

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
