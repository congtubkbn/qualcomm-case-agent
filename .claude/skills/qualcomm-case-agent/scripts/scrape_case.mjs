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
