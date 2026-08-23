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
function createMockElement(tag, attrs = {}, text = '') {
  const children = [];
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
      const cloned = createMockElement(this.tagName.toLowerCase(), { ...this.attributes, className: this.className, id: this.id, style: { ...this.style } }, text);
      if (!deep) return cloned;
      for (const child of children) {
        cloned.appendChild(child.cloneNode(true));
      }
      return cloned;
    },
    remove() {
      if (this.parent) {
        const idx = this.parent.children.indexOf(this);
        if (idx >= 0) this.parent.children.splice(idx, 1);
        this.parent = null;
        this.parentElement = null;
      }
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      child.parent = null;
      child.parentElement = null;
      return child;
    },
    get innerText() {
      if (text) return text;
      return children.map(c => c.innerText || c.textContent || '').join(' ').trim();
    },
    set innerText(v) { text = v; },
    get textContent() {
      if (text) return text;
      return children.map(c => c.textContent || c.innerText || '').join(' ').trim();
    },
    set textContent(v) { text = v; },
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
      children.push(child);
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
    assert.equal(result.customer, 'VinFast Auto');
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
      ['attachments', 'author', 'body', 'displayPosition', 'id', 'summary', 'timestamp'].sort()
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
    assert.equal(result.title, '');
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

  await t.test('extracts clean deterministic summary preview by stripping salutations and taking first 1-2 sentences', () => {
    const doc = createMockDocument();

    // 1. Comment with greeting "Dear customer,"
    const art1 = createMockElement('article', { id: 'sum_1' });
    const a1 = createMockElement('a', {}, 'Ken Lee');
    const body1 = createMockElement('div', { className: 'feedBodyInner' }, 'Dear customer,\n\nThank you for opening the case.\nWe will check and update.');
    art1.appendChild(a1);
    art1.appendChild(body1);
    doc.body.appendChild(art1);

    // 2. Comment with greeting "Dear QC team,"
    const art2 = createMockElement('article', { id: 'sum_2' });
    const a2 = createMockElement('a', {}, 'Customer Engineer');
    const body2 = createMockElement('div', { className: 'feedBodyInner' }, 'Dear QC team,\nDevice cannot attach to 5G SA network. Please analyze attached QXDM trace.');
    art2.appendChild(a2);
    art2.appendChild(body2);
    doc.body.appendChild(art2);

    // 3. Short single sentence
    const art3 = createMockElement('article', { id: 'sum_3' });
    const a3 = createMockElement('a', {}, 'Alex Turner');
    const body3 = createMockElement('div', { className: 'feedBodyInner' }, 'Root cause identified as RRC reject on n78.');
    art3.appendChild(a3);
    art3.appendChild(body3);
    doc.body.appendChild(art3);

    const result = runInMockContext(EXTRACT_SCRIPT, { doc });

    assert.equal(result.comments.length, 3);
    assert.equal(result.comments[0].summary, 'Thank you for opening the case. We will check and update.');
    assert.equal(result.comments[1].summary, 'Device cannot attach to 5G SA network. Please analyze attached QXDM trace.');
    assert.equal(result.comments[2].summary, 'Root cause identified as RRC reject on n78.');
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
    assert.equal(result.raisedBy, 'Mai Ngoc');
    assert.equal(result.openedAt, '08/10/2026, 09:30 AM');
    assert.equal(result.closedAt, '08/20/2026, 04:15 PM');
    assert.equal(result.customerProject, 'VinFast VF9 MY26');
    assert.equal(result.accountName, 'VinFast Auto LLC');
    assert.equal(result.customer, 'VinFast Auto LLC');
    assert.equal(result.relatedCRs, 'CR3798678, CR3801234');
    assert.equal(result.caseRecordType, 'Customer Support');
    assert.equal(result.description, 'VoNR call drops during 5G SA to EPS Fallback transition.');
    assert.equal(result.status, 'Closed');
    assert.equal(result.priority, '1 - Critical');
    assert.equal(result.title, 'VoNR Handover Failure');
    assert.equal(result.product, 'SDX75');
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

test('extract_case.js cleans trailing Expand Post and .cuf-more elements from comment body and summary', async (t) => {
  await t.test('strips .cuf-more DOM element text and trailing Expand Post marker from comments and summaries', () => {
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
    assert.equal(c1.summary.includes('Expand Post'), false);
    assert.equal(c1.body, 'Device failed to register to 5G Standalone network with cause code 111.\nPlease inspect modem log.');
    assert.equal(c1.summary, 'Device failed to register to 5G Standalone network with cause code 111. Please inspect modem log.');

    const c2 = result.comments[1];
    assert.equal(c2.body.includes('Expand Post'), false);
    assert.equal(c2.summary.includes('Expand Post'), false);
    assert.equal(c2.body, 'We are reviewing the trace.');
    assert.equal(c2.summary, 'We are reviewing the trace.');
  });
});

