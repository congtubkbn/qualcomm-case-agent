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

let SWITCH_TAB_SCRIPT = '';
try {
  SWITCH_TAB_SCRIPT = readFileSync(
    fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/switch_tab.js', import.meta.url)),
    'utf8'
  );
} catch {
  // Will be populated when switch_tab.js is created
}

let CHECK_COLLAPSED_SCRIPT = '';
try {
  CHECK_COLLAPSED_SCRIPT = readFileSync(
    fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/check_collapsed.js', import.meta.url)),
    'utf8'
  );
} catch {
  // Optional
}

/**
 * Creates a lightweight mock DOM node hierarchy for testing extraction and expansion scripts.
 */
function createMockTextNode(text) {
  return { nodeType: 3, textContent: text, tagName: undefined };
}

function createMockElement(tag, attrs = {}, text = '') {
  // `nodes` holds every appended child (elements AND text nodes, in order) —
  // real childNodes. `children` (below) filters to elements only — real
  // .children — since querySelectorAll's walk() and .matches() assume
  // element-shaped nodes and would throw on a bare text node.
  const nodes = [];
  const classList = new Set((attrs.className || attrs.class || '').split(/\s+/).filter(Boolean));
  let parent = null;
  const style = attrs.style ? { ...attrs.style } : {};

  const elem = {
    tagName: tag.toUpperCase(),
    attributes: { ...attrs, class: attrs.className || attrs.class || '' },
    id: attrs.id || '',
    className: attrs.className || attrs.class || '',
    classList: {
      contains(cls) { return classList.has(cls); },
      add(cls) { classList.add(cls); elem.className = Array.from(classList).join(' '); },
      remove(cls) { classList.delete(cls); elem.className = Array.from(classList).join(' '); },
    },
    style,
    offsetParent: attrs.offsetParent !== undefined ? attrs.offsetParent : undefined,
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parent || cur.parentElement;
      }
      return false;
    },
    cloneNode(deep = false) {
      // Detached nodes have no layout, so real Chrome's innerText on a clone
      // falls back to something textContent-like and loses <br>/block-level
      // line breaks (issue #83). Model that here instead of copying `text`
      // verbatim, so tests can catch code that reads innerText post-clone.
      const cloned = createMockElement(this.tagName.toLowerCase(), { ...this.attributes, className: this.className, id: this.id, style: { ...this.style } }, text.replace(/\n+/g, ' '));
      if (!deep) return cloned;
      for (const child of nodes) {
        cloned.appendChild(child.nodeType === 3 ? createMockTextNode(child.textContent) : child.cloneNode(true));
      }
      return cloned;
    },
    remove() {
      if (this.parent) {
        const idx = this.parent.childNodes.indexOf(this);
        if (idx >= 0) this.parent.childNodes.splice(idx, 1);
        this.parent = null;
        this.parentElement = null;
      }
    },
    removeChild(child) {
      const idx = nodes.indexOf(child);
      if (idx >= 0) nodes.splice(idx, 1);
      child.parent = null;
      child.parentElement = null;
      return child;
    },
    get innerText() {
      if (text) return text;
      return nodes.map(c => c.innerText || c.textContent || '').join(' ').trim();
    },
    set innerText(v) { text = v; },
    get textContent() {
      if (text) return text;
      return nodes.map(c => c.textContent || c.innerText || '').join(' ').trim();
    },
    set textContent(v) { text = v; },
    shadowRoot: null,
    attachShadow(options = { mode: 'open' }) {
      const root = createMockElement('#shadow-root');
      root.host = elem;
      elem.shadowRoot = root;
      return root;
    },
    getRootNode() {
      let cur = this;
      while (cur.parent || cur.parentElement) {
        cur = cur.parent || cur.parentElement;
      }
      return cur;
    },
    parentElement: null,
    get parent() { return parent; },
    set parent(p) { parent = p; this.parentElement = p; },
    get children() { return nodes.filter(n => n.nodeType !== 3); },
    childNodes: nodes,
    addEventListener() {},
    dispatchEvent() { return true; },
    click() {
      if (this.onclick) this.onclick();
    },
    scrollIntoView() {},
    getAttribute(name) {
      if (name === 'style') {
        if (typeof this.attributes.style === 'string') return this.attributes.style;
        if (this.style && typeof this.style === 'object') {
          return Object.entries(this.style).map(([k, v]) => `${k}: ${v}`).join('; ');
        }
      }
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
              const rawVal = this.getAttribute(attr);
              if (rawVal === null) { matchAll = false; break; }
              const curVal = String(rawVal);
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
      nodes.push(child);
      return child;
    },
    getBoundingClientRect() {
      const rect = {
        top: this._displayPosition || 0,
        left: 0,
        right: 100,
        bottom: (this._displayPosition || 0) + 50,
        width: 100,
        height: 50,
        x: 0,
        y: this._displayPosition || 0,
      };
      return rect;
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
  await t.test('extracts metadata, clean comments with attachments from mock Lightning DOM', () => {
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
    assert.equal(result.accountName, 'VinFast Auto');
    assert.equal(result.description, 'Device failed to register to 5G Standalone network.');
    assert.equal(result.displayedCommentCount, 2);
    assert.equal(result.comments.length, 2);

    // Assert Comment 1 (mojibake cleaned, attachment extracted)
    const c1 = result.comments[0];
    assert.equal(c1.author, 'Nguyen Van A');
    assert.equal(c1.body.includes('â”¬Ã¡'), false);
    assert.equal(c1.body.includes('Tôi gửi kèm file log'), true);
    assert.equal(c1.attachments.length, 1);
    assert.equal(c1.attachments[0].name, 'log_01.qxdm');
    assert.equal(c1.attachments[0].url, 'https://support.qualcomm.com/download/log_01.qxdm');

    // Assert Comment 2
    const c2 = result.comments[1];
    assert.equal(c2.author, 'John Doe (Qualcomm)');
    assert.equal(c2.attachments.length, 1);
    assert.equal(c2.attachments[0].name, 'patch_sdx75.diff');
  });

  await t.test('extracted comment object has exactly the trimmed field set (no role/company)', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08603854 - QXDM log analysis for NR SA';

    const article1 = createMockElement('article', { id: 'c_post_1' });
    const a1Author = createMockElement('a', {}, 'Nguyen Van A');
    const a1Timestamp = createMockElement('a', {}, '2 days ago');
    article1.appendChild(a1Author);
    article1.appendChild(a1Timestamp);
    const a1Body = createMockElement('div', { className: 'feedBodyInner' }, 'Body text here.');
    article1.appendChild(a1Body);
    doc.body.appendChild(article1);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    assert.deepEqual(
      Object.keys(result.comments[0]).sort(),
      ['attachments', 'author', 'body', 'displayPosition', 'id', 'isReply', 'parentIndex', 'timestamp'].sort()
    );
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
    assert.equal(result.comments[0].body, 'Case severity escalated to Level 1.');
    assert.equal(result.title, null);
  });

  await t.test('extracts timestamps from span.cuf-timestamp, time, and uiOutputDateTime elements', () => {
    const doc = createMockDocument();

    // Nested reply with span.cuf-timestamp
    const art1 = createMockElement('article', { id: 'reply_1' });
    const a1 = createMockElement('a', {}, 'Aiden An');
    const span1 = createMockElement('span', { className: 'cuf-timestamp' }, 'August 21, 2026 at 4:00 PM');
    const body1 = createMockElement('div', { className: 'feedBodyInner' }, 'Dear customer, please check TAU logs.');
    art1.appendChild(a1);
    art1.appendChild(span1);
    art1.appendChild(body1);
    doc.body.appendChild(art1);

    // Reply with <time> element
    const art2 = createMockElement('article', { id: 'reply_2' });
    const a2 = createMockElement('a', {}, 'beomjun kim');
    const time2 = createMockElement('time', {}, '3 hours ago');
    const body2 = createMockElement('div', { className: 'feedBodyInner' }, 'Dear QCOM, please focus on VoNR cap.');
    art2.appendChild(a2);
    art2.appendChild(time2);
    art2.appendChild(body2);
    doc.body.appendChild(art2);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 2);
    assert.equal(result.comments[0].timestamp, 'August 21, 2026 at 4:00 PM');
    assert.equal(result.comments[1].timestamp, '3 hours ago');
  });

  await t.test('extracts timestamps from title attributes, uiOutputDateTime, and relative text patterns', () => {
    const doc = createMockDocument();

    // 1. Article with empty text but valid title attribute on timestamp anchor/span
    const art1 = createMockElement('article', { id: 'reply_title' });
    const a1 = createMockElement('a', {}, 'CS Lee');
    const span1 = createMockElement('span', { className: 'cuf-timestamp', title: '2026-08-20T10:15:00Z' }, '');
    const body1 = createMockElement('div', { className: 'feedBodyInner' }, 'Please check attached QXDM trace.');
    art1.appendChild(a1);
    art1.appendChild(span1);
    art1.appendChild(body1);
    doc.body.appendChild(art1);

    // 2. Article with uiOutputDateTime class
    const art2 = createMockElement('article', { id: 'reply_uiout' });
    const a2 = createMockElement('a', {}, 'OEM Developer');
    const uiDate2 = createMockElement('span', { className: 'uiOutputDateTime' }, 'Yesterday at 5:20 PM');
    const body2 = createMockElement('div', { className: 'feedBodyInner' }, 'Uploaded modem dump.');
    art2.appendChild(a2);
    art2.appendChild(uiDate2);
    art2.appendChild(body2);
    doc.body.appendChild(art2);

    // 3. Article with relative time in a span.feedItemTimestamp
    const art3 = createMockElement('article', { id: 'reply_feeditem' });
    const a3 = createMockElement('a', {}, 'Support Lead');
    const span3 = createMockElement('span', { className: 'feedItemTimestamp' }, '45 minutes ago');
    const body3 = createMockElement('div', { className: 'feedBodyInner' }, 'Reviewing the crash dump.');
    art3.appendChild(a3);
    art3.appendChild(span3);
    art3.appendChild(body3);
    doc.body.appendChild(art3);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 3);
    assert.equal(result.comments[0].timestamp, '2026-08-20T10:15:00Z');
    assert.equal(result.comments[1].timestamp, 'Yesterday at 5:20 PM');
    assert.equal(result.comments[2].timestamp, '45 minutes ago');
  });

  await t.test('filters out garbage timestamp text (tooltips/aria) and removes analysisLog field', () => {
    const doc = createMockDocument();

    const art1 = createMockElement('article', { id: 'garbage_ts_1' });
    const a1 = createMockElement('a', {}, 'Test Engineer');
    // Salesforce tooltip link that should be blacklisted
    const aTooltip = createMockElement('a', {}, 'Click for single-item view of this post.');
    const aExpand = createMockElement('a', {}, 'Expand Post');
    const aChatter = createMockElement('a', {}, 'Chatter Feed Item');
    const body1 = createMockElement('div', { className: 'feedBodyInner' }, 'Just a normal comment text.');
    art1.appendChild(a1);
    art1.appendChild(aTooltip);
    art1.appendChild(aExpand);
    art1.appendChild(aChatter);
    art1.appendChild(body1);
    doc.body.appendChild(art1);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    const c = result.comments[0];
    // Timestamp should NOT be the garbage string
    assert.notEqual(c.timestamp, 'Click for single-item view of this post.');
    assert.notEqual(c.timestamp, 'Expand Post');
    assert.notEqual(c.timestamp, 'Chatter Feed Item');
    assert.equal(c.timestamp, ''); // Since no valid timestamp candidate exists
    // analysisLog should NOT exist on comment
    assert.equal('analysisLog' in c, false);
  });

  // Issue #86: preview generation is owned solely by the finalize path
  // (scrape_case.mjs) now — the page script can't share code with it (it
  // crosses as a base64 IIFE, no imports), which is what let two independent
  // implementations drift apart. So it stops computing one and returns the
  // comment verbatim (author/timestamp/body/attachments) with no preview
  // field at all, whatever the body looks like.
  await t.test('does not emit a summary/preview field — that is the finalize path\'s job alone', () => {
    const doc = createMockDocument();

    const art1 = createMockElement('article', { id: 'sum_1' });
    const a1 = createMockElement('a', {}, 'Ken Lee');
    const body1 = createMockElement('div', { className: 'feedBodyInner' }, 'Dear customer,\n\nThank you for opening the case.\nWe will check and update.');
    art1.appendChild(a1);
    art1.appendChild(body1);
    doc.body.appendChild(art1);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    assert.equal('summary' in result.comments[0], false);
  });

  // Issue #42: two comments whose parsed timestamps tie (e.g. both "15 days
  // ago") need a secondary ordering signal, since NodeList/extraction order
  // can diverge from true on-page visual order. displayPosition (this article's
  // getBoundingClientRect().top) is that signal — captured per comment here,
  // independent of extraction order, regardless of what the tied timestamp text is.
  await t.test('captures displayPosition per comment for later tie-break use', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 00000001 - Synthetic tie-break fixture';

    const art1 = createMockElement('article', { id: 'reply_a' });
    art1._displayPosition = 100; // higher on page
    const a1 = createMockElement('a', {}, 'Engineer A');
    const ts1 = createMockElement('span', { className: 'cuf-timestamp' }, '15 days ago');
    const body1 = createMockElement('div', { className: 'feedBodyInner' }, 'First reply body text.');
    art1.appendChild(a1);
    art1.appendChild(ts1);
    art1.appendChild(body1);
    doc.body.appendChild(art1);

    const art2 = createMockElement('article', { id: 'reply_b' });
    art2._displayPosition = 250; // lower on page
    const a2 = createMockElement('a', {}, 'Engineer B');
    const ts2 = createMockElement('span', { className: 'cuf-timestamp' }, '15 days ago');
    const body2 = createMockElement('div', { className: 'feedBodyInner' }, 'Second reply body text.');
    art2.appendChild(a2);
    art2.appendChild(ts2);
    art2.appendChild(body2);
    doc.body.appendChild(art2);

    const result = runInMockContext(EXTRACT_SCRIPT, {
      doc,
      locationHref: 'https://support.qualcomm.com/s/case/000000000000000AAA/00000001',
    });

    assert.equal(result.comments.length, 2);
    assert.equal(result.comments[0].timestamp, '15 days ago');
    assert.equal(result.comments[1].timestamp, '15 days ago');
    assert.equal(result.comments[0].displayPosition, 100);
    assert.equal(result.comments[1].displayPosition, 250);
  });

  await t.test('extracts full Salesforce Detail tab fields (Contact Name, Customer Project, Opened/Closed Date, Related CRs, etc.)', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08603854 - VoNR Handover Failure';

    // Form element helper
    function addFormField(label, value, isLink = false) {
      const formEl = createMockElement('div', { className: 'slds-form-element record-layout-item' });
      const labelEl = createMockElement('span', { className: 'slds-form-element__label test-id__field-label' }, label);
      formEl.appendChild(labelEl);
      const controlEl = createMockElement('div', { className: 'slds-form-element__control' });
      if (isLink) {
        const a = createMockElement('a', {}, value);
        controlEl.appendChild(a);
      } else {
        const text = createMockElement('span', { className: 'lightning-formatted-text' }, value);
        controlEl.appendChild(text);
      }
      formEl.appendChild(controlEl);
      doc.body.appendChild(formEl);
    }

    addFormField('Contact Name', 'Mai Ngoc', true);
    addFormField('Date/Time Opened', '08/10/2026, 09:30 AM');
    addFormField('Date/Time Closed', '08/20/2026, 04:15 PM');
    addFormField('Customer Project', 'VinFast VF9 MY26');
    addFormField('Account Name', 'VinFast Auto LLC');
    addFormField('Related CRs', 'CR3798678, CR3801234');
    addFormField('Case Record Type Name', 'Customer Support');
    addFormField('Description Information', 'VoNR call drops during 5G SA to EPS Fallback transition.');
    addFormField('Status', 'Closed');
    addFormField('Priority', '1 - Critical');
    addFormField('Subject', 'VoNR Handover Failure');
    addFormField('Chipset', 'SDX75');

    // Add 1 comment article
    const art = createMockElement('article', { id: 'c1' });
    art.appendChild(createMockElement('a', {}, 'Mai Ngoc'));
    art.appendChild(createMockElement('a', {}, '10 days ago'));
    art.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Initial report details.'));
    doc.body.appendChild(art);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.caseNumber, '08603854');
    assert.equal(result.contactName, 'Mai Ngoc');
    assert.equal(result.openedAt, '08/10/2026, 09:30 AM');
    assert.equal(result.closedAt, '08/20/2026, 04:15 PM');
    assert.equal(result.customerProject, 'VinFast VF9 MY26');
    assert.equal(result.accountName, 'VinFast Auto LLC');
    assert.equal(result.relatedCRs, 'CR3798678, CR3801234');
    assert.equal(result.caseRecordType, 'Customer Support');
    assert.equal(result.description, 'VoNR call drops during 5G SA to EPS Fallback transition.');
    assert.equal(result.status, 'Closed');
    assert.equal(result.priority, '1 - Critical');
    assert.equal(result.title, 'VoNR Handover Failure');
    assert.equal(result.product, 'SDX75');
  });

  // Issue #82: Salesforce Lightning renders a hidden hover-preview affordance
  // ("Preview") nested inside a Lookup-type field's <a>. innerText swallows it,
  // producing "Luyen Kieu BaPreview" style noise in Contact Name / Customer
  // Project / Customer field values.
  await t.test('strips the Lightning Lookup "Preview" affordance from field values', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08603854 - QXDM log analysis for NR SA';

    function addLookupField(label, value) {
      const formEl = createMockElement('div', { className: 'slds-form-element record-layout-item' });
      const labelEl = createMockElement('span', { className: 'slds-form-element__label test-id__field-label' }, label);
      formEl.appendChild(labelEl);
      const controlEl = createMockElement('div', { className: 'slds-form-element__control' });
      const a = createMockElement('a');
      const nameSpan = createMockElement('span', {}, value);
      const previewSpan = createMockElement('span', { className: 'slds-assistive-text' }, 'Preview');
      a.appendChild(nameSpan);
      a.appendChild(previewSpan);
      controlEl.appendChild(a);
      formEl.appendChild(controlEl);
      doc.body.appendChild(formEl);
    }

    addLookupField('Contact Name', 'Luyen Kieu Ba');
    addLookupField('Customer Project', 'SS_SM7635_XCover7_Pro_EU');
    addLookupField('Account Name', 'Samsung Electronics');

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.contactName, 'Luyen Kieu Ba');
    assert.equal(result.customerProject, 'SS_SM7635_XCover7_Pro_EU');
    assert.equal(result.accountName, 'Samsung Electronics');
    assert.equal(result.contactName.includes('Preview'), false);
    assert.equal(result.customerProject.includes('Preview'), false);
    assert.equal(result.accountName.includes('Preview'), false);
  });

  // Issue #82: the same "Preview" affordance leaks into the FIRST <a> of a
  // Chatter article, which extract_case.js uses as the comment author.
  await t.test('strips the "Preview" affordance from comment author extraction', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08603854 - QXDM log analysis for NR SA';

    const art = createMockElement('article', { id: 'c1' });
    const authorA = createMockElement('a');
    const nameSpan = createMockElement('span', {}, 'Luyen Kieu Ba');
    const previewSpan = createMockElement('span', { className: 'slds-assistive-text' }, 'Preview');
    authorA.appendChild(nameSpan);
    authorA.appendChild(previewSpan);
    art.appendChild(authorA);
    art.appendChild(createMockElement('a', {}, '2 days ago'));
    art.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Body text here.'));
    doc.body.appendChild(art);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].author, 'Luyen Kieu Ba');
    assert.equal(result.comments[0].author.includes('Preview'), false);
  });

  // Case 08516422: real Chrome's innerText concatenates the "Preview" affordance
  // directly onto the value with ZERO whitespace ("ChangSeok LEEPreview",
  // "SS_SM8850_H8_EUPreview") — the mock elsewhere in this file always inserts a
  // space when joining child text (see createMockElement's innerText getter),
  // which is why the earlier "Preview affordance" tests above passed even though
  // stripFieldAffordances' regex required `\s+` (one-or-more whitespace) before
  // "Preview". Model the real zero-space concatenation here by putting the whole
  // string as ONE text node, the way a single <span> with no child elements does.
  await t.test('strips "Preview" affordance with zero whitespace before it (real Chrome concatenation, case 08516422)', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08516422 - zero-space Preview affordance';

    function addLookupField(label, value) {
      const formEl = createMockElement('div', { className: 'slds-form-element record-layout-item' });
      const labelEl = createMockElement('span', { className: 'slds-form-element__label test-id__field-label' }, label);
      formEl.appendChild(labelEl);
      const controlEl = createMockElement('div', { className: 'slds-form-element__control' });
      const a = createMockElement('a', {}, value + 'Preview');
      controlEl.appendChild(a);
      formEl.appendChild(controlEl);
      doc.body.appendChild(formEl);
    }

    addLookupField('Contact Name', 'ChangSeok LEE');
    addLookupField('Customer Project', 'SS_SM8850_H8_EU');

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.contactName, 'ChangSeok LEE');
    assert.equal(result.customerProject, 'SS_SM8850_H8_EU');
  });

  await t.test('strips "Preview" affordance with zero whitespace from comment author (case 08516422)', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08516422 - zero-space Preview affordance';

    const art = createMockElement('article', { id: 'c1' });
    const authorA = createMockElement('a', {}, 'ChangSeok LEEPreview');
    art.appendChild(authorA);
    art.appendChild(createMockElement('a', {}, '2 days ago'));
    art.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Body text here.'));
    doc.body.appendChild(art);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].author, 'ChangSeok LEE');
  });

  // Case 08516422: a short reply that never needed truncation renders as one
  // <span dir="ltr">Dear Customer,<br><br>...<br>Hoon</span> — plain text
  // nodes sitting directly between <br> siblings, no wrapping <p>/<div> at
  // all. domLines() used to walk `el.children` (Element-only), which skips
  // every text node here: it saw nothing but a run of <br> elements and
  // reconstructed N blank lines. cleanBody() then stripped the trailing
  // "Expand Post" marker, leaving an empty body, and the comment was silently
  // dropped by extract_case.js's `if (!body) continue` guard — the exact
  // real-world symptom this test locks down.
  await t.test('extracts a short un-truncated reply whose text sits directly between <br> siblings (case 08516422, "Hoon" reply)', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08516422 - short reply with text between <br> siblings';

    const feedBodyText = createMockElement('div', { className: 'cuf-feedBodyText forceChatterMessageSegments forceChatterFeedBodyText' });
    const feedBodyInner = createMockElement('div', { className: 'feedBodyInner Desktop' });
    const span = createMockElement('span', { className: 'uiOutputText', attrs: { dir: 'ltr' } });
    span.appendChild(createMockTextNode('Dear Customer,'));
    span.appendChild(createMockElement('br'));
    span.appendChild(createMockElement('br'));
    span.appendChild(createMockTextNode("I've checked that we plan to enable bring this feature on KI as well. "));
    span.appendChild(createMockElement('br'));
    span.appendChild(createMockTextNode('I think it would be better to check release plan/schedule with TAM directly. Or, do you still want to discuss it on this case ? '));
    span.appendChild(createMockElement('br'));
    span.appendChild(createMockElement('br'));
    span.appendChild(createMockTextNode('Thanks,'));
    span.appendChild(createMockElement('br'));
    span.appendChild(createMockTextNode('Hoon'));
    feedBodyInner.appendChild(span);
    feedBodyText.appendChild(feedBodyInner);

    // Salesforce hides "Expand Post" for posts short enough to need no
    // truncation — .cuf-more here carries the real "fadeOut hidden" classes.
    const expandLink = createMockElement('a', { className: 'cuf-more fadeOut hidden' });
    expandLink.appendChild(createMockElement('div', {}, 'Expand Post'));
    feedBodyText.appendChild(expandLink);

    const art = createMockElement('article', { id: 'hoon_post' });
    art.appendChild(createMockElement('a', {}, 'Seunghoon Lee'));
    art.appendChild(createMockElement('a', {}, 'June 15, 2026 at 8:58 PM'));
    art.appendChild(feedBodyText);
    doc.body.appendChild(art);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].author, 'Seunghoon Lee');
    assert.equal(
      result.comments[0].body,
      "Dear Customer,\n\nI've checked that we plan to enable bring this feature on KI as well. \nI think it would be better to check release plan/schedule with TAM directly. Or, do you still want to discuss it on this case ? \n\nThanks,\nHoon"
    );
  });

});

test('switch_tab.js tab switching engine', async (t) => {
  await t.test('switches to target tab when tab is found and not yet active', () => {
    if (!SWITCH_TAB_SCRIPT) return; // skip if script not yet loaded
    const doc = createMockDocument();

    const tabList = createMockElement('ul', { role: 'tablist', className: 'slds-tabs_default__nav' });
    
    const feedTab = createMockElement('a', { role: 'tab', title: 'Feed', 'aria-selected': 'true', className: 'slds-tabs_default__link' }, 'Feed');
    const feedLi = createMockElement('li', { className: 'slds-tabs_default__item slds-is-active' });
    feedLi.appendChild(feedTab);
    tabList.appendChild(feedLi);

    let detailClicked = false;
    const detailTab = createMockElement('a', { role: 'tab', title: 'Detail', 'aria-selected': 'false', className: 'slds-tabs_default__link' }, 'Detail');
    detailTab.onclick = () => { detailClicked = true; };
    const detailLi = createMockElement('li', { className: 'slds-tabs_default__item' });
    detailLi.appendChild(detailTab);
    tabList.appendChild(detailLi);

    doc.body.appendChild(tabList);

    const ctx = vm.createContext({
      document: doc,
      window: { PointerEvent: function () {}, MouseEvent: function () {} },
      __TARGET_TAB: 'Detail',
    });
    const res = vm.runInContext(SWITCH_TAB_SCRIPT, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.clicked, true);
    assert.equal(detailClicked, true);
  });

  await t.test('reports alreadyActive if the requested tab is already selected', () => {
    if (!SWITCH_TAB_SCRIPT) return;
    const doc = createMockDocument();

    const tabList = createMockElement('ul', { role: 'tablist' });
    const detailTab = createMockElement('a', { role: 'tab', title: 'Detail', 'aria-selected': 'true' }, 'Detail');
    tabList.appendChild(detailTab);
    doc.body.appendChild(tabList);

    const ctx = vm.createContext({
      document: doc,
      window: { PointerEvent: function () {}, MouseEvent: function () {} },
      __TARGET_TAB: 'Detail',
    });
    const res = vm.runInContext(SWITCH_TAB_SCRIPT, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.alreadyActive, true);
  });

  await t.test('pierces shadow DOM to find and click target tab', () => {
    if (!SWITCH_TAB_SCRIPT) return;
    const doc = createMockDocument();

    const hostElem = createMockElement('lightning-tab-bar');
    const shadow = hostElem.attachShadow();
    const tabList = createMockElement('ul', { role: 'tablist' });
    
    let clicked = false;
    const detailTab = createMockElement('button', { role: 'tab', 'aria-selected': 'false' }, 'Case Details');
    detailTab.onclick = () => { clicked = true; };
    tabList.appendChild(detailTab);
    shadow.appendChild(tabList);
    doc.body.appendChild(hostElem);

    const ctx = vm.createContext({
      document: doc,
      window: { PointerEvent: function () {}, MouseEvent: function () {} },
      __TARGET_TAB: 'Detail',
    });
    const res = vm.runInContext(SWITCH_TAB_SCRIPT, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.clicked, true);
    assert.equal(clicked, true);
  });

  await t.test('switches back to Feed tab using aliases like Chatter or Collaborate', () => {
    if (!SWITCH_TAB_SCRIPT) return;
    const doc = createMockDocument();

    const tabList = createMockElement('ul', { role: 'tablist' });
    let feedClicked = false;
    const feedTab = createMockElement('a', { role: 'tab', title: 'Chatter', 'aria-selected': 'false' }, 'Chatter');
    feedTab.onclick = () => { feedClicked = true; };
    tabList.appendChild(feedTab);
    doc.body.appendChild(tabList);

    const ctx = vm.createContext({
      document: doc,
      window: { PointerEvent: function () {}, MouseEvent: function () {} },
      __TARGET_TAB: 'Feed',
    });
    const res = vm.runInContext(SWITCH_TAB_SCRIPT, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.clicked, true);
    assert.equal(feedClicked, true);
  });

  await t.test('switches back to Feed tab labeled "Communication" (case 08637663: this org labels the tab Communication, not Feed — an unrecognized label made every switch-back silently fail, leaving the Detail tab active during extraction and under-capturing 8 of 15 comments)', () => {
    if (!SWITCH_TAB_SCRIPT) return;
    const doc = createMockDocument();

    const tabList = createMockElement('ul', { role: 'tablist' });
    let commClicked = false;
    const commTab = createMockElement('a', { role: 'tab', title: 'Communication', 'aria-selected': 'false' }, 'Communication');
    commTab.onclick = () => { commClicked = true; };
    tabList.appendChild(commTab);
    doc.body.appendChild(tabList);

    const ctx = vm.createContext({
      document: doc,
      window: { PointerEvent: function () {}, MouseEvent: function () {} },
      __TARGET_TAB: 'Feed',
    });
    const res = vm.runInContext(SWITCH_TAB_SCRIPT, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.clicked, true);
    assert.equal(commClicked, true);
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

  await t.test('does not dispatch clicks to hidden expand controls (.cuf-more.hidden or display:none)', () => {
    const doc = createMockDocument();

    // Article with hidden .cuf-more / hidden Expand Post control
    const art = createMockElement('article', { id: 'art_hidden' });
    const authorA = createMockElement('a', {}, 'Engineer');
    const expandBtn = createMockElement('a', { className: 'cuf-more hidden' }, 'Expand Post');
    const bodyEl = createMockElement('div', { className: 'feedBodyInner' }, 'Fully expanded post content.');
    art.appendChild(authorA);
    art.appendChild(expandBtn);
    art.appendChild(bodyEl);
    doc.body.appendChild(art);

    let clicked = false;
    expandBtn.onclick = () => { clicked = true; };

    const probeResult = runInMockContext(EXPAND_SCRIPT, { doc, probe: true });
    assert.equal(probeResult.pendingExpand, 0);

    const execResult = runInMockContext(EXPAND_SCRIPT, { doc, probe: false });
    assert.equal(execResult.clickedExpand, 0);
    assert.equal(clicked, false);
  });
});

test('check_collapsed.js DOM collapse detection engine', async (t) => {
  await t.test('returns stillCollapsed: 0 when all .cuf-more elements are hidden (.hidden / .fadeOut / display: none / offsetParent: null)', () => {
    if (!CHECK_COLLAPSED_SCRIPT) return;
    const doc = createMockDocument();

    // 1. Article with .hidden class on .cuf-more
    const art1 = createMockElement('article', { id: 'art1' });
    const body1 = createMockElement('div', { className: 'feedBodyInner' }, 'Expanded text 1');
    const more1 = createMockElement('a', { className: 'cuf-more hidden' }, 'Expand Post');
    art1.appendChild(body1);
    art1.appendChild(more1);
    doc.body.appendChild(art1);

    // 2. Article with display: none style
    const art2 = createMockElement('article', { id: 'art2' });
    const body2 = createMockElement('div', { className: 'feedBodyInner' }, 'Expanded text 2');
    const more2 = createMockElement('a', { className: 'cuf-more', style: { display: 'none' } }, 'Expand Post');
    art2.appendChild(body2);
    art2.appendChild(more2);
    doc.body.appendChild(art2);

    // 3. Article with offsetParent === null
    const art3 = createMockElement('article', { id: 'art3' });
    const body3 = createMockElement('div', { className: 'feedBodyInner' }, 'Expanded text 3');
    const more3 = createMockElement('a', { className: 'cuf-more', offsetParent: null }, 'Expand Post');
    art3.appendChild(body3);
    art3.appendChild(more3);
    doc.body.appendChild(art3);

    // 4. Article with .fadeOut class
    const art4 = createMockElement('article', { id: 'art4' });
    const body4 = createMockElement('div', { className: 'feedBodyInner' }, 'Expanded text 4');
    const more4 = createMockElement('a', { className: 'cuf-more fadeOut' }, 'Expand Post');
    art4.appendChild(body4);
    art4.appendChild(more4);
    doc.body.appendChild(art4);

    const result = runInMockContext(CHECK_COLLAPSED_SCRIPT, { doc });
    assert.equal(result.stillCollapsed, 0);
  });

  await t.test('returns stillCollapsed: 1 when an article contains a genuinely visible expand control', () => {
    if (!CHECK_COLLAPSED_SCRIPT) return;
    const doc = createMockDocument();

    const art = createMockElement('article', { id: 'art_visible' });
    const body = createMockElement('div', { className: 'feedBodyInner' }, 'Truncated teaser');
    const more = createMockElement('a', { className: 'cuf-more' }, 'Expand Post');
    art.appendChild(body);
    art.appendChild(more);
    doc.body.appendChild(art);

    const result = runInMockContext(CHECK_COLLAPSED_SCRIPT, { doc });
    assert.equal(result.stillCollapsed, 1);
  });
});

test('extract_case.js cleans trailing Expand Post and .cuf-more elements from comment body', async (t) => {
  await t.test('strips .cuf-more DOM element text and trailing Expand Post marker from comment bodies', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08316063 - QXDM crash on modem attach';

    const art1 = createMockElement('article', { id: 'post_1' });
    const author1 = createMockElement('a', {}, 'Test Engineer');
    const bodyContainer1 = createMockElement('div', { className: 'feedBodyInner' });
    const bodyText1 = createMockElement('span', {}, 'Device failed to register to 5G Standalone network with cause code 111.\nPlease inspect modem log.');
    const cufMore1 = createMockElement('a', { className: 'cuf-more hidden' }, 'Expand Post');
    bodyContainer1.appendChild(bodyText1);
    bodyContainer1.appendChild(cufMore1);
    art1.appendChild(author1);
    art1.appendChild(bodyContainer1);
    doc.body.appendChild(art1);

    const art2 = createMockElement('article', { id: 'post_2' });
    const author2 = createMockElement('a', {}, 'Qualcomm Support');
    const bodyContainer2 = createMockElement('div', { className: 'feedBodyInner' }, 'We are reviewing the trace.\n\nExpand Post');
    art2.appendChild(author2);
    art2.appendChild(bodyContainer2);
    doc.body.appendChild(art2);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 2);

    const c1 = result.comments[0];
    assert.equal(c1.body.includes('Expand Post'), false);
    assert.equal(c1.body, 'Device failed to register to 5G Standalone network with cause code 111.\nPlease inspect modem log.');

    const c2 = result.comments[1];
    assert.equal(c2.body.includes('Expand Post'), false);
    assert.equal(c2.body, 'We are reviewing the trace.');
  });

  // Issue #83: extraction used to read innerText off a cloneNode(true) DETACHED
  // copy of .feedBodyInner (to strip the "...more" control), and a detached
  // node has no layout so its innerText loses every <br>/block-level line
  // break. Here the .feedBodyInner element's OWN text carries the paragraph/
  // line breaks, exercising the exact node the old code cloned.
  await t.test('preserves paragraph and line breaks in a multi-paragraph comment body', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08642051 - Multi-paragraph comment body';

    const art = createMockElement('article', { id: 'post_multiline' });
    art.appendChild(createMockElement('a', {}, 'Test Engineer'));
    const bodyEl = createMockElement(
      'div',
      { className: 'feedBodyInner' },
      'Para one.\n\nPara two.\nLine three.'
    );
    art.appendChild(bodyEl);
    doc.body.appendChild(art);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].body, 'Para one.\n\nPara two.\nLine three.');
  });

  // Confirmed live on case 08420881: a pasted modem log renders as one <p> per
  // line (each holding a <span class="uiOutputText">), with a lone-&nbsp; <p>
  // as the blank-line separator — and innerText still comes back with ZERO
  // newlines, because this project cannot assume live layout on a CDP-driven
  // tab (the <p>s are display:block, yet innerText degrades exactly like the
  // issue #83 detached-node case). The mock's innerText getter can't express
  // that layout-dependent failure (it just joins children with a plain space),
  // which is why this exercises the DOM-structural path (domLines) directly
  // rather than relying on the mock's innerText/textContent to disagree.
  await t.test('reconstructs one line per <p> even when innerText reports no newlines (real Chatter log-post structure)', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08420881 - modem log structure';

    const art = createMockElement('article', { id: 'post_log' });
    art.appendChild(createMockElement('a', {}, 'Test Engineer'));
    const bodyEl = createMockElement('div', { className: 'feedBodyInner' });
    const addLine = (text) => {
      const p = createMockElement('p');
      p.appendChild(createMockElement('span', { className: 'uiOutputText' }, text));
      bodyEl.appendChild(p);
    };
    addLine('#REF: X716B_SEAU_redial_Outage_In_MOCN_Scenario_SSM_PASS');
    addLine('X'); // stand-in for the nbsp-only blank-line separator paragraph
    addLine('//Ecall start, CP reported LTE RAT');
    addLine('18:32:44.281382 |  0.000 | cmemgext.c 2637 | N | QMI->CM: AC_EMERGENCY_ENTER_REQ');
    art.appendChild(bodyEl);
    doc.body.appendChild(art);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 1);
    assert.equal(
      result.comments[0].body,
      '#REF: X716B_SEAU_redial_Outage_In_MOCN_Scenario_SSM_PASS\nX\n//Ecall start, CP reported LTE RAT\n18:32:44.281382 |  0.000 | cmemgext.c 2637 | N | QMI->CM: AC_EMERGENCY_ENTER_REQ'
    );
  });
});

test('expand_step.js deep Shadow DOM Description button expansion', async (t) => {
  await t.test('finds and clicks Description button inside <lightning-accordion-section> Shadow DOM when aria-expanded is false', () => {
    const doc = createMockDocument();
    const accordionSection = createMockElement('lightning-accordion-section');
    const shadow = accordionSection.attachShadow();

    let clicked = false;
    const btn = createMockElement('button', {
      className: 'slds-accordion__summary-action',
      'aria-expanded': 'false',
    });
    btn.onclick = () => { clicked = true; };
    const labelSpan = createMockElement('span', { className: 'slds-accordion__summary-content' }, 'Description');
    btn.appendChild(labelSpan);
    shadow.appendChild(btn);

    doc.body.appendChild(accordionSection);

    const result = runInMockContext(EXPAND_SCRIPT, { doc, anchor: null });
    assert.equal(result.clickedDescription, 1);
    assert.equal(clicked, true);
  });

  await t.test('does not click Description button inside Shadow DOM when aria-expanded is true', () => {
    const doc = createMockDocument();
    const accordionSection = createMockElement('lightning-accordion-section');
    const shadow = accordionSection.attachShadow();

    let clicked = false;
    const btn = createMockElement('button', {
      className: 'slds-accordion__summary-action',
      'aria-expanded': 'true',
    });
    btn.onclick = () => { clicked = true; };
    const labelSpan = createMockElement('span', { className: 'slds-accordion__summary-content' }, 'Description');
    btn.appendChild(labelSpan);
    shadow.appendChild(btn);

    doc.body.appendChild(accordionSection);

    const result = runInMockContext(EXPAND_SCRIPT, { doc, anchor: null });
    assert.equal(result.clickedDescription, 0);
    assert.equal(clicked, false);
  });
});

test('extract_case.js deep Shadow DOM metadata and Description extraction', async (t) => {
  await t.test('extracts Description from <lightning-accordion-section> with Shadow DOM button and content', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08316063 - QXDM crash on modem attach';

    const accordionSection = createMockElement('lightning-accordion-section');
    const shadow = accordionSection.attachShadow();
    const btn = createMockElement('button', { 'aria-expanded': 'true' });
    const btnSpan = createMockElement('span', { className: 'slds-accordion__summary-content' }, 'Description');
    btn.appendChild(btnSpan);
    shadow.appendChild(btn);

    const contentDiv = createMockElement('div', { className: 'slds-accordion__content' });
    const textEl = createMockElement('lightning-formatted-text', {}, 'The UE crashes during 5G SA registration after receiving RRCReconfiguration.');
    contentDiv.appendChild(textEl);
    accordionSection.appendChild(contentDiv);
    doc.body.appendChild(accordionSection);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });
    assert.equal(result.description, 'The UE crashes during 5G SA registration after receiving RRCReconfiguration.');
  });

  await t.test('extracts Problem Description, Customer Project, Account Name, and Detail tab fields from inside LWC Shadow DOM', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08316063 - QXDM crash on modem attach';

    // 1. Problem Description field in <records-record-layout-item>
    const itemDesc = createMockElement('records-record-layout-item');
    const shadowDesc = itemDesc.attachShadow();
    const formElDesc = createMockElement('div', { className: 'slds-form-element' });
    const labelDesc = createMockElement('span', { className: 'test-id__field-label slds-form-element__label' }, 'Problem Description');
    const controlDesc = createMockElement('div', { className: 'slds-form-element__control' });
    const valDesc = createMockElement('lightning-formatted-text', {}, 'Modem firmware assertion failure at line 452 in rrc_sm.c');
    controlDesc.appendChild(valDesc);
    formElDesc.appendChild(labelDesc);
    formElDesc.appendChild(controlDesc);
    shadowDesc.appendChild(formElDesc);
    doc.body.appendChild(itemDesc);

    // 2. Customer Project field
    const itemProj = createMockElement('records-record-layout-item');
    const shadowProj = itemProj.attachShadow();
    const formElProj = createMockElement('div', { className: 'slds-form-element' });
    const labelProj = createMockElement('span', { className: 'test-id__field-label slds-form-element__label' }, 'Customer Project');
    const controlProj = createMockElement('div', { className: 'slds-form-element__control' });
    const valProj = createMockElement('lightning-formatted-text', {}, 'Snapdragon_Auto_Gen4');
    controlProj.appendChild(valProj);
    formElProj.appendChild(labelProj);
    formElProj.appendChild(controlProj);
    shadowProj.appendChild(formElProj);
    doc.body.appendChild(itemProj);

    // 3. Account Name field
    const itemAcc = createMockElement('records-record-layout-item');
    const shadowAcc = itemAcc.attachShadow();
    const formElAcc = createMockElement('div', { className: 'slds-form-element' });
    const labelAcc = createMockElement('span', { className: 'test-id__field-label slds-form-element__label' }, 'Account Name');
    const controlAcc = createMockElement('div', { className: 'slds-form-element__control' });
    const valAcc = createMockElement('lightning-formatted-text', {}, 'Tier1 OEM Automotive Corp');
    controlAcc.appendChild(valAcc);
    formElAcc.appendChild(labelAcc);
    formElAcc.appendChild(controlAcc);
    shadowAcc.appendChild(formElAcc);
    doc.body.appendChild(itemAcc);

    // 4. Contact Name field
    const itemContact = createMockElement('records-record-layout-item');
    const shadowContact = itemContact.attachShadow();
    const formElContact = createMockElement('div', { className: 'slds-form-element' });
    const labelContact = createMockElement('span', { className: 'test-id__field-label slds-form-element__label' }, 'Contact Name');
    const controlContact = createMockElement('div', { className: 'slds-form-element__control' });
    const valContact = createMockElement('lightning-formatted-text', {}, 'Jane Doe');
    controlContact.appendChild(valContact);
    formElContact.appendChild(labelContact);
    formElContact.appendChild(controlContact);
    shadowContact.appendChild(formElContact);
    doc.body.appendChild(itemContact);

    // 5. Related CRs field
    const itemCR = createMockElement('records-record-layout-item');
    const shadowCR = itemCR.attachShadow();
    const formElCR = createMockElement('div', { className: 'slds-form-element' });
    const labelCR = createMockElement('span', { className: 'test-id__field-label slds-form-element__label' }, 'Related CRs');
    const controlCR = createMockElement('div', { className: 'slds-form-element__control' });
    const valCR = createMockElement('lightning-formatted-text', {}, 'CR-1049281');
    controlCR.appendChild(valCR);
    formElCR.appendChild(labelCR);
    formElCR.appendChild(controlCR);
    shadowCR.appendChild(formElCR);
    doc.body.appendChild(itemCR);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.description, 'Modem firmware assertion failure at line 452 in rrc_sm.c');
    assert.equal(result.customerProject, 'Snapdragon_Auto_Gen4');
    assert.equal(result.accountName, 'Tier1 OEM Automotive Corp');
    assert.equal(result.contactName, 'Jane Doe');
    assert.equal(result.relatedCRs, 'CR-1049281');
  });

  await t.test('extracts metadata through multi-level deeply nested Shadow DOM roots', () => {
    const doc = createMockDocument();
    doc.title = 'Case: 08316063 - QXDM crash on modem attach';

    const layoutItem = createMockElement('records-record-layout-item');
    const shadowLevel1 = layoutItem.attachShadow();

    const baseInput = createMockElement('records-record-layout-base-input');
    const shadowLevel2 = baseInput.attachShadow();

    const formElement = createMockElement('div', { className: 'slds-form-element' });
    const label = createMockElement('label', { className: 'slds-form-element__label' }, 'Priority');
    const control = createMockElement('div', { className: 'slds-form-element__control' });
    const formatted = createMockElement('lightning-formatted-text', {}, 'P1 - Critical');

    control.appendChild(formatted);
    formElement.appendChild(label);
    formElement.appendChild(control);

    shadowLevel2.appendChild(formElement);
    shadowLevel1.appendChild(baseInput);
    doc.body.appendChild(layoutItem);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });
    assert.equal(result.priority, 'P1 - Critical');
  });

  await t.test('DOM fixtures for live portal shapes (Issue #89)', async (st) => {
    await st.test('fixture 1: inline-edit affordance on field value (Case 08642051)', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - [SIDIA Ecall Test]';

      const formElement = createMockElement('div', { className: 'slds-form-element slds-hint-parent' });
      const label = createMockElement('span', { className: 'test-id__field-label slds-form-element__label' }, 'Status');
      const control = createMockElement('div', { className: 'slds-form-element__control slds-grid itemBody' });
      
      const valSpan = createMockElement('span', { className: 'test-id__field-value slds-form-element__static slds-grow is-read-only' });
      const outputText = createMockElement('span', { className: 'uiOutputText' }, 'Closed-Customer Requested');
      valSpan.appendChild(outputText);

      const editBtn = createMockElement('button', {
        className: 'slds-button slds-button_icon test-id__inline-edit-trigger inline-edit-trigger slds-button_icon-small',
        title: 'Edit Status',
        type: 'button',
      });
      const assistText = createMockElement('span', { className: 'slds-assistive-text' }, 'Edit Status');
      editBtn.appendChild(assistText);

      control.appendChild(valSpan);
      control.appendChild(editBtn);
      formElement.appendChild(label);
      formElement.appendChild(control);
      doc.body.appendChild(formElement);

      // Verify DOM fixture structure
      assert.ok(doc.querySelector('button.test-id__inline-edit-trigger'));
      assert.equal(doc.querySelector('.slds-assistive-text').innerText, 'Edit Status');

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      // Inline-edit affordance is stripped
      assert.equal(result.status, 'Closed-Customer Requested');
    });

    await st.test('fixture 2: help/tooltip affordance on field label (Case 08642051)', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - [SIDIA Ecall Test]';

      const formElement = createMockElement('div', { className: 'slds-form-element slds-hint-parent' });
      const labelContainer = createMockElement('div', { className: 'slds-form-element__label-container slds-grow' });
      const label = createMockElement('label', { className: 'slds-form-element__label' });
      const labelSpan = createMockElement('span', {}, 'Related CRs');
      label.appendChild(labelSpan);

      const helptext = createMockElement('lightning-helptext', { className: 'slds-m-left_xx-small' });
      const helpBtn = createMockElement('button', { className: 'slds-button slds-button_icon slds-button_icon-small' });
      const assistText = createMockElement('span', { className: 'slds-assistive-text' }, 'Help Related CRs');
      helpBtn.appendChild(assistText);
      helptext.appendChild(helpBtn);

      labelContainer.appendChild(label);
      labelContainer.appendChild(helptext);

      const control = createMockElement('div', { className: 'slds-form-element__control slds-grid itemBody' });
      const valSpan = createMockElement('span', { className: 'test-id__field-value slds-form-element__static slds-grow is-read-only' });
      // Empty value when no CR linked
      control.appendChild(valSpan);

      formElement.appendChild(labelContainer);
      formElement.appendChild(control);
      doc.body.appendChild(formElement);

      assert.ok(doc.querySelector('lightning-helptext'));
      assert.equal(helptext.querySelector('.slds-assistive-text').innerText, 'Help Related CRs');

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      // Help tooltip text is never extracted as field value
      assert.equal(result.relatedCRs, null);
    });

    await st.test('fixture 3: nested reply timestamp without title vs top-level post with title (Case 08642051)', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - [SIDIA Ecall Test]';

      // Top-level post
      const topArticle = createMockElement('article', { className: 'cuf-feedItem slds-card', id: 'post_01' });
      const topAuthor = createMockElement('a', { className: 'cuf-actorName' }, 'Duc Hoang');
      const topTsSpan = createMockElement('span', { className: 'cuf-timestamp uiOutputDateTime', title: 'August 10, 2026 at 7:59 PM' });
      const topTsLink = createMockElement('a', { className: 'cuf-timestamp' }, 'August 10, 2026 at 7:59 PM');
      topTsSpan.appendChild(topTsLink);
      const topBody = createMockElement('div', { className: 'feedBodyInner' }, 'Top-level post content');
      topArticle.appendChild(topAuthor);
      topArticle.appendChild(topTsSpan);
      topArticle.appendChild(topBody);

      // Nested replies container
      const repliesUl = createMockElement('ul', { className: 'cuf-replies slds-p-horizontal_small' });
      const replyLi = createMockElement('li', { className: 'cuf-reply' });
      const replyArticle = createMockElement('article', { className: 'cuf-comment cuf-feedItem', id: 'reply_01' });
      const replyAuthor = createMockElement('a', { className: 'cuf-actorName' }, 'Duc Hoang');
      // Notice: Nested reply timestamp has NO title attribute and contains relative text
      const replyTsSpan = createMockElement('span', { className: 'cuf-timestamp uiOutputDateTime' });
      const replyTsLink = createMockElement('a', { className: 'cuf-timestamp', href: 'javascript:void(0);' }, '12 days ago');
      replyTsSpan.appendChild(replyTsLink);
      const replyBody = createMockElement('div', { className: 'feedBodyInner' }, '# FAILlog_X716B.zip build version notes');
      replyArticle.appendChild(replyAuthor);
      replyArticle.appendChild(replyTsSpan);
      replyArticle.appendChild(replyBody);
      replyLi.appendChild(replyArticle);
      repliesUl.appendChild(replyLi);
      topArticle.appendChild(repliesUl);

      doc.body.appendChild(topArticle);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.comments.length, 2);
      assert.equal(result.comments[0].timestamp, 'August 10, 2026 at 7:59 PM');
      assert.equal(result.comments[0].isReply, false);
      assert.equal(result.comments[1].timestamp, '12 days ago');
      assert.equal(result.comments[1].isReply, true);
    });

    await st.test('fixture 4: comment attachment card with download URL and display name (Case 08642051)', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - [SIDIA Ecall Test]';

      const article = createMockElement('article', { className: 'cuf-feedItem', id: 'post_attach' });
      const author = createMockElement('a', { className: 'cuf-actorName' }, 'Duc Hoang');
      const ts = createMockElement('a', {}, 'August 10, 2026 at 7:59 PM');
      const body = createMockElement('div', { className: 'feedBodyInner' }, 'Log files attached for analysis.');
      article.appendChild(author);
      article.appendChild(ts);
      article.appendChild(body);

      const attachContainer = createMockElement('div', { className: 'cuf-feedItemAttachments slds-post__content' });
      const fileCard = createMockElement('div', { className: 'cuf-attachment slds-file slds-file_card slds-has-title' });
      
      const figure = createMockElement('figure');
      const downloadLink = createMockElement('a', {
        className: 'slds-file__crop cuf-attachmentThumbnail cuf-attachment',
        href: 'https://support.qualcomm.com/s/sfc/servlet.shepherd/version/download/068dK0000012345?asPdf=false&operationContext=CHATTER',
        title: 'FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip',
        download: 'FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip',
      });
      const assist = createMockElement('span', { className: 'slds-assistive-text' }, 'FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip');
      downloadLink.appendChild(assist);
      figure.appendChild(downloadLink);

      const fileTitleDiv = createMockElement('div', { className: 'slds-file__title' });
      const docPreviewLink = createMockElement('a', {
        className: 'slds-file__text cuf-attachment',
        href: 'https://support.qualcomm.com/s/contentdocument/069dK0000012345',
        title: 'FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip',
      });
      const titleSpan = createMockElement('span', { className: 'slds-file__text-title slds-truncate' }, 'FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip');
      docPreviewLink.appendChild(titleSpan);
      fileTitleDiv.appendChild(docPreviewLink);

      fileCard.appendChild(figure);
      fileCard.appendChild(fileTitleDiv);
      attachContainer.appendChild(fileCard);
      article.appendChild(attachContainer);
      doc.body.appendChild(article);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.comments.length, 1);
      assert.ok(result.comments[0].attachments.length >= 1);
      const att = result.comments[0].attachments[0];
      assert.equal(att.name, 'FAILlog_X716B_SEAU_5G_IMS_Ecall_VoNR_redial_TC1_RTD.zip');
      assert.ok(att.url.includes('068dK0000012345'));
    });

    await st.test('fixture 5: top-level post vs nested reply distinguishability in DOM hierarchy', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - [SIDIA Ecall Test]';

      const topArticle = createMockElement('article', { className: 'cuf-feedItem slds-card', id: 'top_post' });
      const topBody = createMockElement('div', { className: 'feedBodyInner' }, 'Top post body');
      topArticle.appendChild(topBody);

      const repliesUl = createMockElement('ul', { className: 'cuf-replies' });
      const replyLi = createMockElement('li', { className: 'cuf-reply' });
      const replyArticle = createMockElement('article', { className: 'cuf-comment cuf-feedItem', id: 'nested_reply' });
      const replyBody = createMockElement('div', { className: 'feedBodyInner' }, 'Nested reply body');
      replyArticle.appendChild(replyBody);
      replyLi.appendChild(replyArticle);
      repliesUl.appendChild(replyLi);
      topArticle.appendChild(repliesUl);

      doc.body.appendChild(topArticle);

      const articles = doc.querySelectorAll('article');
      assert.equal(articles.length, 2);

      const topPosts = articles.filter(a => !a.classList.contains('cuf-comment') && !a.closest('ul.cuf-replies'));
      const nestedReplies = articles.filter(a => a.classList.contains('cuf-comment') || !!a.closest('ul.cuf-replies'));

      assert.equal(topPosts.length, 1);
      assert.equal(topPosts[0].id, 'top_post');
      assert.equal(nestedReplies.length, 1);
      assert.equal(nestedReplies[0].id, 'nested_reply');
    });
  });

  await t.test('stripFieldAffordances and keyword preservation rules (Issue #90)', async (st) => {
    await st.test('preserves legitimate values ending in stripped keywords (e.g. Status, Preview, Priority)', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08603854 - Test Legitimate Keywords';

      function addField(label, value) {
        const formEl = createMockElement('div', { className: 'slds-form-element record-layout-item' });
        const labelEl = createMockElement('span', { className: 'slds-form-element__label test-id__field-label' }, label);
        formEl.appendChild(labelEl);
        const controlEl = createMockElement('div', { className: 'slds-form-element__control' });
        const valSpan = createMockElement('span', { className: 'test-id__field-value' }, value);
        controlEl.appendChild(valSpan);
        formEl.appendChild(controlEl);
        doc.body.appendChild(formEl);
      }

      addField('Status', 'Initial Status');
      addField('Priority', 'High Priority');
      addField('Product', 'Snapdragon X75 5G');
      addField('Subject', 'Query on Modem Status');

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.status, 'Initial Status');
      assert.equal(result.priority, 'High Priority');
      assert.equal(result.product, 'Snapdragon X75 5G');
      assert.equal(result.title, 'Query on Modem Status');
    });

    await st.test('preserves legitimate values starting with Help (e.g. Help needed, Helpdesk inquiry)', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08603854 - Help Request';

      function addField(label, value) {
        const formEl = createMockElement('div', { className: 'slds-form-element record-layout-item' });
        const labelEl = createMockElement('span', { className: 'slds-form-element__label test-id__field-label' }, label);
        formEl.appendChild(labelEl);
        const controlEl = createMockElement('div', { className: 'slds-form-element__control' });
        const valSpan = createMockElement('span', { className: 'test-id__field-value' }, value);
        controlEl.appendChild(valSpan);
        formEl.appendChild(controlEl);
        doc.body.appendChild(formEl);
      }

      addField('Subject', 'Help needed with VoNR registration on band n78');
      addField('Description', 'Help desk inquiry regarding modem crash on attach');

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.title, 'Help needed with VoNR registration on band n78');
      assert.equal(result.description, 'Help desk inquiry regarding modem crash on attach');
    });

    await st.test('extracts non-empty field value cleanly even when label container has helptext', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08603854 - Field with Helptext and Value';

      const formElement = createMockElement('div', { className: 'slds-form-element slds-hint-parent' });
      const labelContainer = createMockElement('div', { className: 'slds-form-element__label-container slds-grow' });
      const label = createMockElement('label', { className: 'slds-form-element__label' });
      const labelSpan = createMockElement('span', {}, 'Related CRs');
      label.appendChild(labelSpan);

      const helptext = createMockElement('lightning-helptext', { className: 'slds-m-left_xx-small' });
      const helpBtn = createMockElement('button', { className: 'slds-button slds-button_icon slds-button_icon-small' });
      const assistText = createMockElement('span', { className: 'slds-assistive-text' }, 'Help Related CRs');
      helpBtn.appendChild(assistText);
      helptext.appendChild(helpBtn);

      labelContainer.appendChild(label);
      labelContainer.appendChild(helptext);

      const control = createMockElement('div', { className: 'slds-form-element__control slds-grid itemBody' });
      const valSpan = createMockElement('span', { className: 'test-id__field-value slds-form-element__static slds-grow is-read-only' });
      const outputText = createMockElement('span', { className: 'uiOutputText' }, 'CR3891002, CR3891003');
      valSpan.appendChild(outputText);
      control.appendChild(valSpan);

      formElement.appendChild(labelContainer);
      formElement.appendChild(control);
      doc.body.appendChild(formElement);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.relatedCRs, 'CR3891002, CR3891003');
    });
  });

  await t.test('nested reply timestamp and ordering (Issue #91)', async (st) => {
    await st.test('extracts absolute timestamp from nested reply title/datetime attribute when present', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - Nested reply absolute timestamp';

      const topArticle = createMockElement('article', { className: 'cuf-feedItem', id: 'post_1' });
      topArticle.appendChild(createMockElement('a', { className: 'cuf-actorName' }, 'Customer'));
      topArticle.appendChild(createMockElement('time', { datetime: '2026-08-10T10:00:00.000Z' }, 'August 10, 2026 at 10:00 AM'));
      topArticle.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Top post'));

      const repliesUl = createMockElement('ul', { className: 'cuf-replies' });
      const replyLi = createMockElement('li', { className: 'cuf-reply' });
      const replyArticle = createMockElement('article', { className: 'cuf-comment', id: 'reply_1' });
      replyArticle.appendChild(createMockElement('a', { className: 'cuf-actorName' }, 'Qualcomm Support'));
      const replyTs = createMockElement('a', { className: 'cuf-timestamp', title: 'August 10, 2026 at 11:30 AM' }, '12 days ago');
      replyArticle.appendChild(replyTs);
      replyArticle.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Nested response'));
      replyLi.appendChild(replyArticle);
      repliesUl.appendChild(replyLi);
      topArticle.appendChild(repliesUl);
      doc.body.appendChild(topArticle);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.comments.length, 2);
      assert.equal(result.comments[0].timestamp, '2026-08-10T10:00:00.000Z');
      assert.equal(result.comments[0].isReply, false);
      assert.equal(result.comments[1].timestamp, 'August 10, 2026 at 11:30 AM');
      assert.equal(result.comments[1].isReply, true);
    });
  });

  await t.test('extract comment attachments (Issue #92)', async (st) => {
    await st.test('extracts single attachment with display name and fully-qualified portal URL', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - Attachment Test';

      const art = createMockElement('article', { className: 'cuf-feedItem', id: 'post_1' });
      art.appendChild(createMockElement('a', { className: 'cuf-actorName' }, 'Duc Hoang'));
      art.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Please check attached log.'));

      const container = createMockElement('div', { className: 'cuf-feedItemAttachments' });
      const fileCard = createMockElement('div', { className: 'slds-file slds-file_card' });
      const dlLink = createMockElement('a', {
        href: '/s/sfc/servlet.shepherd/version/download/068dK0000012345?asPdf=false&operationContext=CHATTER',
        download: 'qxdm_n78_drop.zip',
        title: 'qxdm_n78_drop.zip',
      });
      fileCard.appendChild(dlLink);
      container.appendChild(fileCard);
      art.appendChild(container);
      doc.body.appendChild(art);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.comments.length, 1);
      assert.equal(result.comments[0].attachments.length, 1);
      assert.equal(result.comments[0].attachments[0].name, 'qxdm_n78_drop.zip');
      assert.equal(result.comments[0].attachments[0].url, 'https://support.qualcomm.com/s/sfc/servlet.shepherd/version/download/068dK0000012345?asPdf=false&operationContext=CHATTER');
    });

    await st.test('deduplicates multiple links inside the same attachment card', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - Multi-link File Card';

      const art = createMockElement('article', { className: 'cuf-feedItem', id: 'post_1' });
      art.appendChild(createMockElement('a', { className: 'cuf-actorName' }, 'Duc Hoang'));
      art.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Files attached.'));

      const container = createMockElement('div', { className: 'cuf-feedItemAttachments' });
      const fileCard = createMockElement('div', { className: 'slds-file slds-file_card' });
      
      // Thumbnail download link
      const thumb = createMockElement('a', {
        className: 'slds-file__crop cuf-attachmentThumbnail',
        href: 'https://support.qualcomm.com/s/sfc/servlet.shepherd/version/download/068dK0000099999',
        download: 'modem_diag.pcap',
      });
      // Text preview link
      const textLink = createMockElement('a', {
        className: 'slds-file__text cuf-attachment',
        href: 'https://support.qualcomm.com/s/contentdocument/069dK0000099999',
        title: 'modem_diag.pcap',
      });
      const titleSpan = createMockElement('span', { className: 'slds-file__text-title' }, 'modem_diag.pcap');
      textLink.appendChild(titleSpan);

      fileCard.appendChild(thumb);
      fileCard.appendChild(textLink);
      container.appendChild(fileCard);
      art.appendChild(container);
      doc.body.appendChild(art);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.comments.length, 1);
      // Yields exactly one entry per file despite multiple inner links
      assert.equal(result.comments[0].attachments.length, 1);
      assert.equal(result.comments[0].attachments[0].name, 'modem_diag.pcap');
      assert.equal(result.comments[0].attachments[0].url, 'https://support.qualcomm.com/s/sfc/servlet.shepherd/version/download/068dK0000099999');
    });

    await st.test('extracts multiple distinct attachments on the same comment', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - Multiple Attachments';

      const art = createMockElement('article', { className: 'cuf-feedItem', id: 'post_multi' });
      art.appendChild(createMockElement('a', { className: 'cuf-actorName' }, 'Duc Hoang'));
      art.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Two files attached.'));

      const container = createMockElement('div', { className: 'cuf-feedItemAttachments' });
      
      const fileCard1 = createMockElement('div', { className: 'slds-file slds-file_card' });
      fileCard1.appendChild(createMockElement('a', {
        href: 'https://support.qualcomm.com/sfc/servlet.shepherd/version/download/068001',
        title: 'log1.zip',
      }));

      const fileCard2 = createMockElement('div', { className: 'slds-file slds-file_card' });
      fileCard2.appendChild(createMockElement('a', {
        href: 'https://support.qualcomm.com/sfc/servlet.shepherd/version/download/068002',
        title: 'log2.zip',
      }));

      container.appendChild(fileCard1);
      container.appendChild(fileCard2);
      art.appendChild(container);
      doc.body.appendChild(art);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.comments.length, 1);
      assert.equal(result.comments[0].attachments.length, 2);
      assert.equal(result.comments[0].attachments[0].name, 'log1.zip');
      assert.equal(result.comments[0].attachments[1].name, 'log2.zip');
    });

    await st.test('yields an empty attachment list when comment has no attachments and does not pick up author/profile links', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051 - No Attachments';

      const art = createMockElement('article', { className: 'cuf-feedItem', id: 'post_no_att' });
      art.appendChild(createMockElement('a', { className: 'cuf-actorName', href: '/s/profile/005dK000000ABCD' }, 'Alice Developer'));
      art.appendChild(createMockElement('a', { href: '#reply', className: 'cuf-reply-btn' }, 'Reply'));
      art.appendChild(createMockElement('div', { className: 'feedBodyInner' }, 'Simple comment without any attachments.'));
      doc.body.appendChild(art);

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.comments.length, 1);
      assert.equal(result.comments[0].attachments.length, 0);
    });
  });

  await t.test('Detail metadata field extraction with alias tolerance (Issue #111)', async (st) => {
    await st.test('extracts severity, product, updated, and other standard fields when present', () => {
      const doc = createMockDocument();
      doc.title = 'Case: 08642051';

      function addField(label, value) {
        const formEl = createMockElement('div', { className: 'slds-form-element' });
        const labelEl = createMockElement('span', { className: 'slds-form-element__label' }, label);
        const controlEl = createMockElement('div', { className: 'slds-form-element__control' });
        const valEl = createMockElement('span', { className: 'test-id__field-value' }, value);
        controlEl.appendChild(valEl);
        formEl.appendChild(labelEl);
        formEl.appendChild(controlEl);
        doc.body.appendChild(formEl);
      }

      addField('Case Severity', 'S1 - Critical Outage');
      addField('Product Name', 'Snapdragon 8 Gen 4 (SM8750)');
      addField('Last Modified Date', 'August 24, 2026 at 10:00 PM');
      addField('Case Contact', 'Nguyen Van A');
      addField('Customer Project', 'Project Venus');
      addField('Account Name', 'OEM Tech Corp');

      const result = runInMockContext(EXTRACT_SCRIPT, { doc });
      assert.equal(result.severity, 'S1 - Critical Outage');
      assert.equal(result.product, 'Snapdragon 8 Gen 4 (SM8750)');
      assert.equal(result.updated, 'August 24, 2026 at 10:00 PM');
      assert.equal(result.contactName, 'Nguyen Van A');
      assert.equal(result.customerProject, 'Project Venus');
      assert.equal(result.accountName, 'OEM Tech Corp');
    });
  });
});
