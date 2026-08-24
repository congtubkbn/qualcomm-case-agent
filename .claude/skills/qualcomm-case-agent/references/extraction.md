# Qualcomm Support portal extraction — extractor script + selectors — reference

**Normal runs never need this file** — `run_case.mjs` drives extraction in code. This is the
selector/extractor reference for **manual-flow.md PHASE 2**: when a verdict comes back `blocked`
and you're hand-driving the capture, or when the live DOM has changed and `scripts/extract_case.js`
needs editing. The agent runs the bundled `scripts/extract_case.js` (or an edited copy) via
`agent-browser eval -b` (base64) against the **already-expanded live DOM** — never `--stdin`, which
silently returns the literal string `"null"` on this Windows/PowerShell setup instead of erroring
(see manual-flow.md). The script's final expression is the case OBJECT (agent-browser serializes it
once). There is no Node-side browser driving and no selector config file — the agent reads the live
DOM, adapts the extractor if needed, evals, validates against the snapshot, then hands the raw JSON to
`scrape_case.mjs` to finalize.

> **Pre-condition — expansion is already done.** SKILL.md PHASE 1.5 fully expands the page via
> `agent-browser snapshot → ref → click` (the proven flow): it clicks **"View More Posts"** to a
> fixpoint, every **"Expand Post"** link (top-level + nested Chatter replies), and the **"Description"**
> button. Do NOT re-expand here, and do NOT re-open / re-navigate the case URL — that would discard the
> expanded DOM. Extract from the page exactly as PHASE 1.5 left it.

> **Do not blind-run the template.** The portal's DOM is only visible after login and changes over
> time. The robust loop is: `snapshot -c` → read the REAL container/field structure → write the
> extractor tailored to it → `eval` → validate against the snapshot → fix + re-run on mismatch.

## Step 1 — Confirm the page is fully expanded

PHASE 1.5 already did this. One cheap confirmation before extracting:

```bash
agent-browser snapshot -c | grep -E "Expand Post|View More"
# Expected: (empty). If anything remains, finish PHASE 1.5 first.
```

## Step 2 — Extract the whole case in ONE eval

A ready-made extractor is bundled at **`scripts/extract_case.js`** — a clean default keyed on the
confirmed Salesforce Lightning structure (lock-in table below). The case folder already exists
(`intake.mjs` created `data/cases/<CODE>/` up front — no `mkdir` line needed; a manual `mkdir -p`
kept breaking under PowerShell, where `-p` is read as a dir name). Run the extractor via `eval -b`
(base64) — **not `--stdin`, not `<` redirection**: piping through PowerShell (`Get-Content -Raw |
agent-browser eval --stdin`) silently returns the literal string `"null"` instead of the evaluated
result (verified — an agent-browser/Windows-PowerShell stdin bug, not a script bug); bash-style `<`
redirection is a reserved token in PowerShell (hard parse error). `-b` sidesteps both. Write the
result straight to disk with .NET so it's guaranteed clean UTF-8 with no BOM (PowerShell's `>`
redirect defaults to a BOM-prefixed encoding that corrupts the JSON `scrape_case.mjs` reads next):

```powershell
powershell -NoProfile -Command "$b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes('.claude/skills/qualcomm-case-agent/scripts/extract_case.js')); $r = agent-browser eval -b $b64; [IO.File]::WriteAllText('data/cases/<CODE>/case.raw.json', $r, (New-Object Text.UTF8Encoding $false))"
```

Three hard-won rules baked into that script — keep them if you hand-edit the extractor for a DOM that
differs:

1. **Wrap in an IIFE; do NOT use a bare top-level `return`.** `agent-browser eval` runs in EXPRESSION
   context (like a REPL) — `return extractCase();` at the top level throws `SyntaxError: Illegal return
   statement`. Put the logic in a function and let the IIFE call be the final expression.
2. **Return the OBJECT, not `JSON.stringify(object)`.** agent-browser serializes the result for you.
   Returning a pre-stringified string double-encodes it — you get `"{\"a\":1}"` on disk, which the
   finalizer rejects. (Verify: `eval "(function(){return {a:1}})()"` prints `{"a":1}`; the `JSON.stringify`
   form prints `"{\"a\":1}"`.)
3. **Write UTF-8 with no BOM** — a BOM-prefixed file breaks `JSON.parse` downstream; the `.NET
   WriteAllText` call above with `UTF8Encoding($false)` guarantees this.

Sanity-check the raw file, then finalize:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('data/cases/<CODE>/case.raw.json','utf8')); console.log(j.caseNumber, j.comments.length, j.displayedCommentCount)"
node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json"
# on exit 0 the script deletes its own case.raw.json scratch file — no manual del/rm needed
```

`scrape_case.mjs` rejects a 0-comment capture (wrong page / failed pull — never overwrites a good cache),
asserts `comments.length >= displayedCommentCount` (short → exit 5, expand more and re-extract), stamps
the SHA-256 `hash` + `extractedAt`, writes `data/cases/<CODE>/case.json`, and updates the root
`_index.json`. It never drives the browser and never mutates your raw fields.

## Update runs (`--merge`) — partial capture of a cached case

When the case is already cached and the user confirmed an update (SKILL.md Intake cache check +
PHASE 1.5B), the DOM holds the NEW posts fully expanded while old posts stay collapsed/truncated.
Run the SAME extractor over that DOM, then finalize with `--merge`:

```bash
node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json" --merge --status "<STATUS>" --priority "<PRIORITY>"
```

What the merge does (all in code, deterministic):

- **Dedup key = author + whitespace-normalized first 120 chars of body.** Timestamps are excluded
  on purpose — Chatter's relative times ("13h ago") drift between runs, and old posts arrive
  truncated; the prefix survives both. (Known limit: editing the first 120 chars of an old comment
  makes it look new.)
- Comments not in the cache are **prepended** (feed is newest-first) with collision-free ids;
  cached comments, `analysisLog`s and timestamps are kept **verbatim** — a truncated re-capture
  never overwrites a full cached body.
- `url` + `displayedCommentCount` are refreshed; `--status`/`--priority` flags override the cache
  (fresh PHASE 1 row is the current truth); other raw fields only fill blanks. `--title` not needed.
- Completeness assert runs on the MERGED set; the hash is recomputed over it.
- Emits `newComments` / `newCommentIds` / `headerChanged` / `changed` — `newComments: 0` with
  nothing else changed = "no update".
- `--merge` without an existing `data/cases/<CODE>/case.json` → exit 2 (run a full extraction).

**Header metadata (title/status/priority/customer) is NOT on the Feed view** — it lives on the case
**Detail tab** and the **PHASE 1 search-results row** (which exposes Subject, Status, Priority, Customer
Project). `extract_case.js` leaves those fields `""`; fill them by editing the raw JSON from what PHASE 1
already captured, or click the "Detail" tab and re-read before finalizing.

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
| → author | first `<a>` inside article (with `.cuf-actorName`) | 2026-08-23 | e.g. "Duc Hoang", "Sushmita Suresh Rao" |
| → timestamp (top-level) | `span.cuf-timestamp[title]` / `a.cuf-timestamp` | 2026-08-23 | Top-level posts provide absolute date string (e.g. `"August 10, 2026 at 7:59 PM"`) in `title` attribute or link text |
| → timestamp (nested reply) | `span.cuf-timestamp > a.cuf-timestamp` (no title attribute) | 2026-08-23 | Replies render relative text only (e.g. `"12 days ago"`), omitting absolute timestamp in `title`/`datetime` |
| → body (clean) | **`.feedBodyInner`** (alias `.cuf-feedBodyText`) | 2026-08-23 | Just the post text — excludes author/timestamp header and action footer |
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

The canonical extractor is **`scripts/extract_case.js`** (run via `--stdin`, see Step 2). It already
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

## Completeness cross-check (the strongest "got everything" signal)

The portal shows a total (e.g. `status "N Chatter Feed Items"`). Capture it as **`displayedCommentCount`**
in the raw JSON. `scrape_case.mjs` asserts:

```
comments.length >= displayedCommentCount   // else exit 5 — expand more / fix the extractor, re-extract
```

Store `displayedCommentCount` even when it matches — the renderer shows a ⚠ banner in
`case.report.md` / `case.html` if a future run captures fewer than displayed.

## Validation (before trusting the JSON)

- `comments.length` == the comment count seen in the confirming snapshot.
- No comment whose `body` is empty but was visibly non-empty on screen.
- Timestamps parse to dates → sort comments **newest-first** with a stable sort.

## Virtualized lists — when one eval can't hold everything

If after full PHASE 1.5 expansion the eval still returns `comments.length < displayedCommentCount`, the
Feed is **virtualized** (off-screen rows unmount) — the full set is never in the DOM at once. Switch to
**progressive extraction**: `agent-browser eval` to scroll a step (`window.scrollBy(0, 600)`), re-eval
the extractor, and merge comments into a `Map` keyed by a STABLE id (permalink / `id`, else
`timestamp|author|first40(body)`). Repeat until `map.size === displayedCommentCount` or scrollHeight
stops growing. Then assemble the merged comments into the raw JSON and finalize as usual.

## Large cases / token budget

If the verbatim JSON is very large, have the eval write it to disk (download/clipboard path) or extract
in chunks, then assemble. Never truncate comment bodies or logs to save tokens.

## Attachments (optional)

```bash
agent-browser download "<attachment-link-sel-or-@ref>" \
  "data/cases/<CODE>/attachments/<name>"
```
