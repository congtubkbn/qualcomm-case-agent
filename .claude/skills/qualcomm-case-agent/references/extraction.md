# Qualcomm Support portal extraction — selectors + extractor template — reference

For **PHASE 3** of the Qualcomm Case Management Agent. agent-browser verb for running page JS is
**`agent-browser eval "<js>"`** (v0.27.x). The JS must `return JSON.stringify(...)`.

> **Do not blind-run the template.** The portal's DOM is only visible after login and changes over
> time. The robust loop is: `snapshot` → read the REAL container/field selectors → write the
> extractor tailored to them → `eval` → validate against the snapshot → fix + re-run on mismatch.

## Step 1 — Expand EVERYTHING to a fixpoint (critical for full capture)

A case can hide data behind many stacked controls: **"Show more" / "Read more"** on long bodies,
**"Load more comments" / "More"** pagination, **"Expand post"**, **"Show N replies"**, collapsed
**"View detail"** log/attachment sections, and lazy-load on scroll. Clicking one ("load more") often
reveals NEW posts that each have their own "see more" — so you must loop until nothing new appears.

Do this in-page (one `eval` per pass) instead of slow snapshot→click round-trips. The portal is a
Salesforce-style SPA, so a naive `document.querySelectorAll` MISSES content in four ways — handle all:

1. **Shadow DOM** — Lightning web components hide buttons inside `shadowRoot`; you must pierce them.
2. **iframes** — the case body may live in a same-origin `<iframe>`; query its `contentDocument` too.
3. **Lazy-load** — comments render only as you scroll; scroll to the bottom each pass.
4. **Virtualized lists** — some lists unmount off-screen rows, so the full set is NEVER in the DOM at
   once (see the virtualization fallback below).

Generate `expandPass()` from the live DOM; this is the robust shape:

```javascript
// Collect the document + every shadowRoot + every same-origin iframe document.
function deepRoots(root) {
  const roots = [root];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) roots.push(...deepRoots(el.shadowRoot));
    if (el.tagName === 'IFRAME') { try { if (el.contentDocument) roots.push(...deepRoots(el.contentDocument)); } catch (e) {} }
  }
  return roots;
}
const deepAll = sel => deepRoots(document).flatMap(r => [...r.querySelectorAll(sel)]);

function expandPass() {
  window.scrollTo(0, document.body.scrollHeight);          // trigger lazy-load at the bottom
  const RX = /^\s*(show|view|load|see|expand|read|more|older|view full|show all|\d+\s+(more|repl|comment))/i;
  const STAMP = 'data-x-expanded';
  let clicked = 0;
  const sel = 'button,a,[role="button"],[aria-expanded="false"],summary,'
            + '[class*="more"],[class*="expand"],[class*="truncat"],[class*="collapse"],[class*="showMore"]';
  for (const el of deepAll(sel)) {
    if (el.getAttribute && el.getAttribute(STAMP)) continue;                       // already handled
    const label = (el.innerText || el.textContent || (el.getAttribute && el.getAttribute('aria-label')) || '').trim();
    const isToggle = (el.getAttribute && el.getAttribute('aria-expanded') === 'false') || el.tagName === 'SUMMARY';
    if (!isToggle && !RX.test(label)) continue;
    const r = el.getBoundingClientRect && el.getBoundingClientRect();
    if (r && r.width === 0 && r.height === 0) continue;                            // not rendered
    try { el.setAttribute && el.setAttribute(STAMP, '1'); el.click(); clicked++; } catch (e) {}
  }
  for (const d of deepAll('details:not([open])')) { d.open = true; clicked++; }    // native <details>
  const count = deepAll('[class*="comment"],[role="listitem"],article').length;    // REAL selector here
  return { clicked, count, h: Math.round(document.body.scrollHeight) };
}
return JSON.stringify(expandPass());
```

Shell driver — loop to a TRUE fixpoint (guard: max ~25 passes):

```bash
agent-browser eval "<expandPass JS>"     # -> {clicked, count, h}
agent-browser wait 1500                  # let async loads settle, then repeat
# STOP only when, across TWO consecutive passes:
#   clicked == 0  AND  count unchanged  AND  h (scrollHeight) unchanged
agent-browser snapshot -c                # final CONFIRM: no expander text, no "…"
```

**Confirmation gate:** proceed to Step 2 only when two consecutive passes show `clicked==0` with stable
`count` AND `h`, and the snapshot shows no remaining expander controls and no truncated "…" bodies.

### Virtualized lists — when expand-all can't hold everything
If after the fixpoint `count < displayedCommentCount`, the list is **virtualized** (off-screen rows are
unmounted) — you will NEVER have all comments in the DOM at once. Switch to **progressive extraction**:
scroll from top to bottom in small steps; after EACH step, extract the currently-rendered comments and
merge into a `Map` keyed by a STABLE id (comment permalink / `id`, else `timestamp|author|first40(body)`).
Keep scrolling until `map.size === displayedCommentCount` or the scroll height stops growing. The Map
dedupes rows that re-render. This replaces "expand-all then extract once" with "scroll → extract → merge".

## Step 2 — Completeness cross-check (the strongest "got everything" signal)

The portal usually shows a total somewhere (e.g. a "12 comments" header / tab badge). Capture it as
**`displayedCommentCount`** and assert it equals the number of extracted comments:

```
extracted.comments.length === displayedCommentCount   // must hold; else expand more / fix selectors
```

Store `displayedCommentCount` in the JSON even when it matches — the renderer shows a ⚠ banner in
`<CODE>.report.md` / `.html` if a future run captures fewer than displayed.

## Selector lock-in (fill in on the first successful run)

Once you have a confirming snapshot of a real case page, record the actual selectors here so future
runs skip re-discovery. **TODO — not yet captured (DOM only visible after login).**

| Field | Confirmed selector | Notes |
|-------|--------------------|-------|
| Case URL pattern | `https://support.qualcomm.com/.../case/<CODE>` | capture real path on first run |
| Case title | _TODO_ | |
| Status / Priority / Severity | _TODO_ | |
| Product / Chipset | _TODO_ | |
| Customer / Account | _TODO_ | |
| Created / Updated | _TODO_ | |
| Description | _TODO_ | |
| Comment container (repeats) | _TODO_ | one per comment/post |
| → timestamp | _TODO_ | parse to Date for sorting |
| → company / org | _TODO_ | |
| → author / role | _TODO_ | |
| → body (full, expanded) | _TODO_ | verbatim |
| → analysis logs | _TODO_ | `pre`/`code`/attachment blocks |
| → attachments (download links) | _TODO_ | `a[href*=download]` etc. |
| Expander controls | _TODO_ | "load more", "show N replies", "see more" |

## Starting template (adapt every selector to the live DOM)

```javascript
function extractCase() {
  const txt = el => (el?.innerText || '').trim();
  const field = label => {
    const el = [...document.querySelectorAll('*')]
      .find(n => n.children.length === 0 && n.innerText?.trim() === label);
    return txt(el?.parentElement)?.replace(label, '').trim() || '';
  };
  const comments = [...document.querySelectorAll(
      '.comment, .activity-item, [class*="comment"], [class*="thread"], [role="listitem"]')]
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
  const displayed = (txt(document.querySelector('[class*="comment"] [class*="count"], [class*="commentCount"]'))
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

## Validation (before trusting the JSON)

- `comments.length` == the comment count seen in the confirming snapshot.
- No comment whose `body` is empty but was visibly non-empty on screen.
- Timestamps parse to dates → sort comments **newest-first** with a stable sort.
- If paginated, extract each page and merge (dedupe by timestamp+author+body).

## Large cases / token budget

If the verbatim JSON is very large, avoid round-tripping it all through the model: have the
extractor write the JSON to disk via a download/clipboard path, or extract in chunks, then assemble.
Never truncate comment bodies or logs to save tokens.

## Attachments (optional)

```bash
agent-browser download "<attachment-link-sel-or-@ref>" \
  "data/cases/<CODE>/attachments/<name>"
```
