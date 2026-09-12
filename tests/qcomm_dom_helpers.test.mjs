// tests/qcomm_dom_helpers.test.mjs
//
// Loads dom_extractor.js's exact source into a jsdom context (script execution,
// not a hand-copied re-implementation) and exercises each shared helper —
// including the shadow-DOM case behind case 08503838 that motivated this
// file (see dom_extractor.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { stripComments } from '../.claude/skills/qcomm/scripts/browser.mjs';

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../.claude/skills/qcomm/scripts/dom_extractor.js',
);
const HELPERS_SRC = stripComments(readFileSync(SCRIPT_PATH, 'utf8'));

// Runs the real dom_extractor.js source inside a fresh jsdom window and
// returns its window.__QC_DOM__ helpers for the test to call directly.
function loadHelpers(html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(HELPERS_SRC);
  const qc = dom.window.__QC_DOM__ || {};
  return {
    window: dom.window,
    document: dom.window.document,
    txt: qc.txt,
    qsa: qc.qsa,
    isVisible: qc.isVisible,
    deepByText: qc.deepByText,
    fire: qc.fire,
    bodyOf: qc.bodyOf,
    authorOf: qc.authorOf,
    findAnchorIdx: qc.findAnchorIdx,
    skipAsCached: qc.skipAsCached,
  };
}

test('dom_extractor.js - shared helpers', async (t) => {
  await t.test('txt() collapses whitespace and trims', () => {
    const { document, txt } = loadHelpers('<!doctype html><body><div id="d">  hello\n  world  </div></body>');
    const el = document.getElementById('d');
    assert.equal(txt(el), 'hello world');
    assert.equal(txt(null), '');
  });

  await t.test('qsa() returns a real array matching the selector', () => {
    const { document, qsa } = loadHelpers(
      '<!doctype html><body><p class="x">a</p><p class="x">b</p><span class="x">c</span></body>',
    );
    const found = qsa('p.x');
    assert.equal(Array.isArray(found), true);
    assert.equal(found.length, 2);
    assert.equal(found[0].textContent, 'a');
  });

  await t.test('isVisible() rejects hidden-via-class, inline-style, computed-style, and offsetParent-null elements, and accepts a genuinely visible one', () => {
    const { window, document, isVisible } = loadHelpers(`<!doctype html><body>
      <style>.viaSheet { display: none; }</style>
      <div id="byClass" class="hidden">a</div>
      <div id="byInline" style="display:none">b</div>
      <div id="byOpacity" style="opacity:0">c</div>
      <div id="viaSheet" class="viaSheet">d</div>
      <div id="visible">e</div>
    </body>`);

    assert.equal(isVisible(document.getElementById('byClass')), false);
    assert.equal(isVisible(document.getElementById('byInline')), false);
    assert.equal(isVisible(document.getElementById('byOpacity')), false);
    // Hidden only via an external stylesheet rule (no class name jsdom's isVisible
    // recognizes and no inline style) — only the getComputedStyle() branch catches this.
    assert.equal(isVisible(document.getElementById('viaSheet')), false);
    assert.equal(isVisible(null), false);

    // Detached from the document -> offsetParent is null -> not visible.
    const detached = document.createElement('div');
    detached.textContent = 'detached';
    assert.equal(isVisible(detached), false);

    // A rendered, unhidden element -> visible. jsdom has no layout engine, so
    // offsetParent is always null even for elements really in the document;
    // stand in for "on screen" the same way isVisible's own position:fixed
    // carve-out does.
    const visible = document.getElementById('visible');
    Object.defineProperty(visible, 'offsetParent', { value: document.body });
    assert.equal(isVisible(visible), true);
  });

  await t.test('deepByText() pierces an open shadow root while excluding matches isVisible rejects', () => {
    const { document, deepByText } = loadHelpers('<!doctype html><body><div id="host"></div></body>');
    const host = document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });

    // jsdom has no layout engine, so offsetParent is always null — stand in
    // for "rendered and on screen" the same way isVisible's real position:fixed
    // carve-out does, so this test exercises the class/style/shadow logic
    // rather than jsdom's unimplemented layout.
    const visibleBtn = document.createElement('button');
    visibleBtn.textContent = 'More comments';
    Object.defineProperty(visibleBtn, 'offsetParent', { value: document.body });
    shadow.appendChild(visibleBtn);

    const hiddenBtn = document.createElement('button');
    hiddenBtn.textContent = 'More comments';
    hiddenBtn.style.display = 'none';
    Object.defineProperty(hiddenBtn, 'offsetParent', { value: document.body });
    shadow.appendChild(hiddenBtn);

    const found = deepByText('button', /^more\s+comments?$/i);
    assert.equal(found.length, 1);
    assert.equal(found[0], visibleBtn);
  });

  await t.test('fire() dispatches pointerdown/mousedown/pointerup/mouseup then .click()', () => {
    const { document, fire } = loadHelpers();
    const el = document.createElement('button');
    document.body.appendChild(el);

    const seen = [];
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      el.addEventListener(type, () => seen.push(type));
    });

    fire(el);

    assert.deepEqual(seen, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  await t.test('bodyOf() prefers a nested feed-body element and falls back to the article itself', () => {
    const { document, bodyOf } = loadHelpers(`<!doctype html><body>
      <article id="withBody"><div class="feedBodyInner">  nested body text  </div></article>
      <article id="withoutBody">  bare article text  </article>
    </body>`);

    assert.equal(bodyOf(document.getElementById('withBody')), 'nested body text');
    assert.equal(bodyOf(document.getElementById('withoutBody')), 'bare article text');
  });

  await t.test('findAnchorIdx() matches the article whose body starts with the anchor bodyStart prefix', () => {
    const { document, findAnchorIdx } = loadHelpers(`<!doctype html><body>
      <article id="a0">first post body</article>
      <article id="a1">second post body here, this is the anchor comment text padded out</article>
      <article id="a2">third post body</article>
    </body>`);
    const articles = [
      document.getElementById('a0'),
      document.getElementById('a1'),
      document.getElementById('a2'),
    ];

    assert.equal(findAnchorIdx(articles, { bodyStart: 'second post body here, this is the anchor' }), 1);
    assert.equal(findAnchorIdx(articles, { bodyStart: 'no such post' }), -1);
    assert.equal(findAnchorIdx(articles, null), -1);
    assert.equal(findAnchorIdx(articles, {}), -1);
  });

  await t.test('findAnchorIdx() also requires the author to match when the anchor carries one, so a new comment from a different author cannot false-match a shared body prefix', () => {
    const { document, findAnchorIdx } = loadHelpers(`<!doctype html><body>
      <article id="a0"><a href="#">Author B</a><div class="feedBodyInner">Dear QC, this is a fresh comment from a different author entirely</div></article>
      <article id="a1"><a href="#">Author A</a><div class="feedBodyInner">Dear QC, this is a fresh comment from a different author but older</div></article>
    </body>`);
    const articles = [document.getElementById('a0'), document.getElementById('a1')];
    const anchor = { author: 'Author A', bodyStart: 'Dear QC, this is a fresh comment from a different' };

    // Position 0 shares the 40-char prefix but is authored by B, not the cached anchor's A — must not match.
    assert.notEqual(findAnchorIdx(articles, anchor), 0);
    // Position 1 matches both prefix and author — must match.
    assert.equal(findAnchorIdx(articles, anchor), 1);

    // Anchor without an author (older cache shape) keeps matching on prefix alone.
    assert.equal(findAnchorIdx(articles, { bodyStart: 'Dear QC, this is a fresh comment from a different' }), 0);
  });

  await t.test('findAnchorIdx() treats a cached author of "" (extract_case.js author-extraction failure) as a real value to match, not as "no author field"', () => {
    const { document, findAnchorIdx } = loadHelpers(`<!doctype html><body>
      <article id="a0"><a href="#">Real Author</a><div class="feedBodyInner">Dear QC, this is a fresh comment from a different author entirely</div></article>
    </body>`);
    const articles = [document.getElementById('a0')];
    // Cached anchor's author extraction failed and stored "" (see extract_case.js:375) —
    // it must NOT be treated the same as an anchor with no `author` key at all.
    const anchor = { author: '', bodyStart: 'Dear QC, this is a fresh comment from a different' };

    assert.equal(findAnchorIdx(articles, anchor), -1);
  });

  await t.test('skipAsCached() skips only baseline posts at/after the anchor, and treats a falsy baseline as "skip anything at/after anchor"', () => {
    const { skipAsCached } = loadHelpers();
    const prefixes = ['p0', 'p1', 'p2', 'p3'];
    const baseline = ['p0', 'p1', 'p2'];
    const anchorIdx = 1;

    // Before the anchor: never skipped, regardless of baseline membership.
    assert.equal(skipAsCached(0, anchorIdx, baseline, prefixes), false);
    // At/after the anchor and present in baseline: skip.
    assert.equal(skipAsCached(1, anchorIdx, baseline, prefixes), true);
    assert.equal(skipAsCached(2, anchorIdx, baseline, prefixes), true);
    // At/after the anchor but NOT in baseline (revealed by a "More comments" click): don't skip.
    assert.equal(skipAsCached(3, anchorIdx, baseline, prefixes), false);
    // No anchor found: never skip.
    assert.equal(skipAsCached(2, -1, baseline, prefixes), false);
    // Falsy baseline: skip anything at/after the anchor (null-safety guard).
    assert.equal(skipAsCached(1, anchorIdx, null, prefixes), true);
    assert.equal(skipAsCached(0, anchorIdx, null, prefixes), false);
  });
});
