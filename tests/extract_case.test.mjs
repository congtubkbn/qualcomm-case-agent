// tests/extract_case.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTRACT_SCRIPT = readFileSync(
  fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/extract_case.js', import.meta.url)),
  'utf8'
);

const EXPAND_SCRIPT = readFileSync(
  fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/expand_step.js', import.meta.url)),
  'utf8'
);

/**
 * Creates a lightweight mock DOM node hierarchy for testing extraction and expansion scripts.
 */
function createMockElement(tag, attrs = {}, text = '') {
  const children = [];
  const classList = new Set((attrs.className || attrs.class || '').split(/\s+/).filter(Boolean));
  let parent = null;

  const elem = {
    tagName: tag.toUpperCase(),
    attributes: { ...attrs },
    id: attrs.id || '',
    className: attrs.className || attrs.class || '',
    innerText: text,
    textContent: text,
    shadowRoot: null,
    parentElement: null,
    get parent() { return parent; },
    set parent(p) { parent = p; this.parentElement = p; },
    children,
    childNodes: children,
    addEventListener() {},
    dispatchEvent() { return true; },
    click() {
      if (this.onclick) this.onclick();
    },
    scrollIntoView() {},
    getAttribute(name) {
      return this.attributes[name] || null;
    },
    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === 'class' || name === 'className') {
        this.className = String(val);
        classList.clear();
        String(val).split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
      }
      if (name === 'id') this.id = String(val);
    },
    matches(sel) {
      if (sel === '*') return true;
      const selectors = sel.split(',').map(s => s.trim());
      for (const singleSel of selectors) {
        if (singleSel === '*') return true;
        const parts = singleSel.split(/(?=[.#\[])/);
        let matchAll = true;
        for (const part of parts) {
          if (part.startsWith('.')) {
            const cls = part.slice(1);
            if (!classList.has(cls) && !this.className.split(/\s+/).includes(cls)) { matchAll = false; break; }
          } else if (part.startsWith('#')) {
            if (this.id !== part.slice(1)) { matchAll = false; break; }
          } else if (part.startsWith('[') && part.endsWith(']')) {
            const attrMatch = part.slice(1, -1).match(/^([a-zA-Z0-9_-]+)(?:([*^$]?=)(["']?)(.*?)\3)?$/);
            if (attrMatch) {
              const [, attr, op, , val] = attrMatch;
              const curVal = this.getAttribute(attr);
              if (curVal === null) { matchAll = false; break; }
              if (op === '=' && curVal !== val) { matchAll = false; break; }
              if (op === '*=' && !curVal.includes(val)) { matchAll = false; break; }
              if (op === '^=' && !curVal.startsWith(val)) { matchAll = false; break; }
              if (op === '$=' && !curVal.endsWith(val)) { matchAll = false; break; }
            }
          } else if (part) {
            if (part.toUpperCase() !== this.tagName) { matchAll = false; break; }
          }
        }
        if (matchAll) return true;
      }
      return false;
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches(sel)) return cur;
        cur = cur.parent || cur.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const results = [];
      const selectors = sel.split(',').map(s => s.trim());
      function testElement(node, singleSel) {
        const tokens = singleSel.split(/\s+/);
        if (tokens.length === 1) {
          return node.matches(tokens[0]);
        }
        // Multi-level selector e.g. "div a"
        let cur = node;
        for (let i = tokens.length - 1; i >= 0; i--) {
          if (!cur || !cur.matches(tokens[i])) return false;
          if (i > 0) cur = cur.parent;
        }
        return true;
      }
      function walk(node) {
        for (const child of node.children) {
          for (const s of selectors) {
            if (testElement(child, s)) {
              if (!results.includes(child)) results.push(child);
              break;
            }
          }
          walk(child);
        }
      }
      walk(this);
      return results;
    },
    appendChild(child) {
      child.parent = this;
      child.parentElement = this;
      children.push(child);
      return child;
    }
  };
  return elem;
}

function createMockDocument() {
  const docElement = createMockElement('html');
  const body = createMockElement('body');
  docElement.appendChild(body);

  const doc = {
    title: '',
    documentElement: docElement,
    body,
    querySelector(sel) {
      return docElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return docElement.querySelectorAll(sel);
    },
    createElement(tag) {
      return createMockElement(tag);
    }
  };
  return doc;
}

function runInMockContext(scriptText, { doc, locationHref = 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854', anchor = null, probe = false } = {}) {
  const windowObj = {
    PointerEvent: function () {},
    MouseEvent: function () {},
    location: { href: locationHref, pathname: new URL(locationHref).pathname },
  };

  const sandbox = {
    document: doc,
    window: windowObj,
    location: windowObj.location,
    __ANCHOR: anchor,
    __PROBE: probe,
    Number,
    Array,
    String,
    Boolean,
    RegExp,
  };

  const ctx = vm.createContext(sandbox);
  return vm.runInContext(scriptText, ctx);
}

test('extract_case.js DOM extraction engine', async (t) => {
  await t.test('extracts metadata, clean comments with roles and attachments from mock Lightning DOM', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08603854 - QXDM log analysis for NR SA';

    // 1. Metadata section
    const subjectBtn = createMockElement('button', {}, 'Subject');
    const subjectContainer = createMockElement('div');
    subjectContainer.appendChild(subjectBtn);
    const subjectP = createMockElement('p', {}, 'QXDM log analysis for NR SA');
    subjectContainer.appendChild(subjectP);
    doc.body.appendChild(subjectContainer);

    const chipsetBtn = createMockElement('button', {}, 'Chipset');
    const chipsetContainer = createMockElement('div');
    chipsetContainer.appendChild(chipsetBtn);
    const chipsetP = createMockElement('p', {}, 'SDX75');
    chipsetContainer.appendChild(chipsetP);
    doc.body.appendChild(chipsetContainer);

    const accountBtn = createMockElement('button', {}, 'Account Name');
    const accountContainer = createMockElement('div');
    accountContainer.appendChild(accountBtn);
    const accountP = createMockElement('p', {}, 'VinFast Auto');
    accountContainer.appendChild(accountP);
    doc.body.appendChild(accountContainer);

    const descBtn = createMockElement('button', {}, 'Description');
    const descContainer = createMockElement('div');
    descContainer.appendChild(descBtn);
    const descP = createMockElement('p', {}, 'Device failed to register to 5G Standalone network.');
    descContainer.appendChild(descP);
    doc.body.appendChild(descContainer);

    // Status badge
    const statusEl = createMockElement('div', { role: 'status' }, '2 Chatter Feed Items');
    doc.body.appendChild(statusEl);

    // 2. Article 1: Customer initial report
    const article1 = createMockElement('article', { id: 'c_post_1' });
    const a1Author = createMockElement('a', {}, 'Nguyen Van A');
    const a1Timestamp = createMockElement('a', {}, '2 days ago');
    article1.appendChild(a1Author);
    article1.appendChild(a1Timestamp);

    const a1Body = createMockElement('div', { className: 'feedBodyInner' }, 'Tôi gửi kèm file log â”¬Ã¡ và cấu hình modem.Â \nChi tiết xem đính kèm.');
    article1.appendChild(a1Body);

    const a1Attach = createMockElement('a', { className: 'cuf-attachment', href: 'https://support.qualcomm.com/download/log_01.qxdm' }, 'log_01.qxdm');
    article1.appendChild(a1Attach);
    doc.body.appendChild(article1);

    // 3. Article 2: Qualcomm Engineer response
    const article2 = createMockElement('article', { id: 'c_post_2' });
    const a2Author = createMockElement('a', {}, 'John Doe (Qualcomm)');
    const a2Timestamp = createMockElement('a', {}, '1 day ago');
    article2.appendChild(a2Author);
    article2.appendChild(a2Timestamp);

    const a2Body = createMockElement('div', { className: 'feedBodyInner' }, 'We analyzed the QXDM log. Root cause: RRC Reject on n78 band.');
    article2.appendChild(a2Body);

    const a2Attach = createMockElement('a', { className: 'cuf-attachment', href: 'https://support.qualcomm.com/download/patch_sdx75.diff' }, 'patch_sdx75.diff');
    article2.appendChild(a2Attach);
    doc.body.appendChild(article2);

    // Execute extract_case.js
    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.caseNumber, '08603854');
    assert.equal(result.title, 'QXDM log analysis for NR SA');
    assert.equal(result.product, 'SDX75');
    assert.equal(result.customer, 'VinFast Auto');
    assert.equal(result.description, 'Device failed to register to 5G Standalone network.');
    assert.equal(result.displayedCommentCount, 2);
    assert.equal(result.comments.length, 2);

    // Assert Comment 1 (Customer, mojibake cleaned, attachment extracted)
    const c1 = result.comments[0];
    assert.equal(c1.author, 'Nguyen Van A');
    assert.equal(c1.role, 'Customer');
    assert.equal(c1.body.includes('â”¬Ã¡'), false);
    assert.equal(c1.body.includes('Tôi gửi kèm file log'), true);
    assert.equal(c1.attachments.length, 1);
    assert.equal(c1.attachments[0].name, 'log_01.qxdm');
    assert.equal(c1.attachments[0].url, 'https://support.qualcomm.com/download/log_01.qxdm');

    // Assert Comment 2 (Qualcomm engineer role categorized)
    const c2 = result.comments[1];
    assert.equal(c2.author, 'John Doe (Qualcomm)');
    assert.equal(c2.role, 'Qualcomm');
    assert.equal(c2.attachments.length, 1);
    assert.equal(c2.attachments[0].name, 'patch_sdx75.diff');
  });

  await t.test('handles System bot author and fallbacks for missing fields', () => {
    const doc = createMockDocument();
    doc.title = 'Cases'; // Generic title fallback

    const article1 = createMockElement('article', { id: 'sys_1' });
    const a1Author = createMockElement('a', {}, 'Automated Process');
    const a1Timestamp = createMockElement('a', {}, '5 hours ago');
    article1.appendChild(a1Author);
    article1.appendChild(a1Timestamp);
    const a1Body = createMockElement('div', { className: 'cuf-feedBodyText' }, 'Case severity escalated to Level 1.');
    article1.appendChild(a1Body);
    doc.body.appendChild(article1);

    const result = runInMockContext(EXTRACT_SCRIPT, {
      doc,
      locationHref: 'https://support.qualcomm.com/s/case/5004W00002Fk8sIQAR/08603854',
    });

    assert.equal(result.caseNumber, '08603854');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].role, 'System');
    assert.equal(result.comments[0].body, 'Case severity escalated to Level 1.');
    assert.equal(result.title, '');
  });
});

test('expand_step.js DOM expansion engine', async (t) => {
  await t.test('probes feed state without clicking when __PROBE is true', () => {
    const doc = createMockDocument();
    
    // Status badge
    const statusEl = createMockElement('div', { role: 'status' }, '5 Chatter Feed Items');
    doc.body.appendChild(statusEl);

    // Article with collapsed body
    const art = createMockElement('article', { id: 'art_1' });
    const authorA = createMockElement('a', {}, 'Engineer');
    const expandBtn = createMockElement('button', {}, 'Expand Post');
    const bodyEl = createMockElement('div', { className: 'feedBodyInner' }, 'Truncated text... Expand Post');
    art.appendChild(authorA);
    art.appendChild(expandBtn);
    art.appendChild(bodyEl);
    doc.body.appendChild(art);

    let clicked = false;
    expandBtn.onclick = () => { clicked = true; };

    const probeResult = runInMockContext(EXPAND_SCRIPT, { doc, probe: true });

    assert.equal(probeResult.articles, 1);
    assert.equal(probeResult.displayed, 5);
    assert.equal(probeResult.pendingExpand, 1);
    assert.equal(probeResult.clickedExpand, 0);
    assert.equal(clicked, false);
  });

  await t.test('clicks pending Expand Post and More comments in standard execution', () => {
    const doc = createMockDocument();
    
    const art = createMockElement('article', { id: 'art_1' });
    const authorA = createMockElement('a', {}, 'Engineer');
    const expandBtn = createMockElement('button', {}, 'Expand Post');
    const bodyEl = createMockElement('div', { className: 'feedBodyInner' }, 'Truncated text... Expand Post');
    art.appendChild(authorA);
    art.appendChild(expandBtn);
    art.appendChild(bodyEl);
    doc.body.appendChild(art);

    const moreCommentsBtn = createMockElement('button', { className: 'slds-button' }, 'View 3 more comments');
    doc.body.appendChild(moreCommentsBtn);

    let expandClicked = false;
    let moreCommentsClicked = false;
    expandBtn.onclick = () => { expandClicked = true; };
    moreCommentsBtn.onclick = () => { moreCommentsClicked = true; };

    const execResult = runInMockContext(EXPAND_SCRIPT, { doc, probe: false });

    assert.equal(execResult.clickedExpand, 1);
    assert.equal(execResult.clickedMoreComments, 1);
    assert.equal(expandClicked, true);
    assert.equal(moreCommentsClicked, true);
  });
});
