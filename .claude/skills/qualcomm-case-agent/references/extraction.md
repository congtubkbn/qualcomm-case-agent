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

## Selector lock-in (confirmed from case 08550063 — 2026-06-22)

Confirmed from live accessibility-tree snapshots of the Qualcomm Support portal (Salesforce Lightning),
DOM verified after login with a real Chrome session. These are the structures the `eval` extractor maps to.

| Field | Confirmed structure / pattern | Notes |
|-------|------------------------------|-------|
| Case URL pattern | `https://support.qualcomm.com/s/case/<SFID>/<slug>` | real URL captured via `agent-browser eval "location.href"` after clicking the search result |
| Case number | `document.title` → `"Case: <CODE>"` | **most reliable.** Match `/Case:\s*(\d[\w-]*)/` — require the colon+digit so the Cases LIST view (title "Cases") can't false-match to junk like "s" |
| Subject (title) | NOT on the Feed view — Detail tab + PHASE 1 search row | search results row exposes Subject; fill from there |
| Status | NOT on case page — search-results table `cell` | from PHASE 1 row; or Detail tab |
| Priority | same — search-results table `cell "1 - Critical"` | from PHASE 1 row |
| Chipset / Problem Area / Customer Project / Account | Detail tab fields (not the Feed view) | click "Detail" tab to read, or leave blank |
| Description | Detail tab (the original problem is also the oldest Feed post) | often `""` on Feed; oldest comment carries the same text |
| Feed / comment container | `article` elements (top-level posts AND nested replies are both `<article>`) | `document.querySelectorAll("article")` catches all |
| → author | first `<a>` inside the article | e.g. "Mai Ngoc" |
| → timestamp | second named `<a>` (skip if it is "Expand Post") | e.g. "June 16, 2026 at 8:08 PM" / "13h ago" |
| → body (clean) | **`.feedBodyInner`** (alias `.cuf-feedBodyText`) | gives JUST the post text — excludes the author/timestamp header and the Like/Comment/views footer. Far cleaner than whole-article `innerText` |
| Feed item count | `status "N Chatter Feed Items"` (role=status) inside Feed region — **the count must PRECEDE the phrase** | use as `displayedCommentCount`. Chatter also renders a per-item `status "Chatter Feed Item <n>"` region; matching the first digit of the first matching region stored that item ordinal as a "total" (08503838 recorded 2 for 11 comments). Match `/(\d+)\s+Chatter\s+Feed\s+Items?/i` or store `null` — a wrong total is worse than none. Counts top-level items; nested replies are extra `article`s, so captured count can exceed it (assert is `>=`) |
| Attachments | inline `image "successcase"`/`"failurecase"` as `clickable` inside article | screenshot images; no `a[href]` |

## The extractor script

The canonical extractor is **`scripts/extract_case.js`** (run via `--stdin`, see Step 2). It already
encodes the three rules above (IIFE / return-object / shell-redirect) and the lock-in selectors, and it
extracts from the already-expanded DOM with no expansion logic inside. Open it to see the exact logic;
edit it in place when the live DOM differs rather than writing a throwaway extractor — fixes there help
every future run. Key shape it returns:

```js
{ caseNumber, title, status, priority, severity, product, customer, created, updated,
  description, url, displayedCommentCount,
  comments: [ { id, timestamp, company, author, role, body, analysisLog, attachments } ] }
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
