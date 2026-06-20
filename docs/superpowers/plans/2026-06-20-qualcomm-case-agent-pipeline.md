# qualcomm-case-agent Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 2-stage agentic pipeline (deterministic Stage 1 scrape + LLM Stage 2 enrichment) and the consumer interface for other agents, per the approved specs.

**Architecture:** Stage 1 is a Node.js script (`scrape_case.mjs`) that drives `agent-browser` CLI commands to scrape and hash the case, writing `data/cases/<CODE>.json` with a stable schema. Stage 2 enrichment is LLM-only (no script) and writes into `enrichment{}` within the same file without touching raw fields. `render_case.mjs` is updated to read from the new `enrichment` key. A `consumer-guide.md` documents the file-based interface for other agents.

**Tech Stack:** Node.js ESM (`.mjs`), `node:crypto` (SHA-256), `node:child_process` (agent-browser CLI), `node:test` + `node:assert` (unit tests, zero external deps), agent-browser v0.27.x.

---

## File map

| Action | Path | Responsibility |
|--------|------|----------------|
| CREATE | `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs` | Stage 1 deterministic scrape + hash + exit codes |
| CREATE | `.claude/skills/qualcomm-case-agent/config/selectors.json` | CSS selector config (populated by LLM discovery) |
| CREATE | `.claude/skills/qualcomm-case-agent/tests/scrape_case.test.mjs` | Unit tests for pure helpers |
| CREATE | `.claude/skills/qualcomm-case-agent/package.json` | Enables `npm test` |
| CREATE | `.claude/skills/qualcomm-case-agent/references/consumer-guide.md` | Consumer interface for Agent B |
| MODIFY | `.claude/skills/qualcomm-case-agent/scripts/render_case.mjs` | Read enrichment from `data.enrichment` key |
| MODIFY | `.claude/skills/qualcomm-case-agent/SKILL.md` | Phase 3 → call scrape_case.mjs; Phase 4 → incremental enrich |
| SYNC | `C:\Users\Win 11\.claude\skills\qualcomm-case-agent\` | Mirror all changes to global skill copy |

> All paths are relative to workspace root `E:\the.thoi\Project\access-qualcomm\` unless otherwise noted.

---

## Task 1: package.json + test runner

**Files:**
- Create: `.claude/skills/qualcomm-case-agent/package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "type": "module",
  "scripts": {
    "test": "node --test tests/scrape_case.test.mjs"
  }
}
```

Save to `.claude/skills/qualcomm-case-agent/package.json`.

- [ ] **Step 2: Create test directory**

```bash
mkdir -p .claude/skills/qualcomm-case-agent/tests
```

- [ ] **Step 3: Verify Node version supports node:test**

```bash
node --version
```

Expected: `v18.x` or higher. `node:test` requires Node 18+.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/package.json
git commit -m "chore: add package.json for qualcomm-case-agent test runner"
```

---

## Task 2: selectors.json skeleton

**Files:**
- Create: `.claude/skills/qualcomm-case-agent/config/selectors.json`

This file holds CSS selectors discovered from the live DOM. All values are `null` until LLM selector discovery runs. Stage 1 exits with code 6 when any required key is null.

- [ ] **Step 1: Create config directory**

```bash
mkdir -p .claude/skills/qualcomm-case-agent/config
```

- [ ] **Step 2: Write selectors.json**

```json
{
  "_version": 1,
  "_discoveredAt": null,
  "caseUrlBase": "https://support.qualcomm.com",
  "caseUrlPattern": null,
  "fields": {
    "title": null,
    "status": null,
    "priority": null,
    "severity": null,
    "product": null,
    "customer": null,
    "created": null,
    "updated": null,
    "description": null
  },
  "comments": {
    "container": null,
    "id": null,
    "timestamp": null,
    "company": null,
    "author": null,
    "role": null,
    "body": null,
    "analysisLog": null,
    "attachments": null
  },
  "displayedCommentCount": null,
  "expanders": {
    "selector": null
  }
}
```

Save to `.claude/skills/qualcomm-case-agent/config/selectors.json`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/config/selectors.json
git commit -m "feat: add selectors.json skeleton for Stage 1 config"
```

---

## Task 3: scrape_case.mjs — pure helpers (TDD)

**Files:**
- Create: `.claude/skills/qualcomm-case-agent/tests/scrape_case.test.mjs`
- Create: `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs` (pure exports only; main added in Task 5)

Write failing tests first, then implement each helper.

### 3a — Write all failing tests

- [ ] **Step 1: Write test file**

```javascript
// tests/scrape_case.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHash,
  countAssert,
  isFixpoint,
  selectExitCode,
  validateSelectors,
  EXIT,
} from '../scripts/scrape_case.mjs';

// computeHash
test('computeHash: same input → same hash', () => {
  const raw = {
    displayedCommentCount: 2,
    comments: [
      { id: 'c1', timestamp: '2024-01-01', author: 'Alice', body: 'Hello', analysisLog: [] },
      { id: 'c2', timestamp: '2024-01-02', author: 'Bob',   body: 'World', analysisLog: ['log1'] },
    ],
  };
  assert.strictEqual(computeHash(raw), computeHash(raw));
});

test('computeHash: body change → different hash', () => {
  const base = { displayedCommentCount: 1, comments: [{ id: 'c1', timestamp: '2024-01-01', author: 'Alice', body: 'Hello', analysisLog: [] }] };
  const changed = { displayedCommentCount: 1, comments: [{ id: 'c1', timestamp: '2024-01-01', author: 'Alice', body: 'CHANGED', analysisLog: [] }] };
  assert.notStrictEqual(computeHash(base), computeHash(changed));
});

test('computeHash: returns 64-char hex string', () => {
  const raw = { displayedCommentCount: 0, comments: [] };
  assert.match(computeHash(raw), /^[0-9a-f]{64}$/);
});

test('computeHash: excludes extractedAt from hash', () => {
  const raw1 = { displayedCommentCount: 1, comments: [{ id: 'c1', timestamp: 't', author: 'a', body: 'b', analysisLog: [] }], extractedAt: '2024-01-01T00:00:00Z' };
  const raw2 = { ...raw1, extractedAt: '2024-06-01T12:00:00Z' };
  assert.strictEqual(computeHash(raw1), computeHash(raw2));
});

// countAssert
test('countAssert: counts match → ok', () => {
  assert.deepStrictEqual(countAssert(5, 5), { ok: true });
});

test('countAssert: captured < displayed → not ok', () => {
  const r = countAssert(3, 5);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.captured, 3);
  assert.strictEqual(r.displayed, 5);
});

test('countAssert: displayed is null → ok with warning', () => {
  const r = countAssert(3, null);
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.warning === 'string' && r.warning.length > 0);
});

test('countAssert: captured > displayed → ok (extra elements not a failure)', () => {
  assert.deepStrictEqual(countAssert(6, 5), { ok: true });
});

// isFixpoint
test('isFixpoint: identical passes → true', () => {
  const pass = { clicked: 0, count: 5, h: 1000 };
  assert.strictEqual(isFixpoint(pass, pass), true);
});

test('isFixpoint: clicked > 0 → false', () => {
  assert.strictEqual(isFixpoint({ clicked: 0, count: 5, h: 1000 }, { clicked: 1, count: 5, h: 1000 }), false);
});

test('isFixpoint: count changed → false', () => {
  assert.strictEqual(isFixpoint({ clicked: 0, count: 5, h: 1000 }, { clicked: 0, count: 6, h: 1000 }), false);
});

test('isFixpoint: scrollHeight changed → false', () => {
  assert.strictEqual(isFixpoint({ clicked: 0, count: 5, h: 1000 }, { clicked: 0, count: 5, h: 1100 }), false);
});

// selectExitCode
test('selectExitCode: configMissing → 6', () => {
  assert.strictEqual(selectExitCode({ configMissing: true }), EXIT.CONFIG_MISSING);
});

test('selectExitCode: authNeeded → 3', () => {
  assert.strictEqual(selectExitCode({ authNeeded: true }), EXIT.AUTH_NEEDED);
});

test('selectExitCode: notFound → 4', () => {
  assert.strictEqual(selectExitCode({ notFound: true }), EXIT.NOT_FOUND);
});

test('selectExitCode: incomplete → 5', () => {
  assert.strictEqual(selectExitCode({ incomplete: true }), EXIT.INCOMPLETE);
});

test('selectExitCode: no flags → 0', () => {
  assert.strictEqual(selectExitCode({}), EXIT.OK);
});

// validateSelectors
test('validateSelectors: empty object → invalid', () => {
  const r = validateSelectors({});
  assert.strictEqual(r.valid, false);
  assert.ok(r.missingKeys.length > 0);
});

test('validateSelectors: null values → invalid', () => {
  const r = validateSelectors({ fields: null, comments: null, displayedCommentCount: null });
  assert.strictEqual(r.valid, false);
});

test('validateSelectors: all required keys present → valid', () => {
  const r = validateSelectors({
    fields: { title: 'h1' },
    comments: { container: '.comment' },
    displayedCommentCount: '.count-badge',
  });
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.missingKeys, []);
});
```

- [ ] **Step 2: Run tests — expect all to FAIL (import error)**

```bash
cd .claude/skills/qualcomm-case-agent && node --test tests/scrape_case.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` or similar (file doesn't exist yet).

### 3b — Implement pure helpers

- [ ] **Step 3: Create scrape_case.mjs with pure exports**

```javascript
// scripts/scrape_case.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Exit codes (exported so tests can import) ----
export const EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  AUTH_NEEDED: 3,
  NOT_FOUND: 4,
  INCOMPLETE: 5,
  CONFIG_MISSING: 6,
};

// ---- Pure helpers ----

export function validateSelectors(config) {
  const required = ['fields', 'comments', 'displayedCommentCount'];
  const missingKeys = required.filter(k => config[k] == null);
  return { valid: missingKeys.length === 0, missingKeys };
}

export function computeHash(raw) {
  const lines = [
    String(raw.displayedCommentCount ?? ''),
    ...raw.comments.map(c =>
      `${c.id}|${c.timestamp}|${c.author}|${c.body}|${(c.analysisLog || []).join('|')}`
    ),
  ];
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export function countAssert(capturedCount, displayedCount) {
  if (displayedCount == null) {
    return { ok: true, warning: 'displayedCommentCount not found in DOM' };
  }
  if (capturedCount < displayedCount) {
    return { ok: false, captured: capturedCount, displayed: displayedCount };
  }
  return { ok: true };
}

export function isFixpoint(prev, curr) {
  return curr.clicked === 0 && curr.count === prev.count && curr.h === prev.h;
}

export function selectExitCode(state) {
  if (state.configMissing) return EXIT.CONFIG_MISSING;
  if (state.authNeeded)    return EXIT.AUTH_NEEDED;
  if (state.notFound)      return EXIT.NOT_FOUND;
  if (state.incomplete)    return EXIT.INCOMPLETE;
  return EXIT.OK;
}
```

- [ ] **Step 4: Run tests — expect all to PASS**

```bash
cd .claude/skills/qualcomm-case-agent && node --test tests/scrape_case.test.mjs
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs \
        .claude/skills/qualcomm-case-agent/tests/scrape_case.test.mjs
git commit -m "feat: add scrape_case.mjs pure helpers with unit tests (TDD)"
```

---

## Task 4: scrape_case.mjs — browser JS builders

**Files:**
- Modify: `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs`

These functions return JavaScript strings that are eval'd inside the browser via `agent-browser eval`. They cannot be unit-tested without a browser; they are tested end-to-end on first login.

- [ ] **Step 1: Add browser JS builders to scrape_case.mjs**

Append after the `selectExitCode` function:

```javascript
// ---- Browser JS builders ----
// These strings are eval'd inside the browser page via agent-browser eval.

const DEEP_ROOTS_JS = `
function deepRoots(root) {
  const roots = [root];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) roots.push(...deepRoots(el.shadowRoot));
    if (el.tagName === 'IFRAME') {
      try { if (el.contentDocument) roots.push(...deepRoots(el.contentDocument)); } catch (e) {}
    }
  }
  return roots;
}
const deepAll = sel => deepRoots(document).flatMap(r => [...r.querySelectorAll(sel)]);
`;

export function buildExpandPassJs() {
  return `(function() {
  ${DEEP_ROOTS_JS}
  function expandPass() {
    window.scrollTo(0, document.body.scrollHeight);
    const RX = /^\\s*(show|view|load|see|expand|read|more|older|view full|show all|\\d+\\s+(more|repl|comment))/i;
    const STAMP = 'data-x-expanded';
    let clicked = 0;
    const sel = 'button,a,[role="button"],[aria-expanded="false"],summary,'
              + '[class*="more"],[class*="expand"],[class*="truncat"],[class*="collapse"],[class*="showMore"]';
    for (const el of deepAll(sel)) {
      if (el.getAttribute && el.getAttribute(STAMP)) continue;
      const label = (el.innerText || el.textContent || (el.getAttribute && el.getAttribute('aria-label')) || '').trim();
      const isToggle = (el.getAttribute && el.getAttribute('aria-expanded') === 'false') || el.tagName === 'SUMMARY';
      if (!isToggle && !RX.test(label)) continue;
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (r && r.width === 0 && r.height === 0) continue;
      try { el.setAttribute && el.setAttribute(STAMP, '1'); el.click(); clicked++; } catch (e) {}
    }
    for (const d of deepAll('details:not([open])')) { d.open = true; clicked++; }
    const count = deepAll('[class*="comment"],[role="listitem"],article').length;
    return { clicked, count, h: Math.round(document.body.scrollHeight) };
  }
  return JSON.stringify(expandPass());
})()`;
}

export function buildExtractCaseJs(selectors) {
  // Uses discovered selectors from selectors.json.
  // selectors.comments.container, .id, .timestamp, etc.
  const f = selectors.fields;
  const c = selectors.comments;
  const dcc = selectors.displayedCommentCount;

  return `(function() {
  ${DEEP_ROOTS_JS}
  const txt = el => (el && (el.innerText || el.textContent || '')).trim();
  const qs  = (root, sel) => root.querySelector(sel);
  const qsa = (root, sel) => [...root.querySelectorAll(sel)];

  const comments = qsa(document, ${JSON.stringify(c.container)}).map((node, i) => {
    const id = ${c.id ? `node.querySelector(${JSON.stringify(c.id)})?.id || node.id || ('c' + (i+1))` : `node.id || ('c' + (i+1))`};
    return {
      id:          id,
      timestamp:   txt(qs(node, ${JSON.stringify(c.timestamp)})),
      company:     txt(qs(node, ${JSON.stringify(c.company)})),
      author:      txt(qs(node, ${JSON.stringify(c.author)})),
      role:        txt(qs(node, ${JSON.stringify(c.role)})),
      body:        txt(qs(node, ${JSON.stringify(c.body)})) || txt(node),
      analysisLog: qsa(node, ${JSON.stringify(c.analysisLog || 'pre,code')}).map(x => txt(x)).filter(Boolean),
      attachments: qsa(node, ${JSON.stringify(c.attachments || 'a[href*="download"],a[href*="attach"]')}).map(a => ({ name: txt(a), href: a.href })),
    };
  }).filter(c => c.body || c.analysisLog.length);

  const displayed = (txt(document.querySelector(${JSON.stringify(dcc)})).match(/\\d+/) || [])[0];

  return JSON.stringify({
    caseNumber:           (txt(qs(document, ${JSON.stringify(f.title)})) || location.href.split('/').pop()),
    title:                txt(qs(document, ${JSON.stringify(f.title)})),
    status:               txt(qs(document, ${JSON.stringify(f.status)})),
    priority:             txt(qs(document, ${JSON.stringify(f.priority)})),
    severity:             txt(qs(document, ${JSON.stringify(f.severity)})),
    product:              txt(qs(document, ${JSON.stringify(f.product)})),
    customer:             txt(qs(document, ${JSON.stringify(f.customer)})),
    created:              txt(qs(document, ${JSON.stringify(f.created)})),
    updated:              txt(qs(document, ${JSON.stringify(f.updated)})),
    description:          txt(qs(document, ${JSON.stringify(f.description)})),
    url:                  location.href,
    displayedCommentCount: displayed != null ? Number(displayed) : null,
    comments,
  });
})()`;
}
```

- [ ] **Step 2: Run tests — confirm still passing (no regressions)**

```bash
cd .claude/skills/qualcomm-case-agent && node --test tests/scrape_case.test.mjs
```

Expected: all tests still pass.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs
git commit -m "feat: add browser JS builders to scrape_case.mjs"
```

---

## Task 5: scrape_case.mjs — main + I/O

**Files:**
- Modify: `.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs`

Adds the browser I/O layer (agent-browser CLI wrappers) and the `main()` function with the full pipeline: open URL → fixpoint loop → extract → assert → progressive scroll fallback → write JSON → update index.

- [ ] **Step 1: Add path constants and browser I/O helpers**

Append to `scrape_case.mjs` after the builder functions:

```javascript
// ---- Paths ----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SKILL_ROOT      = resolve(__dirname, '..');
const WORKSPACE_ROOT  = resolve(SKILL_ROOT, '../../..');
const DATA_DIR        = join(WORKSPACE_ROOT, 'data', 'cases');
const SELECTORS_PATH  = join(SKILL_ROOT, 'config', 'selectors.json');
const INDEX_PATH      = join(DATA_DIR, '_index.json');

// ---- agent-browser CLI wrappers ----
// Verify exact command syntax against: agent-browser skills get core --full
function abRun(args) {
  return execSync(`agent-browser ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function browserOpen(url) {
  abRun(`open ${JSON.stringify(url)}`);
}

function browserWait(ms) {
  abRun(`wait ${ms}`);
}

function browserSnapshot() {
  return abRun('snapshot -c');
}

function browserEval(js) {
  const result = abRun(`eval ${JSON.stringify(js)}`);
  return JSON.parse(result);
}
```

- [ ] **Step 2: Add fixpoint loop**

```javascript
// ---- Fixpoint expand loop ----
function runFixpointLoop(maxPasses = 25) {
  let prev  = { clicked: -1, count: -1, h: -1 };
  let stableRuns = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const curr = browserEval(buildExpandPassJs());
    browserWait(1500);

    if (isFixpoint(prev, curr)) {
      stableRuns++;
      if (stableRuns >= 2) return curr;
    } else {
      stableRuns = 0;
    }
    prev = curr;
  }
  throw new Error(`Fixpoint not reached after ${maxPasses} passes`);
}
```

- [ ] **Step 3: Add progressive scroll fallback**

```javascript
// ---- Progressive scroll fallback (for virtualized lists) ----
function progressiveScrollExtract(selectors, expectedCount, stepPx = 600) {
  const map = new Map(); // keyed by stable comment id

  let lastHeight = -1;
  while (true) {
    const scrollResult = browserEval(`(function() {
      window.scrollBy(0, ${stepPx});
      return { scrollY: window.scrollY, scrollHeight: document.body.scrollHeight };
    })()`);
    browserWait(800);

    const partial = browserEval(buildExtractCaseJs(selectors));
    for (const c of partial.comments) {
      map.set(c.id, c);
    }

    if (map.size >= expectedCount) break;
    if (scrollResult.scrollHeight === lastHeight) break; // no more content
    lastHeight = scrollResult.scrollHeight;
  }

  return [...map.values()];
}
```

- [ ] **Step 4: Add main() + entry point guard**

```javascript
// ---- Main ----
async function main(caseCode) {
  // 1. Load selectors config
  if (!existsSync(SELECTORS_PATH)) {
    emit({ code: EXIT.CONFIG_MISSING, reason: 'selectors.json not found' });
    process.exit(EXIT.CONFIG_MISSING);
  }
  const _selectorRaw = readFileSync(SELECTORS_PATH, 'utf8');
  const selectors = JSON.parse(_selectorRaw.charCodeAt(0) === 0xFEFF ? _selectorRaw.slice(1) : _selectorRaw);
  const { valid, missingKeys } = validateSelectors(selectors);
  if (!valid) {
    emit({ code: EXIT.CONFIG_MISSING, reason: 'selectors incomplete', missingKeys });
    process.exit(EXIT.CONFIG_MISSING);
  }

  // 2. Open case page (browser must already be running with data/chrome-profile via agent-browser)
  const caseUrl = selectors.caseUrlPattern
    ? selectors.caseUrlPattern.replace('<CODE>', caseCode)
    : `${selectors.caseUrlBase}/case/${caseCode}`;
  browserOpen(caseUrl);
  browserWait(3000);

  // 3. Detect auth redirect
  const snap = browserSnapshot();
  if (/account\.qualcomm\.com|okta\.com|sign.?in/i.test(snap)) {
    emit({ code: EXIT.AUTH_NEEDED, reason: 'redirected to authentication', url: caseUrl });
    process.exit(EXIT.AUTH_NEEDED);
  }
  if (/not found|403|access denied|no permission/i.test(snap)) {
    emit({ code: EXIT.NOT_FOUND, reason: 'case not found or no access', caseCode });
    process.exit(EXIT.NOT_FOUND);
  }

  // 4. Expand-all fixpoint loop
  runFixpointLoop();

  // 5. Extract
  let raw = browserEval(buildExtractCaseJs(selectors));

  // 6. Completeness assert; fallback to progressive scroll if needed
  let assertion = countAssert(raw.comments.length, raw.displayedCommentCount);
  if (!assertion.ok) {
    const fallbackComments = progressiveScrollExtract(selectors, raw.displayedCommentCount);
    raw = { ...raw, comments: fallbackComments };
    assertion = countAssert(raw.comments.length, raw.displayedCommentCount);
  }
  if (!assertion.ok) {
    emit({ code: EXIT.INCOMPLETE, ...assertion, caseCode });
    process.exit(EXIT.INCOMPLETE);
  }

  // 7. Hash + timestamp (raw fields only — enrichment never in hash)
  raw.hash = computeHash(raw);
  raw.extractedAt = new Date().toISOString();

  // 8. Write case JSON
  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, `${caseCode}.json`);
  writeFileSync(outPath, JSON.stringify(raw, null, 2), 'utf8');

  // 9. Update _index.json
  const index = existsSync(INDEX_PATH)
    ? JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    : {};
  index[caseCode] = {
    syncedAt: raw.extractedAt,
    commentCount: raw.comments.length,
    hash: raw.hash,
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');

  // 10. Machine-readable success line
  emit({ code: EXIT.OK, caseCode, commentCount: raw.comments.length, hash: raw.hash, path: outPath });
  process.exit(EXIT.OK);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Entry point guard — prevents main() from running when file is imported for testing
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const caseCode = process.argv[2]?.trim().toUpperCase();
  if (!caseCode) {
    emit({ code: EXIT.BAD_ARGS, reason: 'usage: node scrape_case.mjs <CASE_CODE>' });
    process.exit(EXIT.BAD_ARGS);
  }
  main(caseCode).catch(err => {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run tests — confirm still passing**

```bash
cd .claude/skills/qualcomm-case-agent && node --test tests/scrape_case.test.mjs
```

Expected: all tests pass (main() is not triggered by import).

- [ ] **Step 6: Verify script exits gracefully with bad args**

```bash
node .claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs
```

Expected output: `{"code":2,"reason":"usage: node scrape_case.mjs <CASE_CODE>"}` and exit code 2.

- [ ] **Step 7: Verify script exits with CONFIG_MISSING when selectors all null**

The selectors.json created in Task 2 has all null values. Run with a dummy code:

```bash
node .claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs TEST-00000001
```

Expected output: `{"code":6,"reason":"selectors incomplete","missingKeys":["fields","comments","displayedCommentCount"]}` and exit code 6.

> Note: This will fail if `agent-browser` is not installed. If so, the expected output is an execSync error before reaching the selector check — investigate and fix path resolution.

- [ ] **Step 8: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs
git commit -m "feat: add scrape_case.mjs main pipeline — Stage 1 deterministic scrape"
```

---

## Task 6: render_case.mjs — enrichment support

**Files:**
- Modify: `.claude/skills/qualcomm-case-agent/scripts/render_case.mjs`

The current renderer reads `data.engineerSummary`, `data.rootCause`, etc. at the top level and `c.summary` per comment. The new schema places these under `data.enrichment`. Update to read from `data.enrichment` (with graceful fallback when `enrichment` is absent = raw-only mode).

- [ ] **Step 1: Write a failing test with enrichment fixture**

Create `.claude/skills/qualcomm-case-agent/tests/render_case.test.mjs`:

```javascript
// tests/render_case.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');
const RENDER = join(SKILL_ROOT, 'scripts', 'render_case.mjs');
const TMP = join(SKILL_ROOT, 'tests', '_tmp_render');

function writeFixture(name, data) {
  const p = join(TMP, `${name}.json`);
  try { execSync(`mkdir -p "${TMP}"`); } catch {}
  writeFileSync(p, JSON.stringify(data), 'utf8');
  return p;
}

function cleanup(stem) {
  for (const ext of ['.json', '.md', '.html', '.report.md']) {
    const p = join(TMP, stem + ext);
    if (existsSync(p)) unlinkSync(p);
  }
}

test('render with enrichment: report.md contains engineerSummary', () => {
  const fixture = {
    caseNumber: 'CASE-00001',
    title: 'Test case',
    status: 'Open',
    comments: [{ id: 'c1', timestamp: '2024-01-01', company: 'ACME', author: 'Alice', role: 'Eng', body: 'Hello', analysisLog: [], attachments: [] }],
    displayedCommentCount: 1,
    hash: 'abc',
    extractedAt: '2024-01-01T00:00:00Z',
    enrichment: {
      engineerSummary: 'THIS_SUMMARY',
      rootCause: 'THIS_ROOT_CAUSE',
      recommendedActions: ['Action 1'],
      tags: ['NR', 'n78'],
      timeline: [{ date: '2024-01-01', event: 'Opened' }],
      commentSummaries: { c1: 'Comment summary here' },
      enrichedAt: '2024-01-01T01:00:00Z',
    },
  };
  const p = writeFixture('CASE-00001', fixture);
  execSync(`node "${RENDER}" "${p}"`);
  const report = readFileSync(join(TMP, 'CASE-00001.report.md'), 'utf8');
  assert.ok(report.includes('THIS_SUMMARY'), 'report should contain engineerSummary');
  assert.ok(report.includes('THIS_ROOT_CAUSE'), 'report should contain rootCause');
  cleanup('CASE-00001');
});

test('render without enrichment: report.md renders without crashing', () => {
  const fixture = {
    caseNumber: 'CASE-00002',
    title: 'Raw only case',
    status: 'Open',
    comments: [{ id: 'c1', timestamp: '2024-01-01', company: 'ACME', author: 'Bob', role: 'Eng', body: 'Raw body', analysisLog: [], attachments: [] }],
    displayedCommentCount: 1,
    hash: 'def',
    extractedAt: '2024-01-01T00:00:00Z',
  };
  const p = writeFixture('CASE-00002', fixture);
  execSync(`node "${RENDER}" "${p}"`);
  const report = readFileSync(join(TMP, 'CASE-00002.report.md'), 'utf8');
  assert.ok(report.includes('CASE-00002'), 'report should contain case number');
  cleanup('CASE-00002');
});

test('render: comment summary shown from enrichment.commentSummaries', () => {
  const fixture = {
    caseNumber: 'CASE-00003',
    title: 'Summary test',
    status: 'Open',
    comments: [{ id: 'myid', timestamp: '2024-01-01', company: 'X', author: 'Y', role: 'Z', body: 'body text', analysisLog: [], attachments: [] }],
    displayedCommentCount: 1,
    hash: 'ghi',
    extractedAt: '2024-01-01T00:00:00Z',
    enrichment: {
      engineerSummary: '',
      rootCause: '',
      recommendedActions: [],
      tags: [],
      timeline: [],
      commentSummaries: { myid: 'COMMENT_SUMMARY_TEXT' },
      enrichedAt: '2024-01-01T01:00:00Z',
    },
  };
  const p = writeFixture('CASE-00003', fixture);
  execSync(`node "${RENDER}" "${p}"`);
  const md = readFileSync(join(TMP, 'CASE-00003.md'), 'utf8');
  assert.ok(md.includes('COMMENT_SUMMARY_TEXT'), '.md should show comment summary');
  cleanup('CASE-00003');
});
```

- [ ] **Step 2: Run tests — expect failures (render reads wrong fields)**

```bash
cd .claude/skills/qualcomm-case-agent && node --test tests/render_case.test.mjs
```

Expected: "THIS_SUMMARY" not found in report.md (because it's under `enrichment.engineerSummary` but renderer reads `data.engineerSummary`).

- [ ] **Step 3: Update render_case.mjs**

After line 26 (`const comments = arr(data.comments);`), add:

```javascript
const enrich = data.enrichment || {};
```

Then make these replacements throughout the file (applies to `md()`, `report()`, and `html()` functions):

| Old | New |
|-----|-----|
| `data.engineerSummary` | `enrich.engineerSummary` |
| `data.rootCause` | `enrich.rootCause` |
| `data.recommendedActions` | `enrich.recommendedActions` |
| `data.tags` | `enrich.tags` |
| `data.timeline` | `enrich.timeline` |
| `c.summary` | `(enrich.commentSummaries || {})[c.id]` |
| `data.syncedAt` | `data.extractedAt` |

Apply to all three functions (`md`, `report`, `html`). There are multiple occurrences per function — replace all.

Example in `md()` function:

```javascript
// Before:
if (S(data.engineerSummary)) { L.push('## Engineer Summary', '', S(data.engineerSummary), ''); }
if (S(data.rootCause))       { L.push('## Root Cause', '', S(data.rootCause), ''); }

// After:
if (S(enrich.engineerSummary)) { L.push('## Engineer Summary', '', S(enrich.engineerSummary), ''); }
if (S(enrich.rootCause))       { L.push('## Root Cause', '', S(enrich.rootCause), ''); }
```

Example comment summary in `md()`:

```javascript
// Before:
if (S(c.summary)) L.push(`> **Summary (engineer):** ${S(c.summary)}`, '');

// After:
const cSummary = (enrich.commentSummaries || {})[c.id];
if (S(cSummary)) L.push(`> **Summary (engineer):** ${S(cSummary)}`, '');
```

- [ ] **Step 4: Run render tests — expect all to PASS**

```bash
cd .claude/skills/qualcomm-case-agent && node --test tests/render_case.test.mjs
```

Expected: all 3 tests pass.

- [ ] **Step 5: Run all tests — expect no regressions**

```bash
cd .claude/skills/qualcomm-case-agent && node --test tests/
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/scripts/render_case.mjs \
        .claude/skills/qualcomm-case-agent/tests/render_case.test.mjs
git commit -m "feat: update render_case.mjs to read from enrichment key"
```

---

## Task 7: SKILL.md — Phase 3 and Phase 4 update

**Files:**
- Modify: `.claude/skills/qualcomm-case-agent/SKILL.md`

Phase 3 currently describes LLM-driven expand+extract loop. Replace with: run `scrape_case.mjs`, handle exit codes. Phase 4 update: incremental enrichment (new comment ids only; re-generate case-level fields).

- [ ] **Step 1: Replace Phase 3 in SKILL.md**

Find the `## PHASE 3` section and replace its content with:

```markdown
## PHASE 3 — Scrape (Stage 1 — deterministic)

- **Goal:** Capture all raw case data and write `data/cases/<CODE>.json`.
- **Action:**
  ```bash
  node .claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs <CASE_CODE>
  ```
  The script exits with a machine-readable JSON line on stdout and an exit code.

- **Exit codes:**

  | Code | Meaning | Agent action |
  |------|---------|--------------|
  | 0 | ok | continue to incremental check → Phase 4 |
  | 2 | bad args | fix invocation |
  | 3 | auth-needed | ask user to sign in + email OTP in browser, retry |
  | 4 | case not found / no access | report to user, STOP |
  | 5 | incomplete (count < displayed after all fallbacks) | run LLM selector re-discovery (see Selector Discovery below), retry; STOP if still incomplete |
  | 6 | selectors.json missing or incomplete | run LLM selector discovery, retry |

- **Incremental check (exit 0 only):**
  Read `data/cases/_index.json["<CODE>"].hash` and compare to the `hash` field in the
  newly-written `data/cases/<CODE>.json`. If identical → "no update", STOP. Else → continue
  to Phase 4.

### Selector Discovery

Run when exit code 6 or 5 (persistent). The LLM:
1. `agent-browser snapshot -c` — read the real case page DOM.
2. Identify the CSS selectors for all fields listed in `config/selectors.json`.
3. Write the discovered selectors into `config/selectors.json` (keep `_version`, update `_discoveredAt`).
4. Retry `scrape_case.mjs`.
```

- [ ] **Step 2: Replace Phase 4 in SKILL.md**

Find the `## PHASE 4` section and replace with:

```markdown
## PHASE 4 — Enrich (Stage 2 — LLM, incremental)

- **Trigger:** Phase 3 exit 0 AND hash changed (new or updated case).
- **Skip:** If user/orchestrator requests raw-only sync, skip this phase entirely.

- **Goal:** Produce per-comment summaries and case-level synthesis, writing to
  `data.enrichment` in `data/cases/<CODE>.json`. Raw fields and `hash` are NEVER mutated.

- **Incremental logic:**
  1. Read existing `data/cases/<CODE>.json`.
  2. Identify new comment ids: those in `raw.comments[].id` NOT already in
     `enrichment.commentSummaries` (keyed by comment id).
  3. For each NEW comment: produce a `summary` (2–4 sentences; technical point, root-cause
     hypothesis, band/RAT/feature, action. Cite 3GPP clause if referenced. Key numbers
     (band/EARFCN, dBm, ms, error codes). If thin → "Insufficient detail".
  4. Re-generate case-level fields from ALL comments (not just new ones — new comments
     may change the overall picture):
     - `engineerSummary` (5–8 sentences: debug narrative + current conclusion)
     - `rootCause` (best current hypothesis or "Unresolved")
     - `recommendedActions[]` (concrete next steps)
     - `tags[]` (e.g. `["NR","n78","desense","RRC reestablishment","TS 38.331"]`)
     - `timeline[]` (date → key event, newest-first)
  5. Merge: `enrichment.commentSummaries = existing summaries + new summaries`.
  6. Write updated `enrichment` object back into `data/cases/<CODE>.json`.
     Update `_index.json["<CODE>"].enrichedAt`.

- **Re-enrich flow (user requests improved analysis):**
  Agent detects intent (keywords: "re-enrich", "redo analysis", "improve summary", "update enrichment").
  Ask: "Do you want to customize the enrichment prompt? (Enter to keep default)"
  If user provides custom instructions → use for this run only.
  Run Stage 2 over existing raw (no re-scrape). Only new ids enriched; case-level re-generated.

- **Rule:** Never invent technical facts not in the source. Summaries interpret; never replace
  or truncate source text.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/SKILL.md
git commit -m "feat: update SKILL.md Phase 3+4 for 2-stage pipeline and incremental enrichment"
```

---

## Task 8: consumer-guide.md

**Files:**
- Create: `.claude/skills/qualcomm-case-agent/references/consumer-guide.md`

- [ ] **Step 1: Write consumer-guide.md**

```markdown
# qualcomm-case-agent — Consumer Interface Guide

For agents, skills, and workflows (Agent B) that need Qualcomm case data.

## Quick start (3 steps)

1. Check if `data/cases/<CODE>.json` exists in the workspace.
2. If missing → invoke qualcomm-case-agent with the case code (see "Invoke pattern").
3. Read `data/cases/<CODE>.json` and pick the fields you need.

## File paths

| File | Contents |
|------|----------|
| `data/cases/_index.json` | Registry: `{ "<CODE>": { syncedAt, commentCount, hash, enrichedAt? } }` |
| `data/cases/<CODE>.json` | Full case data — raw + enrichment (see schema below) |
| `data/cases/<CODE>.report.md` | Human-readable summary (quick context; no structured parsing needed) |

All paths are relative to the workspace root.

## Key schema fields

**Raw (always present):**
```json
{
  "caseNumber": "string",
  "title": "string",
  "status": "string",
  "priority": "string",
  "severity": "string",
  "product": "string",
  "customer": "string",
  "description": "string",
  "url": "string",
  "displayedCommentCount": 0,
  "comments": [
    {
      "id": "stable id",
      "timestamp": "string",
      "company": "string",
      "author": "string",
      "role": "string",
      "body": "verbatim text",
      "analysisLog": ["verbatim"],
      "attachments": [{ "name": "string", "href": "string" }]
    }
  ],
  "hash": "sha256 over raw",
  "extractedAt": "ISO-8601"
}
```

**Enrichment (present unless raw-only sync — check before reading):**
```json
{
  "enrichment": {
    "engineerSummary": "5–8 sentence debug narrative",
    "rootCause": "best hypothesis or Unresolved",
    "recommendedActions": ["string"],
    "tags": ["NR", "n78", "desense"],
    "timeline": [{ "date": "string", "event": "string" }],
    "commentSummaries": { "<comment id>": "2–4 sentence summary" },
    "enrichedAt": "ISO-8601"
  }
}
```

## Invoke pattern

When `data/cases/<CODE>.json` is missing:

**Claude Code:**
```
Skill("qualcomm-case-agent") → say "sync case <CODE>"
```

**Cline / VS Code:**
Reference the qualcomm-case-agent skill and the case code in your message.
Cline auto-loads the skill from `.clinerules/qualcomm-case-agent.md`.

## Pseudocode

```javascript
const casePath = `data/cases/${CODE}.json`;
if (!fileExists(casePath)) {
  invoke('qualcomm-case-agent', `sync case ${CODE}`);
  // wait for completion
}
const caseData = JSON.parse(readFile(casePath));
const summary   = caseData.enrichment?.engineerSummary;
const rootCause = caseData.enrichment?.rootCause;
const comments  = caseData.comments; // newest-first
```

## Rules for consumers

- **Read-only.** Never write to `data/cases/<CODE>.json` or `data/cases/_index.json`.
- **NDA content.** Never pass `comments[].body` or `analysisLog` verbatim to external services.
- **Enrichment may be absent.** Check `caseData.enrichment` before reading enrichment fields.

## Full schema reference

See `docs/superpowers/specs/2026-06-20-qualcomm-case-agentic-pipeline-design.md` §6.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/qualcomm-case-agent/references/consumer-guide.md
git commit -m "docs: add consumer-guide.md for Agent B interface contract"
```

---

## Task 9: Sync changes to global skill

**Files:**
- Sync: `C:\Users\Win 11\.claude\skills\qualcomm-case-agent\` (mirror of project skill)

The project skill (`.claude/skills/qualcomm-case-agent/`) is the source of truth. Sync new and modified files to the global copy.

- [ ] **Step 1: Copy new files**

```powershell
$src = ".claude\skills\qualcomm-case-agent"
$dst = "C:\Users\Win 11\.claude\skills\qualcomm-case-agent"

Copy-Item "$src\scripts\scrape_case.mjs"          "$dst\scripts\scrape_case.mjs" -Force
Copy-Item "$src\scripts\render_case.mjs"           "$dst\scripts\render_case.mjs" -Force
Copy-Item "$src\config\selectors.json"             "$dst\config\selectors.json"   -Force
Copy-Item "$src\references\consumer-guide.md"      "$dst\references\consumer-guide.md" -Force
Copy-Item "$src\SKILL.md"                          "$dst\SKILL.md"                -Force
Copy-Item "$src\tests\scrape_case.test.mjs"        "$dst\tests\scrape_case.test.mjs" -Force
Copy-Item "$src\tests\render_case.test.mjs"        "$dst\tests\render_case.test.mjs" -Force
Copy-Item "$src\package.json"                      "$dst\package.json"            -Force
```

- [ ] **Step 2: Verify key files exist in global copy**

```powershell
$dst = "C:\Users\Win 11\.claude\skills\qualcomm-case-agent"
Test-Path "$dst\scripts\scrape_case.mjs"
Test-Path "$dst\config\selectors.json"
Test-Path "$dst\references\consumer-guide.md"
```

Expected: all `True`.

- [ ] **Step 3: Confirm no absolute paths leaked into project skill copy**

```bash
grep -r "E:\\\\the.thoi\|C:\\\\Users\\\\Win" .claude/skills/qualcomm-case-agent/
```

Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final state — all pipeline files in place"
```

---

## Self-review checklist

- [x] **Spec coverage:**
  - §3 Stage 1 `scrape_case.mjs` → Task 3+4+5
  - §3 Stage 2 enrichment (incremental) → Task 7 Phase 4 update
  - §3 `render_case.mjs` enrichment → Task 6
  - §4.1 `selectors.json` → Task 2
  - §4.5 `_index.json` update → Task 5 Step 4
  - §6 Stable schema → Task 6 (render reads from `enrichment` key)
  - §7 Incremental hash → Task 3 (`computeHash` covers raw only)
  - §8 Exit codes → Task 3+5
  - Consumer interface spec → Task 8
  - UC-5 incremental enrich → Task 7 Phase 4
  - UC-7 re-enrich with custom prompt → Task 7 Phase 4 (re-enrich flow)
  - UC-9 incomplete = no partial, retry → Task 5 Step 3+4

- [x] **No placeholders.** All steps have complete code.
- [x] **Type consistency.** `EXIT` constants referenced consistently. `enrich` variable added before all functions that use it.
- [x] **`entry point guard`** in scrape_case.mjs prevents test import from triggering `main()`.
