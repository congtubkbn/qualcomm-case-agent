# Qualcomm Support portal extraction — selectors + extractor template — reference

For **PHASE 2** of the Qualcomm Case Management Agent. Extraction is **agent-driven**: the agent runs
ONE `agent-browser eval "<js>"` against the **already-expanded live DOM** and the JS `return`s a
`JSON.stringify(...)` of the whole case object. There is no Node-side browser driving and no selector
config file — the agent reads the live DOM, writes the extractor to match it, evals, validates against
the snapshot, then hands the raw JSON to `scrape_case.mjs` to finalize.

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

The portal is a Salesforce Lightning SPA. The accessibility tree (what `snapshot -c` shows) pierces
shadow DOM for you, so the structure you see there maps directly onto the live DOM your `eval` queries.
Write the extractor from the **selector lock-in table** below, adapting every selector to the live DOM.

```bash
agent-browser eval "<extractCase JS that returns JSON.stringify(...)>"
```

Capture the eval's stdout to a raw JSON file, then finalize:

```bash
# agent writes the eval result to data/cases/<CODE>.raw.json (verbatim, no edits)
node ".claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs" <CODE> "data/cases/<CODE>.raw.json"
```

`scrape_case.mjs` asserts `comments.length >= displayedCommentCount` (short → exit 5, fix expansion and
re-extract), stamps the SHA-256 `hash` + `extractedAt`, writes `data/cases/<CODE>.json`, and updates
`_index.json`. It never drives the browser and never mutates your raw fields.

## Selector lock-in (confirmed from case 08550063 — 2026-06-22)

Confirmed from live accessibility-tree snapshots of the Qualcomm Support portal (Salesforce Lightning),
DOM verified after login with a real Chrome session. These are the structures the `eval` extractor maps to.

| Field | Confirmed structure / pattern | Notes |
|-------|------------------------------|-------|
| Case URL pattern | `https://support.qualcomm.com/s/case/<SFID>/<slug>` | real URL captured via `agent-browser eval "location.href"` after clicking the search result |
| Case number | `heading "Case <CODE>"` → h1 text | e.g. "Case 08550063" |
| Subject (title) | `button "Subject" [expanded=true]` → sibling `paragraph` | section collapses; check `expanded` attr |
| Status | not in case page DOM header; from search-results table `cell` | fallback: Detail tab |
| Priority | same — search-results table `cell "1 - Critical"` | |
| Chipset | `paragraph` following `paragraph "Chipset"` in case header generic block | e.g. "SM8850" |
| Problem Area 1/2/3 | `paragraph` after `paragraph "Problem Area N"` in header block | up to 3 |
| Customer Project | `link` inside `paragraph` after `paragraph "Customer Project"` | link text = project code |
| Account Name | `link` inside `paragraph` after `paragraph "Account Name"` | |
| Description | `button "Description" [expanded=true]` → sibling `paragraph` | already expanded by PHASE 1.5 |
| Feed / comment container | `region "Feed"` → `list` → `listitem` → `article` | each top-level post is an `article` |
| → author | `link` (first) inside `article` header | e.g. `link "Mai Ngoc"` |
| → timestamp | `link "June 16, 2026 at 8:08 PM"` or `link "13h ago"` | second link in article header |
| → body (full) | `paragraph` / `StaticText` nodes inside article `generic` | already "Expand Post"-ed by PHASE 1.5 |
| Nested comments (Chatter replies) | `list` immediately after article → `listitem` → inner `article` | same structure; expanded by PHASE 1.5 |
| Feed item count | `status "N Chatter Feed Items"` inside Feed region | use as `displayedCommentCount` |
| Attachments | `image "successcase"` / `image "failurecase"` as `clickable [cursor:pointer]` inside article | inline screenshot images; no `a[href]` |

## Starting template (adapt every selector to the live DOM)

Extracts from the already-expanded DOM — **no expansion logic inside**. The eval returns the full object.

```javascript
function extractCase() {
  const txt = el => (el?.innerText || el?.textContent || '').trim();
  const field = label => {
    const el = [...document.querySelectorAll('*')]
      .find(n => n.children.length === 0 && n.innerText?.trim() === label);
    return txt(el?.parentElement)?.replace(label, '').trim() || '';
  };
  const comments = [...document.querySelectorAll(
      '.comment, .activity-item, [class*="comment"], [class*="thread"], [role="listitem"], article')]
    .map((c, i) => ({
      id:          c.id || c.querySelector('[id]')?.id || `c${i + 1}`,   // permalink/anchor if any
      timestamp:   txt(c.querySelector('time, [class*="date"], [class*="time"]')),
      company:     txt(c.querySelector('[class*="company"], [class*="org"], [class*="account"]')),
      author:      txt(c.querySelector('[class*="author"], [class*="user"], .name')),
      role:        txt(c.querySelector('[class*="role"], [class*="title"]')),
      body:        txt(c.querySelector('[class*="body"], [class*="text"], p')) || txt(c),
      analysisLog: [...c.querySelectorAll('pre, code, [class*="log"], [class*="attach"]')]
                     .map(x => txt(x)).filter(Boolean),
      attachments: [...c.querySelectorAll('a[href*="download"], a[href*="attach"]')]
                     .map(a => ({ name: txt(a), href: a.href }))
    }))
    .filter(c => c.body || c.analysisLog.length);
  // Displayed total for the completeness assert — replace with the REAL header/badge selector.
  const displayed = (txt(document.querySelector('[class*="commentCount"], [class*="feedItemCount"]'))
    .match(/\d+/) || [])[0];
  return JSON.stringify({
    caseNumber:  field('Case Number') || field('Case ID') || location.href.split('/').pop(),
    title:       txt(document.querySelector('h1, [class*="title"]')),
    status:      field('Status'),   priority: field('Priority'),
    severity:    field('Severity'), product:  field('Product') || field('Chipset'),
    customer:    field('Account')  || field('Company'),
    created:     field('Created')  || field('Opened'),
    updated:     field('Last Updated') || field('Modified'),
    description: txt(document.querySelector('[class*="description"], [class*="detail"]')),
    displayedCommentCount: displayed != null ? Number(displayed) : null,
    comments, url: location.href
  });
}
return extractCase();
```

## Completeness cross-check (the strongest "got everything" signal)

The portal shows a total (e.g. `status "N Chatter Feed Items"`). Capture it as **`displayedCommentCount`**
in the raw JSON. `scrape_case.mjs` asserts:

```
comments.length >= displayedCommentCount   // else exit 5 — expand more / fix the extractor, re-extract
```

Store `displayedCommentCount` even when it matches — the renderer shows a ⚠ banner in
`<CODE>.report.md` / `.html` if a future run captures fewer than displayed.

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
