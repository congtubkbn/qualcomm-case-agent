// scripts/scrape_case.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_ROOT, DATA_DIR } from './_paths.mjs';

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
  const missingKeys = [];
  if (config.fields == null || config.fields.title == null) missingKeys.push('fields.title');
  if (config.comments == null || config.comments.container == null) missingKeys.push('comments.container');
  if (config.comments == null || config.comments.body == null) missingKeys.push('comments.body');
  if (config.displayedCommentCount == null) missingKeys.push('displayedCommentCount');
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

// Residual-expander detector for the final pre-extract snapshot confirmation.
// If the accessibility snapshot still shows obvious "load/show/view more" controls,
// the fixpoint loop likely missed collapsed content — warn (non-fatal).
export function snapshotHasExpanders(snapshot) {
  if (!snapshot) return false;
  return /(load more|show more|view more|see more|show all|view full|read more|\d+\s+more)/i.test(snapshot);
}

export function selectExitCode(state) {
  if (state.configMissing) return EXIT.CONFIG_MISSING;
  if (state.authNeeded)    return EXIT.AUTH_NEEDED;
  if (state.notFound)      return EXIT.NOT_FOUND;
  if (state.incomplete)    return EXIT.INCOMPLETE;
  return EXIT.OK;
}

// ---- Browser JS builders ----
// These strings are eval'd inside the browser page via agent-browser eval.
// They cannot be unit-tested without a real browser.

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

// expanderSel  : the discovered, precise expander selector (selectors.expanders.selector).
//                When provided it is AUTHORITATIVE — clicked directly, no regex gate — so the
//                loop is faster and never mis-toggles unrelated nav/menu controls. Falls back
//                to the broad heuristic only when it is null/empty (first run, pre-discovery).
// containerSel : the comment-container selector for an accurate fixpoint count.
export function buildExpandPassJs(expanderSel, containerSel) {
  const EXP  = expanderSel ? JSON.stringify(expanderSel) : 'null';
  const CONT = JSON.stringify(containerSel || '[class*="comment"],[role="listitem"],article');
  return `(function() {
  ${DEEP_ROOTS_JS}
  function expandPass() {
    window.scrollTo(0, document.body.scrollHeight);
    const RX = /^\\s*(show|view|load|see|expand|read|more|older|view full|show all|\\d+\\s+(more|repl|comment))/i;
    const STAMP = 'data-x-expanded';
    const EXP = ${EXP};
    let clicked = 0;
    const broad = 'button,a,[role="button"],[aria-expanded="false"],summary,'
              + '[class*="more"],[class*="expand"],[class*="truncat"],[class*="collapse"],[class*="showMore"]';
    const els = EXP ? deepAll(EXP) : deepAll(broad);
    for (const el of els) {
      if (el.getAttribute && el.getAttribute(STAMP)) continue;
      if (!EXP) {
        const label = (el.innerText || el.textContent || (el.getAttribute && el.getAttribute('aria-label')) || '').trim();
        const isToggle = (el.getAttribute && el.getAttribute('aria-expanded') === 'false') || el.tagName === 'SUMMARY';
        if (!isToggle && !RX.test(label)) continue;
      }
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (r && r.width === 0 && r.height === 0) continue;
      try { el.setAttribute && el.setAttribute(STAMP, '1'); el.click(); clicked++; } catch (e) {}
    }
    for (const d of deepAll('details:not([open])')) { d.open = true; clicked++; }
    const count = deepAll(${CONT}).length;
    return { clicked, count, h: Math.round(document.body.scrollHeight) };
  }
  return JSON.stringify(expandPass());
})()`;
}

export function buildExtractCaseJs(selectors) {
  const f = selectors.fields;
  const c = selectors.comments;
  const dcc = selectors.displayedCommentCount;

  return `(function() {
  ${DEEP_ROOTS_JS}
  const txt = el => (el && (el.innerText || el.textContent || '')).trim();
  const qs  = (root, sel) => root.querySelector(sel);
  const qsa = (root, sel) => [...root.querySelectorAll(sel)];

  const comments = qsa(document, ${JSON.stringify(c.container)}).map((node, i) => {
    const idEl = ${c.id ? `node.querySelector(${JSON.stringify(c.id)})` : 'null'};
    const id = (idEl && idEl.id) || node.id || ('c' + (i + 1));
    return {
      id,
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
    caseNumber:           location.href.split('/').pop(),
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

// ---- Paths (SKILL_ROOT + DATA_DIR from _paths.mjs: location-derived, walk-up to root) ----
const SELECTORS_PATH  = join(SKILL_ROOT, 'config', 'selectors.json');
const INDEX_PATH      = join(DATA_DIR, '_index.json');

// ---- agent-browser CLI wrappers ----
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
  try {
    return JSON.parse(result);
  } catch {
    throw new Error(`browserEval: non-JSON output from agent-browser (${result.slice(0, 200)})`);
  }
}

// ---- Fixpoint expand loop ----
function runFixpointLoop(expanderSel, containerSel, maxPasses = 25) {
  let prev  = { clicked: -1, count: -1, h: -1 };
  let stableRuns = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    const curr = browserEval(buildExpandPassJs(expanderSel, containerSel));
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

// ---- Progressive scroll fallback (for virtualized lists) ----
function progressiveScrollExtract(selectors, expectedCount, stepPx = 600, maxIter = 60) {
  const map = new Map();

  let lastHeight = -1;
  for (let iter = 0; iter < maxIter; iter++) {
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
    if (scrollResult.scrollHeight === lastHeight) break;
    lastHeight = scrollResult.scrollHeight;
  }
  if (map.size < expectedCount) {
    throw new Error(`progressiveScrollExtract: only ${map.size}/${expectedCount} after ${maxIter} iterations`);
  }

  return [...map.values()];
}

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

  // 2. Open case page
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

  // 4. Expand-all fixpoint loop (uses the precise discovered expander + container selectors
  //    when available, else the broad heuristic).
  const expanderSel  = selectors.expanders && selectors.expanders.selector;
  const containerSel = selectors.comments && selectors.comments.container;
  runFixpointLoop(expanderSel, containerSel);

  // 4b. ONE final snapshot to confirm the page is fully expanded before extracting
  //     (cheaper than snapshotting every pass; surfaces residual "load more" controls).
  const finalSnap = browserSnapshot();
  if (snapshotHasExpanders(finalSnap)) {
    process.stderr.write('Warning: residual expander controls in final snapshot — collapsed content may remain\n');
  }

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

  // 7. Hash + timestamp
  raw.hash = computeHash(raw);
  raw.extractedAt = new Date().toISOString();

  // 8. Write case JSON
  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, `${caseCode}.json`);
  writeFileSync(outPath, JSON.stringify(raw, null, 2), 'utf8');

  // 9. Update _index.json
  let index = {};
  if (existsSync(INDEX_PATH)) {
    try {
      index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    } catch {
      process.stderr.write('Warning: _index.json unreadable, starting fresh\n');
    }
  }
  index[caseCode] = {
    syncedAt: raw.extractedAt,
    commentCount: raw.comments.length,
    hash: raw.hash,
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');

  // 10. Success
  emit({ code: EXIT.OK, caseCode, commentCount: raw.comments.length, hash: raw.hash, path: outPath });
  process.exit(EXIT.OK);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Entry point guard — prevents main() running when imported for tests
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
