# Dashboard Unread Status + CLI-Triggered Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm the case dashboard (`npm run web`) displays case data pulled by the
`qualcomm-case-agent` skill, add a client-side "NEW" badge for unread updates, and make the
dashboard's manual "Sync now" button trigger a case update the same way the user would by hand —
by invoking an agent CLI (claude/cline/gemini) with the skill's trigger phrase — instead of
calling the capture script directly.

**Architecture:** Two independent pieces:
1. **Unread badge (Task 1)** — no AI involved. `web/server.mjs`'s `/api/overview` already returns
   `syncedAt` per case, sourced purely from the capture pipeline's disk state. The dashboard client
   (`web/app.html`) compares each case's `syncedAt` against a per-code "last seen" timestamp kept
   in `localStorage`, and badges/sorts accordingly. No server or schema changes.
2. **CLI-triggered sync (Task 2)** — a new `web/cli_run.mjs`, invoked by `web/server.mjs`'s
   `POST /api/run/<CODE>` in place of `scheduler.mjs --case <CODE>`. It spawns a configured agent
   CLI (`data/agent-cli.json`, machine-local, git-ignored) with the prompt
   `qualcomm case <CODE> — capture only, skip PHASE 3 enrichment/analysis`, then — rather than
   trying to parse the agent's free-form reply — re-reads `data/cases/<CODE>/` before and after to
   derive `created`/`updated`/`no-update`/`error` from disk state, the same source of truth
   `/api/overview` already reads. Writes to `data/runs.json` in the exact shape
   `scheduler.mjs`'s `sweep()` already uses, so the dashboard's existing run-status badge needs no
   change. The **automatic background sweep stays on the direct `run_case.mjs` path** (unchanged)
   — spinning an agent CLI per case on a timer would burn real tokens/cost for no reason; only the
   manual per-case button goes through the CLI.

**Tech Stack:** Plain Node ESM (`.mjs`, no build step), vanilla JS in `web/app.html`'s inline
`<script>` (no framework), `node --test` for unit tests.

## Global Constraints

- Windows host — run every command through the PowerShell tool, not Bash (project convention;
  `.clinerules/windows-environment.md`).
- No build/lint/typecheck step in this repo. `npm test` runs exactly the three files listed in
  `package.json`'s `"test"` script — new test files must be added to that list, or (simpler, and
  what this plan does) folded into `tests/pipeline.test.mjs`, which is already on it.
- **No AI/enrichment work in this plan.** Do not touch `enrich_local.mjs`, `SKILL.md` PHASE 3, or
  `render_case.mjs` — out of scope per user direction. Task 2 spawns an agent CLI, but only to
  reproduce the capture step (PHASE 1/2) the user would trigger by hand; the prompt explicitly
  tells the agent to skip PHASE 3 so this doesn't silently reintroduce enrichment or hit PHASE 3's
  interactive "ask before a large analysis" gate (which has no one to answer it headless).
- `data/` is git-ignored NDA material — never hand-edit fixtures into the repo itself; both new
  test coverage and the auto-created `data/agent-cli.json` stay out of git via the existing
  blanket `data/` ignore.
- Task 2 never parses status out of an agent CLI's text reply — status is always derived from
  before/after disk state (`_index.json` / `case.json`), matching how `/api/overview` already
  works. This avoids depending on an agent's prose matching `run_case.mjs`'s own verdict shape.
- Windows CLI spawning reuses the pattern already established in
  `.claude/skills/qualcomm-case-agent/scripts/browser.mjs` (`spawnSync` via `cmd.exe /d /s /c`
  with a metacharacter guard) rather than inventing a new one — see that file's `ab()`/`winLine()`
  for the reference implementation.
- Follow existing code style in each touched file exactly (no linter to catch drift): `web/app.html`
  matches its current `esc()`/`ago()` helper patterns; `web/cli_run.mjs` matches
  `scheduler.mjs`'s `readJson`/`writeJson` reuse and JSON-line-on-stdout convention.

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

---

### Task 2: `web/cli_run.mjs` — manual "Sync now" via an agent CLI

**Files:**
- Create: `web/cli_run.mjs`
- Modify: `web/server.mjs:167-175` (the `POST /api/run/<CODE>` handler)
- Test: `tests/pipeline.test.mjs` (new `describe('cli_run.mjs', ...)` block, so it stays on
  `npm test`'s explicit file list without touching `package.json`)

**Interfaces:**
- Consumes: `RUNS_PATH`, `readJson`, `writeJson` (already exported by
  `.claude/skills/qualcomm-case-agent/scripts/scheduler.mjs`); `DATA_DIR`, `PROJECT_ROOT` (already
  exported by `.claude/skills/qualcomm-case-agent/scripts/_paths.mjs`).
- Produces: `loadCliConfig(): {tool, commands}`, `fillArgv(template: string[], prompt: string): string[]`,
  `classifyRun(before, after, cliFailed, reason): {status, reason?, newComments?}` — all exported,
  pure, and unit-tested in Task 2 (no real CLI process involved). `main()`/the top-level script
  writes one entry into `data/runs.json` keyed by case code, in the same shape
  `scheduler.mjs`'s `sweep()` writes (`{lastRunAt, status, reason?, newComments?}`) — Task 1's
  dashboard badge code and the existing `RUN_CLASS` mapping in `web/app.html` read this unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/pipeline.test.mjs`, after the existing `describe('web dashboard', ...)` block:

```js
describe('cli_run.mjs', async () => {
  const { loadCliConfig, fillArgv, classifyRun, CONFIG_PATH } = await import(new URL('../web/cli_run.mjs', import.meta.url));

  it('auto-creates data/agent-cli.json with a claude-only default on first read', () => {
    const cfg = loadCliConfig();
    assert.equal(cfg.tool, 'claude');
    assert.deepEqual(cfg.commands.claude, ['claude', '-p', '{prompt}', '--output-format', 'json']);
    assert.ok(existsSync(CONFIG_PATH));
  });

  it('respects a hand-edited tool/commands', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      tool: 'gemini', commands: { gemini: ['gemini', '-p', '{prompt}'] },
    }));
    const cfg = loadCliConfig();
    assert.equal(cfg.tool, 'gemini');
    assert.deepEqual(cfg.commands.gemini, ['gemini', '-p', '{prompt}']);
  });

  it('fillArgv substitutes the {prompt} token only, leaving other args untouched', () => {
    assert.deepEqual(
      fillArgv(['claude', '-p', '{prompt}', '--output-format', 'json'], 'qualcomm case 08603854'),
      ['claude', '-p', 'qualcomm case 08603854', '--output-format', 'json'],
    );
  });

  it('classifyRun: a case that did not exist before and does after is "created"', () => {
    const v = classifyRun({ syncedAt: null, exists: false, commentCount: 0 }, { syncedAt: 'x', exists: true, commentCount: 3 }, false, '');
    assert.equal(v.status, 'created');
    assert.equal(v.newComments, 3);
  });

  it('classifyRun: a changed syncedAt is "updated", with newComments as the count delta', () => {
    const v = classifyRun(
      { syncedAt: '2026-07-01T00:00:00.000Z', exists: true, commentCount: 2 },
      { syncedAt: '2026-07-02T00:00:00.000Z', exists: true, commentCount: 5 },
      false, '',
    );
    assert.equal(v.status, 'updated');
    assert.equal(v.newComments, 3);
  });

  it('classifyRun: an unchanged syncedAt is "no-update"', () => {
    const s = { syncedAt: '2026-07-01T00:00:00.000Z', exists: true, commentCount: 2 };
    assert.deepEqual(classifyRun(s, s, false, ''), { status: 'no-update' });
  });

  it('classifyRun: a failed CLI process is "error" regardless of disk state', () => {
    const s = { syncedAt: null, exists: false, commentCount: 0 };
    const v = classifyRun(s, s, true, 'claude: command not found');
    assert.equal(v.status, 'error');
    assert.equal(v.reason, 'claude: command not found');
  });
});
```

Add `existsSync` to the existing `import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';`
line at the top of `tests/pipeline.test.mjs` (it currently doesn't import `existsSync`):

```js
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 2: Run tests to verify they fail**

Run (PowerShell): `node --test tests/pipeline.test.mjs`
Expected: FAIL — `web/cli_run.mjs` does not exist yet, so the dynamic `import()` throws
`ERR_MODULE_NOT_FOUND` and every test in the new `describe` block fails.

- [ ] **Step 3: Implement `web/cli_run.mjs`**

Create `web/cli_run.mjs`:

```js
// web/cli_run.mjs — trigger the qualcomm-case-agent SKILL through an external
// agent CLI (claude/cline/gemini), for the dashboard's manual "Sync now"
// button.
//
// This is deliberately NOT scheduler.mjs's path: that one calls run_case.mjs
// directly for zero model tokens (the documented capture-is-code path, still
// used by the automatic background sweep — see web/server.mjs's --scheduler
// mode). This path exists because "Sync now" should reproduce exactly what
// the user gets typing "qualcomm case <CODE>" to their agent by hand —
// including going through a real agent process, at real per-run cost. Do not
// wire the automatic sweep to this path.
//
//     node cli_run.mjs <CODE>
//
// Config: data/agent-cli.json (git-ignored, machine-local — which CLIs are
// actually installed varies per desktop):
//   { "tool": "claude", "commands": { "claude": ["claude", "-p", "{prompt}", "--output-format", "json"] } }
// Auto-created with a claude-only default on first read, same pattern as
// scheduler.mjs's loadWatchlist(). Add a "cline"/"gemini" entry under
// "commands" and flip "tool" to switch — this script never guesses a CLI's
// invocation syntax; the array is your literal argv, no shell re-parsing.
//
// The agent is told to capture only and skip PHASE 3 (enrichment is out of
// scope here, and PHASE 3's "ask before a large analysis" gate has no one to
// answer it in headless mode). Status is never parsed from the agent's reply
// — instead this script re-reads data/cases/<CODE>/ before and after the CLI
// process exits and derives created/updated/no-update/error from what's
// actually on disk, the same source of truth /api/overview already reads.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, PROJECT_ROOT } from '../.claude/skills/qualcomm-case-agent/scripts/_paths.mjs';
import { RUNS_PATH, readJson, writeJson } from '../.claude/skills/qualcomm-case-agent/scripts/scheduler.mjs';

export const CONFIG_PATH = join(PROJECT_ROOT, 'data', 'agent-cli.json');
const DEFAULT_CONFIG = {
  tool: 'claude',
  commands: { claude: ['claude', '-p', '{prompt}', '--output-format', 'json'] },
};

export function loadCliConfig() {
  if (!existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) };
}

/** Substitute the {prompt} token into an argv template. Array-in, array-out —
 *  no string re-parsing, so no quoting ambiguity (same "argv array, nothing
 *  crosses a shell as text" rule browser.mjs follows for agent-browser). */
export function fillArgv(template, prompt) {
  return template.map(a => (a === '{prompt}' ? prompt : a));
}

function caseState(code) {
  const idx = readJson(join(DATA_DIR, '_index.json'), {});
  const casePath = join(DATA_DIR, code, 'case.json');
  const exists = existsSync(casePath);
  const commentCount = exists ? (readJson(casePath, {}).comments?.length ?? 0) : 0;
  return { syncedAt: idx[code]?.syncedAt || null, exists, commentCount };
}

/** Derive a verdict purely from disk state before/after the CLI ran — never
 *  from the agent's own reply text. */
export function classifyRun(before, after, cliFailed, reason) {
  if (cliFailed) return { status: 'error', reason: reason || 'agent CLI exited non-zero' };
  if (!before.exists && after.exists) return { status: 'created', newComments: after.commentCount };
  if (before.syncedAt !== after.syncedAt) {
    return { status: 'updated', newComments: Math.max(0, after.commentCount - before.commentCount) };
  }
  return { status: 'no-update' };
}

const WIN = process.platform === 'win32';
// Same guard as browser.mjs's winLine(): our argv is config-authored plus a
// digits-and-spaces prompt, which never legitimately needs a cmd.exe metachar.
const CMD_UNSAFE = /[&|<>^"%!]/;

function winLine(argv) {
  const bad = argv.find(a => CMD_UNSAFE.test(a));
  if (bad) throw new Error(`arg contains a cmd.exe metacharacter: ${String(bad).slice(0, 60)}`);
  return `"${argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}"`;
}

function runCli(argv) {
  return WIN
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', winLine(argv)], {
        encoding: 'utf8', timeout: 900000, windowsVerbatimArguments: true,
      })
    : spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 900000 });
}

function main(code) {
  const cfg = loadCliConfig();
  const template = cfg.commands[cfg.tool];
  if (!template) {
    const line = { code, status: 'error', reason: `no command configured for tool "${cfg.tool}" in data/agent-cli.json` };
    process.stdout.write(JSON.stringify(line) + '\n');
    process.exit(1);
    return;
  }

  const before = caseState(code);
  const prompt = `qualcomm case ${code} — capture only, skip PHASE 3 enrichment/analysis`;
  const r = runCli(fillArgv(template, prompt));
  const after = caseState(code);
  const failed = r.error != null || r.status !== 0;
  const reason = failed ? (r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 300) : '';
  const verdict = classifyRun(before, after, failed, reason);

  const runs = readJson(RUNS_PATH, {});
  runs[code] = { lastRunAt: new Date().toISOString(), ...verdict };
  writeJson(RUNS_PATH, runs);

  process.stdout.write(JSON.stringify({ code, ...verdict }) + '\n');
  process.exit(verdict.status === 'error' ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = process.argv[2];
  if (!code) { console.error('usage: node cli_run.mjs <CODE>'); process.exit(2); }
  main(code);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (PowerShell): `node --test tests/pipeline.test.mjs`
Expected: PASS, all tests green including the pre-existing ones (no regression).

- [ ] **Step 5: Wire `web/server.mjs`'s "Sync now" to the new script**

In `web/server.mjs`, change the `POST /api/run/<CODE>` handler (currently lines 167-175) from:

```js
      m = path.match(/^\/api\/run\/(\d{8})$/);
      if (req.method === 'POST' && m) {
        // Detached so a 10-minute capture never blocks the dashboard; progress
        // shows up in runs.json, which /api/overview already surfaces.
        spawn(process.execPath, [join(SCRIPTS, 'scheduler.mjs'), '--case', m[1]], {
          detached: true, stdio: 'ignore',
        }).unref();
        return send(res, 202, { started: m[1] });
      }
```

to:

```js
      m = path.match(/^\/api\/run\/(\d{8})$/);
      if (req.method === 'POST' && m) {
        // Detached so an agent-CLI run never blocks the dashboard; cli_run.mjs
        // writes its own runs.json entry, which /api/overview already surfaces.
        spawn(process.execPath, [join(HERE, 'cli_run.mjs'), m[1]], {
          detached: true, stdio: 'ignore',
        }).unref();
        return send(res, 202, { started: m[1] });
      }
```

`web/server.mjs` already defines `HERE = fileURLToPath(new URL('.', import.meta.url))` — the
`web/` directory itself, the same directory `cli_run.mjs` lives in — so `join(HERE, 'cli_run.mjs')`
resolves correctly with no new import needed.

- [ ] **Step 6: Run the full suite**

Run (PowerShell): `npm test`
Expected: PASS.

- [ ] **Step 7: Manual verification with the claude CLI**

1. Confirm the `claude` CLI is on PATH: Run (PowerShell): `claude --version`.
2. Delete any stale `data/agent-cli.json` so the default regenerates, or confirm it already reads
   `{"tool":"claude", ...}`.
3. Run (PowerShell): `npm run web`, open `http://127.0.0.1:8787`.
4. Pick one watched case, click "Sync now". Confirm (PowerShell, in a second window, or
   `Get-Content data\runs.json`) that a `claude` process actually ran (it will take at least as
   long as a real skill invocation — tens of seconds to minutes, not instant) and that
   `data/runs.json`'s entry for that code updates to `created`/`updated`/`no-update` matching
   whether `data/cases/<CODE>/case.json`'s content actually changed.
5. If the `claude` process hangs waiting on a permission prompt instead of completing: this means
   your `claude` CLI setup requires an interactive permission grant for the Bash/Read/Write tools
   `qualcomm-case-agent`'s `SKILL.md` uses. Add whatever non-interactive permission flag your
   `claude` CLI version supports to `data/agent-cli.json`'s `commands.claude` array (e.g. a
   permission-mode flag) — this is a machine-local config change, not a code change, so it isn't
   part of this task's commit.
6. Confirm a case with no changes on the portal comes back `no-update` on a second "Sync now"
   (verifies `classifyRun` isn't misreading an unchanged `syncedAt` as `updated`).

- [ ] **Step 8: Commit**

```bash
git add web/cli_run.mjs web/server.mjs tests/pipeline.test.mjs
git commit -m "feat(qualcomm-case-agent): trigger manual case sync via an agent CLI"
```
