// scripts/extract_case.js
//
// Default case extractor for PHASE 2. Run it against the ALREADY-EXPANDED case
// page (PHASE 1.5 done) via base64 (NOT --stdin, NOT `<` redirection — PowerShell
// has no `<` stdin-redirect, and `Get-Content -Raw | agent-browser eval --stdin`
// silently returns "null" instead of the evaluated result on Windows):
//
//     $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('.claude/skills/qualcomm-case-agent/scripts/extract_case.js'))
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
//      (you get "{\"a\":1}" written to disk, which scrape_case.mjs then rejects).
//
// This is a sensible DEFAULT keyed on the confirmed Salesforce Lightning structure
// (see references/extraction.md lock-in table). If the live DOM differs and fields
// come back empty, edit this file to match what `agent-browser snapshot -c` shows —
// the skill is agent-driven, this script is a starting point, not a fixed contract.

(function () {
  const txt = el => (el && (el.innerText || el.textContent || "")).trim();
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

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
    if (!lowerLabels.length) return "";

    // 1. Button with label (e.g. collapsible section button)
    const btn = qsa("button").find(b => {
      const bt = txt(b).toLowerCase();
      return lowerLabels.includes(bt) || lowerLabels.some(l => bt === l || bt.startsWith(l + ":"));
    });
    if (btn) {
      const host = btn.closest("li, div, lightning-record-layout-item") || btn.parentElement;
      const p = host && host.querySelector("p, lightning-formatted-text, lightning-formatted-name, span:not([class*='label'])");
      if (p) {
        const val = txt(p);
        if (val) return val;
      }
    }

    // 2. Standard Salesforce Lightning label selectors
    const labels = qsa(".slds-form-element__label, label, [class*='label'], dt, .test-id__field-label, [data-label]");
    const matchedLabel = labels.find(l => {
      const t = txt(l).toLowerCase();
      return lowerLabels.includes(t) || lowerLabels.some(lbl => t === lbl || t.startsWith(lbl + ":") || t.startsWith(lbl + " *") || t === lbl + "*");
    });

    if (matchedLabel) {
      const parent = matchedLabel.closest(".slds-form-element, [class*='record-layout-item'], lightning-record-layout-item, dl, .slds-grid") || matchedLabel.parentElement;
      if (parent) {
        const valEl = parent.querySelector(".slds-form-element__control, dd, lightning-formatted-text, lightning-formatted-name, lightning-formatted-date-time, lightning-formatted-lookup, p, a, span:not([class*='label'])");
        if (valEl && valEl !== matchedLabel) {
          const val = txt(valEl);
          if (val) return val;
        }
      }
    }

    // 3. Direct data attributes
    for (const lbl of lowerLabels) {
      const el = qsa(`[data-field="${lbl}"], [data-field-name="${lbl}"], [data-name="${lbl}"]`)[0];
      if (el) {
        const val = txt(el);
        if (val) return val;
      }
    }

    return "";
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
      const val = tsEl.getAttribute("title") || txt(tsEl) || tsEl.getAttribute("datetime") || "";
      if (val && !isBlacklistedTs(val)) return val;
    }
    // Scan named links for date/time patterns
    const match = named.find(t => !isBlacklistedTs(t) && t !== author && datePattern.test(t));
    if (match) return match;

    // Scan all spans/elements for relative or date patterns
    const inlineCandidates = qsa("span, div, p, time", a);
    for (const el of inlineCandidates) {
      const t = txt(el);
      if (t && t !== author && !isBlacklistedTs(t) && t.length < 60 && datePattern.test(t)) {
        return t;
      }
      const titleAttr = el.getAttribute("title");
      if (titleAttr && !isBlacklistedTs(titleAttr) && datePattern.test(titleAttr)) {
        return titleAttr;
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

  // Extract deterministic summary preview (first 1-2 meaningful sentences without salutations)
  const extractSummary = body => {
    if (!body) return "";
    let text = cleanBody(body);
    // Strip common salutation lines (Dear ..., Hi ..., Hello ..., etc.)
    text = text.replace(/^(?:(?:dear|hi|hello|hey|good\s+(?:morning|afternoon|evening))\b[^\n,:]*[,\n:]*)+/i, "").trim();
    if (!text) return "";

    // Split into sentences or lines
    const sentences = text.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [text];
    const meaningful = sentences
      .map(s => s.replace(/\s+/g, " ").trim())
      .filter(s => s.length > 0 && !/^(?:thanks|thank you|regards|best regards|sincerely|cheers)[,.\s]*$/i.test(s));

    if (!meaningful.length) return "";
    let summary = meaningful.slice(0, 2).join(" ");
    if (summary.length > 300) {
      summary = summary.slice(0, 297) + "...";
    }
    return cleanBody(summary);
  };

  // Attachments extraction helper
  const extractAttachments = art => {
    const attList = [];
    const seen = new Set();
    const links = qsa("a.cuf-attachment, a[href*='ContentDocument'], a[href*='download'], a[href*='sfc/servlet.shepherd'], .cuf-feedItemAttachments a, .slds-file a, a[class*='attachment']", art);
    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      // Exclude author or navigation links
      if (!href || href === "#" || href.startsWith("javascript:")) continue;
      const name = txt(a) || a.getAttribute("title") || a.getAttribute("download") || href.split("/").pop() || "attachment";
      if (!seen.has(href)) {
        seen.add(href);
        attList.push({ name, url: href });
      }
    }
    return attList;
  };

  // Comments: every Chatter article (top-level posts AND nested replies are
  // <article>). Clean body comes from .feedBodyInner — that element excludes the
  // author/timestamp header and the Like/Comment/views footer, so we don't have
  // to string-surgery them off the whole-article innerText.
  const comments = qsa("article").map((a, i) => {
    const named = Array.from(a.querySelectorAll("a")).map(txt).filter(Boolean);
    const author = named[0] || "";
    const bodyEl = a.querySelector(".feedBodyInner, .cuf-feedBodyText, [class*='feedBody']");
    let rawBodyText = "";
    if (bodyEl) {
      try {
        if (bodyEl.cloneNode) {
          const clone = bodyEl.cloneNode(true);
          const moreEls = clone.querySelectorAll ? clone.querySelectorAll(".cuf-more, [class*='cuf-more']") : [];
          for (let mi = 0; mi < moreEls.length; mi++) {
            const m = moreEls[mi];
            if (m.remove) m.remove();
            else if (m.parentNode) m.parentNode.removeChild(m);
          }
          rawBodyText = txt(clone);
        } else {
          rawBodyText = txt(bodyEl);
        }
      } catch (e) {
        rawBodyText = txt(bodyEl);
      }
    } else {
      rawBodyText = txt(a);
    }
    const body = cleanBody(rawBodyText);
    const timestamp = extractTimestamp(a, named, author);

    const summary = extractSummary(body);
    const attachments = extractAttachments(a);

    // Secondary ordering signal for comments whose parsed timestamps tie (e.g.
    // two posts both "15 days ago"): the article's on-page vertical position,
    // read independently of NodeList traversal order via getBoundingClientRect.
    // Used only as a tiebreaker in sortCommentsChronological — see scrape_case.mjs.
    const rect = a.getBoundingClientRect && a.getBoundingClientRect();
    const displayPosition = rect ? rect.top : null;

    return {
      id: a.id || ("c" + (i + 1)),
      timestamp,
      author,
      summary,
      body,
      attachments,
      displayPosition,
    };
  }).filter(c => c.body.length > 0);

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
  const severity = sectionValue(["Severity", "Case Severity"]);
  const product = sectionValue(["Chipset", "Product", "Product Name"]);
  const accountName = sectionValue(["Account Name", "Account", "Customer", "Customer Name"]);
  const customer = accountName || sectionValue(["Customer", "Account Name", "Account"]);
  const contactName = sectionValue(["Contact Name", "Contact", "Case Contact", "Contact:"]);
  const customerProject = sectionValue(["Customer Project", "Customer Project Name", "Project", "Project Name"]);
  const relatedCRs = sectionValue(["Related CRs", "Related CR", "Related Change Requests", "Change Requests", "CRs"]);
  const caseRecordType = sectionValue(["Case Record Type Name", "Case Record Type", "Record Type", "Record Type Name"]);
  const openedAt = sectionValue(["Date/Time Opened", "Date Opened", "Created Date", "Created At", "Opened Date", "Opened"]);
  const closedAt = sectionValue(["Date/Time Closed", "Date Closed", "Closed Date", "Closed At", "Closed"]);
  const created = sectionValue(["Created Date", "Date/Time Opened", "Date Opened", "Created"]) || openedAt;
  const updated = sectionValue(["Last Modified Date", "Modified Date", "Last Modified"]);
  const description = sectionValue(["Description", "Description Information", "Case Description", "Problem Description", "Subject Description"]);
  const raisedBy = contactName || customer || "";

  return {
    caseNumber,
    title,
    status,
    priority,
    severity,
    product,
    customer,
    accountName,
    contactName,
    customerProject,
    relatedCRs,
    caseRecordType,
    openedAt,
    closedAt,
    created,
    updated,
    description,
    raisedBy,
    url: location.href,
    displayedCommentCount,
    comments,
  };
})();
