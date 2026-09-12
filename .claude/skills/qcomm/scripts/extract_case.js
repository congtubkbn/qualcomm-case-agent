// scripts/extract_case.js
//
// Default case extractor for PHASE 2. Run it against the ALREADY-EXPANDED case
// page (PHASE 1.5 done) via base64 (NOT --stdin, NOT `<` redirection — PowerShell
// has no `<` stdin-redirect, and `Get-Content -Raw | agent-browser eval --stdin`
// silently returns "null" instead of the evaluated result on Windows):
//
//     $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('.claude/skills/qcomm/scripts/extract_case.js'))
//     $r = agent-browser eval -b $b64
//     [IO.File]::WriteAllText('data/cases/<CODE>/case.raw.json', $r, (New-Object Text.UTF8Encoding $false))
//
// Two things make this robust where ad-hoc extractors trip up:
//   1. It is one IIFE whose final expression IS the result object. agent-browser
//      eval runs in EXPRESSION context (like a REPL) — a bare top-level `return`
//      throws "Illegal return statement", so the logic lives inside a function
//      that the IIFE call evaluates to.
//   2. It returns the OBJECT, not JSON.stringify(object). agent-browser serializes
//      the result for you; returning a pre-stringified string double-encodes it
//      (you get "{\"a\":1}" written to disk, which finalize_case.mjs then rejects).
//
// This is a sensible DEFAULT keyed on the confirmed Salesforce Lightning structure
// (see references/extraction.md lock-in table). If the live DOM differs and fields
// come back empty, edit this file to match what `agent-browser snapshot -c` shows —
// the skill is agent-driven, this script is a starting point, not a fixed contract.

(function () {
  const txt = el => (el && (el.innerText || el.textContent || "")).trim();
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // `innerText` derives line breaks from computed layout (block-level display),
  // which this project cannot rely on: a CDP-driven tab does not always keep
  // live layout for every node, so a genuinely block-level <p> (one per pasted
  // log line — confirmed live on case 08420881, 45 <p> children, each
  // display:block) can still read back with ZERO newlines in innerText. Walk
  // the DOM structure directly instead — one line per block-level child
  // (<p>/<div>/<li>/...), one blank line per <br> — which needs no layout at
  // all and reproduces the same paragraph breaks a human sees on the real page.
  const LINE_BREAK_TAGS = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR"]);
  const domLines = el => {
    if (!el) return "";
    const kids = Array.from(el.childNodes || []);
    if (kids.length === 0) {
      return (el.textContent || "").replace(/ /g, " ");
    }
    const lines = [];
    let current = "";
    for (const child of kids) {
      if (child.nodeType === 3) {
        current += (child.textContent || "").replace(/ /g, " ");
        continue;
      }
      if (child.nodeType != null && child.nodeType !== 1) continue;
      if (child.tagName === "BR") {
        lines.push(current);
        current = "";
      } else if (LINE_BREAK_TAGS.has(child.tagName)) {
        if (current) { lines.push(current); current = ""; }
        lines.push(domLines(child));
      } else {
        current += domLines(child);
      }
    }
    if (current) lines.push(current);
    return lines.join("\n");
  };

  // Chatter renders its paragraph-separator marker differently in the collapsed
  // teaser vs the expanded ".feedBodyInner" body, and BOTH forms come through as
  // mojibake (a real non-breaking-space character double-encoded, not user text).
  // Confirmed patterns (2026-07): "Â " in the teaser, "â”¬Ã¡" once "Expand Post"
  // is clicked — same underlying separator, two renderings. Stripped narrowly by
  // exact string match only (NOT a general Latin-1 reinterpretation pass, which
  // would also mangle legitimate accented text e.g. Vietnamese names/comments).
  // Trailing "Expand Post" button text or markers are also stripped.
  const cleanBody = s => {
    if (!s) return "";
    return s
      .replace(/â”¬Ã¡/g, "")
      .replace(/Â(?=[\s\n]|$)/g, "")
      .replace(/\s*Expand Post\s*$/i, "")
      .trim();
  };

  // Strips Salesforce Lightning UI affordances from extracted field values:
  // 1. Hover-preview affordance: "Preview" inside Lookup fields and author links.
  // 2. Inline-edit affordance: "Edit Status", "Edit Priority", etc. inside form element values.
  // 3. Help tooltip affordance: "Help Related CRs" inside lightning-helptext when field is empty.
  // Anchored and scoped so legitimate values ending in "Status" or starting with "Help" are preserved.
  const stripFieldAffordances = (s, label = '') => {
    if (!s || typeof s !== 'string') return s;
    let val = s.trim();
    // 1. Trailing "Preview" affordance (Salesforce lookup preview trigger).
    // Case 08516422: real Chrome's innerText concatenates this with ZERO
    // whitespace ("ChangSeok LEEPreview") — \s* (not \s+) so it still strips.
    val = val.replace(/\s*Preview\s*$/, '').trim();
    // 2. Trailing inline-edit affordance: e.g. "\nEdit Status", " Edit Priority", "Edit Case Status"
    val = val.replace(/(?:\r?\n|\s+)Edit\s+[A-Za-z0-9_\-\s]+$/i, '').trim();
    // 3. Help tooltip text (e.g. "Help Related CRs", "Help Case Record Type")
    if (/^Help\s+/i.test(val)) {
      const target = val.replace(/^Help\s+/i, '').trim().toLowerCase();
      const lbl = (label || '').trim().toLowerCase();
      if (lbl && (target === lbl || target.includes(lbl) || lbl.includes(target))) {
        return '';
      }
      if (target === 'related crs' || target === 'related cr' || target === 'status' || target === 'priority' || target === 'case record type') {
        return '';
      }
    }
    return val;
  };
  const stripPreviewAffordance = s => stripFieldAffordances(s);

  const deepQsa = (sel, root) => {
    const results = [];
    const seen = new Set();
    const add = el => {
      if (el && !seen.has(el)) {
        seen.add(el);
        results.push(el);
      }
    };
    const scan = node => {
      if (!node) return;
      if (node.querySelectorAll) {
        try {
          const matched = node.querySelectorAll(sel);
          for (let i = 0; i < matched.length; i++) {
            add(matched[i]);
          }
        } catch (e) {}
        try {
          const all = node.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) {
            if (all[i] && all[i].shadowRoot) {
              scan(all[i].shadowRoot);
            }
          }
        } catch (e) {}
      }
      if (node.shadowRoot) {
        scan(node.shadowRoot);
      }
    };
    scan(root || document);
    return results;
  };

  // Case number: document.title is reliably "Case: <CODE>" on the case page.
  // Require the colon form + a leading digit so the Cases LIST view (title
  // "Cases") can't false-match and yield a junk id like "s". Fall back to a
  // "Case <CODE>" heading, then the URL slug.
  const titleMatch = (document.title || "").match(/Case:\s*(\d[\w-]*)/i);
  const caseHeading = qsa("h1, [role='heading']").find(h => /^Case\s+\d/i.test(txt(h)));
  const caseNumber = (titleMatch && titleMatch[1])
    || (caseHeading ? txt(caseHeading).replace(/^Case\s+/i, "").trim() : "")
    || location.pathname.split("/").filter(Boolean).pop();

  // Optional section helper for collapsible "Subject"/"Description" panels and
  // Salesforce Lightning record layout items.
  const sectionValue = labelOrLabels => {
    const labelsList = Array.isArray(labelOrLabels) ? labelOrLabels : [labelOrLabels];
    const lowerLabels = labelsList.map(l => (l || "").toLowerCase().trim()).filter(Boolean);
    if (!lowerLabels.length) return null;

    const findContainer = el => {
      let cur = el;
      while (cur) {
        if (cur.matches && cur.matches(".slds-form-element, [class*='record-layout-item'], lightning-record-layout-item, records-record-layout-item, dl, .slds-grid, records-record-layout-row, records-record-layout-block, lightning-accordion-section, [class*='accordion']")) {
          return cur;
        }
        if (cur.parentElement) {
          cur = cur.parentElement;
        } else if (cur.parent) {
          cur = cur.parent;
        } else if (cur.getRootNode && cur.getRootNode().host) {
          cur = cur.getRootNode().host;
        } else {
          break;
        }
      }
      return el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    };

    // 1. Button with label (e.g. collapsible section button in header or accordion)
    const btns = deepQsa("button");
    const btn = btns.find(b => {
      const bt = txt(b).toLowerCase();
      return lowerLabels.includes(bt) || lowerLabels.some(l => bt === l || bt.startsWith(l + ":"));
    });
    if (btn) {
      const host = findContainer(btn);
      if (host) {
        const valEls = deepQsa(".slds-accordion__content, [class*='accordion__content'], lightning-formatted-text, lightning-formatted-name, p, span:not([class*='label'])", host);
        const valEl = valEls.find(el => el !== btn && !btn.contains(el) && !lowerLabels.includes(txt(el).toLowerCase()) && txt(el).length > 0);
        if (valEl) {
          const val = stripPreviewAffordance(txt(valEl));
          if (val) return val;
        }
      }
    }

    // 2. Standard Salesforce Lightning label selectors
    const labels = deepQsa(".slds-form-element__label, label, [class*='label'], dt, .test-id__field-label, [data-label]");
    const matchedLabel = labels.find(l => {
      const t = txt(l).toLowerCase();
      return lowerLabels.includes(t) || lowerLabels.some(lbl => t === lbl || t.startsWith(lbl + ":") || t.startsWith(lbl + " *") || t === lbl + "*");
    });

    if (matchedLabel) {
      const parent = findContainer(matchedLabel);
      if (parent) {
        // First check for dedicated field value element
        const dedicatedVal = deepQsa(".test-id__field-value, lightning-formatted-text, lightning-formatted-name, lightning-formatted-date-time, lightning-formatted-lookup", parent);
        const bestEl = dedicatedVal.find(el => el !== matchedLabel && !matchedLabel.contains(el) && !el.closest?.('lightning-helptext, button, .slds-assistive-text'));
        if (bestEl) {
          const val = stripFieldAffordances(txt(bestEl), lowerLabels[0]);
          if (val) return val;
        }

        const isAffordanceEl = el => {
          if (!el) return true;
          if (el.closest && el.closest('lightning-helptext, .slds-form-element__label-container, button.test-id__inline-edit-trigger, button.slds-button_icon')) return true;
          if (el.classList && (el.classList.contains('slds-assistive-text') || el.classList.contains('test-id__inline-edit-trigger'))) return true;
          return false;
        };

        const valEls = deepQsa(".slds-form-element__control, dd, p, a, span:not([class*='label'])", parent);
        const valEl = valEls.find(el => el !== matchedLabel && !matchedLabel.contains(el) && !isAffordanceEl(el) && !lowerLabels.includes(txt(el).toLowerCase()) && txt(el).length > 0);
        if (valEl) {
          const val = stripFieldAffordances(txt(valEl), lowerLabels[0]);
          if (val) return val;
        }
      }
    }

    // 3. Direct data attributes
    for (const lbl of lowerLabels) {
      const els = deepQsa(`[data-field="${lbl}"], [data-field-name="${lbl}"], [data-name="${lbl}"], [data-target-selection-name*="${lbl}"]`);
      if (els && els.length > 0) {
        const val = stripFieldAffordances(txt(els[0]), lbl);
        if (val) return val;
      }
    }

    return null;
  };

  const isBlacklistedTs = s => {
    if (!s) return true;
    const lower = s.toLowerCase();
    return (
      lower.includes("click for single-item view") ||
      lower.includes("expand post") ||
      lower.includes("chatter feed item") ||
      lower.includes("view more comments") ||
      lower.includes("more comments")
    );
  };

  // Timestamp extraction helper
  const extractTimestamp = (a, named, author) => {
    const datePattern = /(?:ago|yesterday|today|\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b)/i;
    const tsEl = a.querySelector("a.cuf-timestamp, span.cuf-timestamp, time, .uiOutputDateTime, [class*='timestamp'], [class*='Timestamp'], [class*='dateTime'], [class*='DateTime'], [class*='createdDate'], [class*='created-date']");
    if (tsEl) {
      const val = tsEl.getAttribute("title") || tsEl.getAttribute("datetime") || tsEl.getAttribute("data-timestamp") || tsEl.getAttribute("data-created-date") || txt(tsEl) || "";
      if (val && !isBlacklistedTs(val)) return val;
    }
    // Scan named links for date/time patterns
    const match = named.find(t => !isBlacklistedTs(t) && t !== author && datePattern.test(t));
    if (match) return match;

    // Scan all spans/elements for relative or date patterns
    const inlineCandidates = qsa("span, div, p, time, a", a);
    for (const el of inlineCandidates) {
      if (el.closest && (el.closest('.feedBodyInner') || el.closest('.cuf-feedItemAttachments'))) continue;
      const titleAttr = el.getAttribute("title") || el.getAttribute("datetime") || el.getAttribute("data-timestamp");
      if (titleAttr && !isBlacklistedTs(titleAttr) && datePattern.test(titleAttr)) {
        return titleAttr;
      }
      const t = txt(el);
      if (t && t !== author && !isBlacklistedTs(t) && t.length < 60 && datePattern.test(t)) {
        return t;
      }
    }

    // Fallback: subsequent named links if valid and not blacklisted
    for (let idx = 1; idx < named.length; idx++) {
      const n = named[idx];
      if (n && n !== author && !isBlacklistedTs(n)) {
        return n;
      }
    }
    return "";
  };

  // Attachments extraction helper (Issue #92)
  const extractAttachments = art => {
    const attList = [];
    const seenFiles = new Set();
    const seenHrefs = new Set();

    // 1. Process structured file cards: .cuf-feedItemAttachments, .slds-file
    const cards = qsa(".cuf-feedItemAttachments .slds-file, .cuf-attachment.slds-file, .slds-file_card, .cuf-feedItemAttachments, [class*='feedItemAttachments']", art);
    for (const card of cards) {
      // Find all links inside the card
      const links = qsa("a[href*='sfc/servlet.shepherd'], a[href*='ContentDocument'], a[href*='download'], a.slds-file__crop, a.slds-file__text, a.cuf-attachment", card);
      
      // Preferred download link vs preview link
      const downloadLink = links.find(l => {
        const h = l.getAttribute("href") || l.href || "";
        return h.includes("/version/download/") || h.includes("download");
      });
      const chosenLink = downloadLink || links[0];
      if (!chosenLink) continue;

      let href = chosenLink.getAttribute("href") || chosenLink.href || "";
      if (!href || href === "#" || href.startsWith("javascript:")) continue;
      if (href.startsWith("/")) {
        href = "https://support.qualcomm.com" + href;
      }
      if (href.includes("/s/profile/") || href.includes("/_ui/core/userprofile/")) continue;

      // Extract display name from download attr, title attr, or file text title element
      let name = chosenLink.getAttribute("download") || chosenLink.getAttribute("title");
      if (!name) {
        const titleEl = card.querySelector(".slds-file__text-title, .slds-file__title, .slds-truncate, .slds-assistive-text");
        if (titleEl) name = txt(titleEl);
      }
      if (!name) {
        name = txt(chosenLink) || href.split("/").pop()?.split("?")[0] || "attachment";
      }
      name = name.trim();

      const dedupKey = name.toLowerCase();
      if (!seenFiles.has(dedupKey) && !seenHrefs.has(href)) {
        seenFiles.add(dedupKey);
        seenHrefs.add(href);
        attList.push({ name, url: href });
      }
    }

    // 2. Direct attachment links anywhere inside the article not already in cards
    const allLinks = qsa("a.cuf-attachment, a[href*='ContentDocument'], a[href*='sfc/servlet.shepherd/version/download']", art);
    for (const a of allLinks) {
      let href = a.getAttribute("href") || a.href || "";
      if (!href || href === "#" || href.startsWith("javascript:")) continue;
      if (href.startsWith("/")) {
        href = "https://support.qualcomm.com" + href;
      }
      if (href.includes("/s/profile/") || href.includes("/_ui/core/userprofile/")) continue;

      let name = a.getAttribute("download") || a.getAttribute("title") || txt(a) || href.split("/").pop()?.split("?")[0] || "attachment";
      name = name.trim();

      const dedupKey = name.toLowerCase();
      if (!seenFiles.has(dedupKey) && !seenHrefs.has(href)) {
        seenFiles.add(dedupKey);
        seenHrefs.add(href);
        attList.push({ name, url: href });
      }
    }

    return attList;
  };

  // Comments: every Chatter article (top-level posts AND nested replies are
  // <article>). Clean body comes from .feedBodyInner — that element excludes the
  // author/timestamp header and the Like/Comment/views footer, so we don't have
  // to string-surgery them off the whole-article innerText.
  let lastTopLevelIndex = null;
  const rawArticles = qsa("article");
  const extractedComments = [];
  for (const a of rawArticles) {
    const named = Array.from(a.querySelectorAll("a")).map(txt).map(s => stripFieldAffordances(s, 'author')).filter(Boolean);
    const author = named[0] || "";
    const bodyEl = a.querySelector(".feedBodyInner, .cuf-feedBodyText, [class*='feedBody']");
    // domLines() walks DOM structure (one line per <p>/<div>, one per <br>)
    // instead of trusting innerText's layout-derived line breaks — see the
    // comment on domLines above for why innerText alone isn't reliable here.
    // The trailing ".cuf-more" control's text (always exactly "Expand Post" —
    // see check_collapsed.js) is cut by cleanBody's trailing regex below.
    const rawBodyText = bodyEl ? domLines(bodyEl) : txt(a);
    const body = cleanBody(rawBodyText);
    if (!body || body.length === 0) continue;

    const timestamp = extractTimestamp(a, named, author);
    const attachments = extractAttachments(a);
    // 'cuf-comment'/'ul.cuf-replies'/'li.cuf-reply' are Salesforce Classic
    // Chatter markup; the live Lightning DOM instead marks a reply's own
    // <article> as 'cuf-commentItem' and wraps it in 'li.cuf-commentLi' with
    // no distinguishing wrapper class on its <ul> — check both DOM shapes.
    const isReply = a.classList.contains('cuf-comment') || a.classList.contains('cuf-commentItem')
      || Boolean(a.closest && a.closest('ul.cuf-replies, .cuf-replies, li.cuf-reply, li.cuf-commentLi'));

    // Secondary ordering signal for comments whose parsed timestamps tie (e.g.
    // two posts both "15 days ago"): the article's on-page vertical position,
    // read independently of NodeList traversal order via getBoundingClientRect.
    // Used only as a tiebreaker in sortCommentsChronological — see finalize_case.mjs.
    const rect = a.getBoundingClientRect && a.getBoundingClientRect();
    const displayPosition = rect ? rect.top : null;

    const currentIndex = extractedComments.length;
    let parentIndex = null;
    if (isReply) {
      parentIndex = lastTopLevelIndex;
    } else {
      lastTopLevelIndex = currentIndex;
    }

    extractedComments.push({
      id: a.id || ("c" + (currentIndex + 1)),
      timestamp,
      author,
      body,
      attachments,
      isReply,
      parentIndex,
      displayPosition,
    });
  }
  const comments = extractedComments;

  // Displayed total: the "N Chatter Feed Items" status badge in the Feed region.
  // The count MUST precede the phrase. Chatter also renders a per-item status
  // region reading "Chatter Feed Item <n>", and taking the first digit of the
  // first matching region turned that item ordinal into a bogus "total" (case
  // 08503838 stored 2 for an 11-comment thread; every cached case was wrong).
  // A number that means nothing is worse than none: null makes countAssert warn
  // and the renderer skip its completeness line, instead of both asserting
  // confidently against noise.
  let displayedCommentCount = null;
  for (const s of qsa("[role='status']")) {
    const m = txt(s).match(/(\d+)\s+Chatter\s+Feed\s+Items?\b/i);
    if (m) { displayedCommentCount = Number(m[1]); break; }
  }

  // Standard and Detail tab fields:
  // Feed pass or Detail tab pass extracts whatever is available in the DOM.
  const title = sectionValue(["Subject", "Case Subject"]);
  const status = sectionValue(["Status", "Case Status"]);
  const priority = sectionValue(["Priority", "Case Priority"]);
  // Note on severity / product / updated (Issue #111):
  // Across cached cases (08623349, 08633581, 08639518, 08642051), these fields may be
  // unpopulated for standard wireless device cases or gated by Salesforce role/team.
  // We provide broad alias lists below to match any variant if populated in the DOM.
  const severity = sectionValue(["Severity", "Case Severity", "Severity Level", "Severity:"]);
  const product = sectionValue(["Chipset", "Product", "Product Name", "Product Family", "Product Line", "Product:"]);
  const accountName = sectionValue(["Account Name", "Account", "Customer", "Customer Name"]);
  const contactName = sectionValue(["Contact Name", "Contact", "Case Contact", "Contact:"]);
  const customerProject = sectionValue(["Customer Project", "Customer Project Name", "Project", "Project Name"]);
  // TBD: verify customerTracking label list against a live case
  const customerTracking = sectionValue(["Customer Tracking", "Customer Tracking Number", "Customer Tracking#"]);
  const relatedCRs = sectionValue(["Related CRs", "Related CR", "Related Change Requests", "Change Requests", "CRs"]);
  const caseRecordType = sectionValue(["Case Record Type Name", "Case Record Type", "Record Type", "Record Type Name"]);
  const openedAt = sectionValue(["Date/Time Opened", "Date Opened", "Created Date", "Created At", "Opened Date", "Opened"]);
  const closedAt = sectionValue(["Date/Time Closed", "Date Closed", "Closed Date", "Closed At", "Closed"]);
  const updated = sectionValue(["Last Modified Date", "Modified Date", "Last Modified", "Last Modified By", "Date/Time Modified", "Modified At", "Modified"]);
  const description = sectionValue(["Description", "Description Information", "Case Description", "Problem Description", "Subject Description"]);

  return {
    caseNumber,
    title,
    status,
    priority,
    severity,
    product,
    accountName,
    contactName,
    customerProject,
    customerTracking,
    relatedCRs,
    caseRecordType,
    openedAt,
    closedAt,
    updated,
    description,
    url: location.href,
    displayedCommentCount,
    comments,
  };
})();
