# Qualcomm Support Portal Extraction Reference

**Normal runs never need this file** — `run_case.mjs` drives extraction automatically in code. This document serves as the pipeline and extractor reference for recovery flows (e.g., when a verdict returns `blocked` during diagnosis).

For DOM selector mappings and Salesforce Lightning markup patterns, see [`dom-selectors.md`](dom-selectors.md).

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
node ".claude/skills/qcomm/scripts/finalize_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json"
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
- Normalizes any relative or non-ISO absolute timestamp into an ISO-8601 string (preserving original text in `rawTimestamp`).
- Generates 1–2 sentence preview summaries (`summary`).
- Strips transient extraction fields (`isReply`, `parentIndex`, `displayPosition`).
- Reorders comments for presentation (newest activity first with replies grouped under parent posts).

## Update Runs (`--merge`) — Incremental Capture of Cached Cases

When updating an existing cached case (`--mode update` or auto-detected update mode), the DOM contains newly added posts fully expanded while older posts remain collapsed. Run the extractor over the DOM and finalize with `--merge`:

```bash
node ".claude/skills/qcomm/scripts/finalize_case.mjs" <CODE> "data/cases/<CODE>/case.raw.json" --merge --status "<STATUS>" --priority "<PRIORITY>"
```

### Deterministic Merge Mechanics

- **Deduplication Key:** `author` + whitespace-normalized first 120 characters of `body`. Relative timestamps are excluded from deduplication because Chatter's relative timestamps ("13h ago") drift across runs while text prefixes remain stable.
- **Verbatim Preservation:** Existing comments are merged by stable content ID (`commentId`). Cached comment bodies and timestamps are preserved verbatim — a truncated re-capture never overwrites a full cached body. Legacy `enrichment` fields are dropped on read.
- **Header Metadata Precedence:** `--status`, `--priority`, and `--severity` flags override cached values (the current search row or Detail tab reflects real-time status).
- **Completeness Assertion:** The completeness check executes against the merged comment set before computing the content hash.
- **Verdict Emission:** Outputs `newComments`, `newCommentIds`, `headerChanged`, and `changed`. If `newComments: 0` and no headers changed, the verdict reports `no-update`.
- `--merge` invoked without an existing `data/cases/<CODE>/case.json` exits with code 2 to mandate a full capture.

**Header Metadata on Detail Tab:** Header fields (Title/Subject, Status, Priority, Severity, Customer Project, Account Name) reside on the case **Detail tab** and global search results row rather than the Chatter Feed view. `extract_case.js` initializes these fields to `""`; `run_case.mjs` switches to the Detail tab to extract them or accepts `--title`/`--status`/`--priority`/`--severity` flags.

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
