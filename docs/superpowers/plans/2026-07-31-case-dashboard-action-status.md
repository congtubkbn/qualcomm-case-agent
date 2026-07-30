# Dashboard Unread Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm the case dashboard (`npm run web`) displays case data pulled by the
`qualcomm-case-agent` skill (via `scheduler.mjs` → `run_case.mjs`), and add a client-side "NEW"
badge so a case with an update since it was last opened is visible without opening every case's
Details.

**Architecture:** No AI/enrichment involved. `web/server.mjs`'s `/api/overview` already returns
`syncedAt` per case — sourced purely from the skill's capture pipeline (`data/cases/<CODE>/case.json`
+ `_index.json`), nothing derived by a model. The dashboard client (`web/app.html`) compares each
case's `syncedAt` against a per-code "last seen" timestamp kept in `localStorage`, and badges/sorts
accordingly. No server or schema changes.

**Tech Stack:** Plain Node ESM (`.mjs`, no build step), vanilla JS in `web/app.html`'s inline
`<script>` (no framework).

## Global Constraints

- Windows host — run every command through the PowerShell tool, not Bash (project convention;
  `.clinerules/windows-environment.md`).
- No build/lint/typecheck step in this repo. Tests: `node --test tests/<file>.test.mjs`.
- **No AI/enrichment work in this plan.** Do not touch `enrich_local.mjs`, `SKILL.md` PHASE 3, or
  `render_case.mjs` — those are explicitly out of scope per user direction. This plan only wires
  up display of data the capture pipeline (the `qualcomm-case-agent` skill) already produces.
- `data/` is git-ignored NDA material — never hand-edit fixtures into the repo itself.
- Follow existing code style in `web/app.html` exactly (matches current `esc()`/`ago()` helper
  patterns already in the file).

---

### Task 1: Confirm skill-sourced data reaches the dashboard, add NEW/unread badge

**Files:**
- Modify: `web/app.html` (CSS block ~line 7-53, script block ~line 81-186)
- No server/schema files touched — `web/server.mjs`'s `/api/overview` already returns `syncedAt`,
  `title`, `status`, `priority`, `commentCount`, `run` per case; that's all this task needs.

**Interfaces:**
- Consumes: `c.syncedAt`, `c.code` off each case object already returned by `/api/overview`
  (`web/server.mjs`'s existing `projectCase()` — unchanged).
- Produces: nothing consumed elsewhere — this is a self-contained UI change.

- [ ] **Step 1: Verify the skill → dashboard data path works today**

Run (PowerShell): `npm test` — confirms the existing suite (including
`tests/pipeline.test.mjs`'s `describe('web dashboard', ...)` block, which already asserts
`/api/overview` serves a cached case's `title`/`commentCount`) passes before any change.
Expected: PASS.

If `data/cases/` has no case yet, pull one through the actual skill entry point to see the full
path end to end:

Run (PowerShell): `npm run case -- <an-8-digit-case-code-you-have-access-to>`

Expected: one JSON verdict line with `"status":"created"` (or `"updated"`/`"no-update"` on a
re-run), and `data/cases/<CODE>/case.json` now exists.

- [ ] **Step 2: Add CSS for the NEW badge**

In `web/app.html`, after the existing `.tag.warn { color: var(--warn); border-color: currentColor; }`
line (currently line 44), add:

```css
  .tag.new { color: var(--accent); border-color: currentColor; font-weight: 700; }
```

- [ ] **Step 3: Add unread-tracking helpers**

In the `<script>` block, after `let open = new Set();` (currently line 97), add:

```js
const seenKey = code => `qc-seen:${code}`;
const isNew = c => !!c.syncedAt && localStorage.getItem(seenKey(c.code)) !== c.syncedAt;
const markSeen = c => { if (c.syncedAt) localStorage.setItem(seenKey(c.code), c.syncedAt); };
```

- [ ] **Step 4: Add the NEW badge to `card(c)`**

In the `card(c)` function, add a `newBadge` line next to the existing `run` line (currently line
106) and render it in the header row:

```js
  const run = c.run ? `<span class="tag ${RUN_CLASS[c.run.status] ?? ''}">${esc(c.run.status)}${c.run.newComments ? ' +' + c.run.newComments : ''}</span>` : '';
  const newBadge = isNew(c) ? '<span class="tag new">NEW</span>' : '';
```

In the returned template's header row (currently lines 120-129), add `${newBadge}` right after the
title span:

```js
      <span class="title">${esc(c.title || (c.cached ? '(untitled)' : 'not captured yet'))}</span>
      ${newBadge}
      ${c.status ? `<span class="tag">${esc(c.status)}</span>` : ''}
```

- [ ] **Step 5: Sort unread cases first, mark seen on Details open**

In `render()` (currently lines 142-155), sort `d.cases` before rendering and keep the sorted list
around for the click handler to look codes up in:

```js
let lastCases = [];

async function render() {
  const d = await fetch('/api/overview').then(r => r.json());
  $('#sweep').textContent = d.sweep ? `last sweep ${ago(d.sweep.at)}` : 'no sweep yet';
  $('#auth').innerHTML = d.sweep?.authRequired
    ? '<div class="banner"><b>Sign-in needed.</b> The saved Okta session lapsed — sign in once in the persistent Chrome profile (email OTP is human-only), then hit Sync now.</div>'
    : '';
  if (document.activeElement !== $('#interval')) $('#interval').value = d.watchlist.intervalMinutes;
  if (document.activeElement !== $('#enrich')) $('#enrich').value = d.watchlist.enrich;

  lastCases = [...d.cases].sort((a, b) => {
    const r = (isNew(a) ? 0 : 1) - (isNew(b) ? 0 : 1);
    return r !== 0 ? r : String(b.syncedAt || '').localeCompare(String(a.syncedAt || ''));
  });

  $('#list').className = lastCases.length ? '' : 'empty';
  $('#list').innerHTML = lastCases.length
    ? lastCases.map(card).join('')
    : 'No cases yet — add a case code above to start watching it.';
}
```

Replace the `toggleOpen` branch in the click handler (currently
`if (act === 'toggleOpen') { open.has(code) ? open.delete(code) : open.add(code); return render(); }`,
line 162) with:

```js
  if (act === 'toggleOpen') {
    const opening = !open.has(code);
    open.has(code) ? open.delete(code) : open.add(code);
    if (opening) {
      const c = lastCases.find(x => x.code === code);
      if (c) markSeen(c);
    }
    return render();
  }
```

- [ ] **Step 6: Run the full suite (regression check on the backend this page talks to)**

Run (PowerShell): `npm test`
Expected: PASS — this task touches no `.mjs` file, so this confirms nothing else broke.

- [ ] **Step 7: Manual browser verification**

1. Run (PowerShell): `npm run web`, open `http://127.0.0.1:8787`.
2. Confirm every cached case under `data/cases/` appears in the list with its real title, status,
   comment count — i.e. data the skill captured is actually reaching the page.
3. Clear any prior state for a test case: in the browser devtools console run
   `localStorage.removeItem('qc-seen:<CODE>')` for one cached case code, then refresh. Confirm that
   case now shows a "NEW" badge and sorts to the top.
4. Click "Details" on that case. Refresh again — confirm the "NEW" badge is gone and the case has
   dropped out of the "unread first" group (back to sorted by `syncedAt`).
5. Click "Sync now" on a case, wait for the run to finish (`run` tag flips to `updated` or
   `no-update`) — if `updated`, confirm the case regains its "NEW" badge on the next refresh since
   `syncedAt` moved forward past the stored "seen" value.

- [ ] **Step 8: Commit**

```bash
git add web/app.html
git commit -m "feat(qualcomm-case-agent): add NEW/unread badge to the dashboard"
```
