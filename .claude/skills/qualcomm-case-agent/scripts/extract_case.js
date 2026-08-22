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
  const cleanBody = s => s.replace(/â”¬Ã¡/g, "").replace(/Â(?=[\s\n]|$)/g, "");

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
  const sectionValue = label => {
    const lowerLabel = (label || "").toLowerCase();
    const btn = qsa("button").find(b => txt(b).toLowerCase() === lowerLabel);
    if (btn) {
      const host = btn.closest("li, div") || btn.parentElement;
      const p = host && host.querySelector("p");
      if (p) return txt(p);
    }
    const labels = qsa(".slds-form-element__label, label, [class*='label'], dt");
    const matchedLabel = labels.find(l => txt(l).toLowerCase() === lowerLabel);
    if (matchedLabel) {
      const parent = matchedLabel.closest(".slds-form-element, [class*='record-layout-item'], dl") || matchedLabel.parentElement;
      if (parent) {
        const valEl = parent.querySelector(".slds-form-element__control, dd, lightning-formatted-text, p, span:not([class*='label'])");
        if (valEl && valEl !== matchedLabel) return txt(valEl);
      }
    }
    return "";
  };

  // Role heuristics: distinguish Qualcomm engineers from Customer/OEM vs System
  const classifyRole = (author, company, context, body = "") => {
    const combined = ((author || "") + " " + (company || "") + " " + (context || "")).toLowerCase();
    if (combined.includes("qualcomm") || combined.includes("@qualcomm.com") || combined.includes("qcom support")) {
      return "Qualcomm";
    }
    if (combined.includes("system") || combined.includes("automated process")) {
      return "System";
    }
    // Contextual greeting heuristics
    const firstLines = (body || "").slice(0, 200).toLowerCase();
    if (/^(?:dear|hi|hello)\s+customer\b/i.test(firstLines.trim()) || /\bqualcomm\s+team\b/i.test(firstLines)) {
      return "Qualcomm";
    }
    if (/^(?:dear|hi|hello)\s+(?:qcom|qualcomm)\b/i.test(firstLines.trim())) {
      return "Customer";
    }
    // Known Qualcomm engineer name patterns
    const authorLower = (author || "").toLowerCase();
    if (["aiden an", "seunghoon lee", "hoon lee", "cs lee", "kyungnam ken lee"].includes(authorLower)) {
      return "Qualcomm";
    }
    return "Customer";
  };

  // Timestamp extraction helper
  const extractTimestamp = (a, named, author) => {
    const tsEl = a.querySelector("a.cuf-timestamp, span.cuf-timestamp, time, .uiOutputDateTime, [class*='timestamp'], [class*='Timestamp'], [class*='dateTime'], [class*='DateTime']");
    if (tsEl) {
      const val = txt(tsEl) || tsEl.getAttribute("datetime") || tsEl.getAttribute("title") || "";
      if (val) return val;
    }
    // Scan named links for date/time patterns
    const datePattern = /(?:ago|yesterday|today|\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b)/i;
    const match = named.find(t => t !== "Expand Post" && t !== author && datePattern.test(t));
    if (match) return match;

    // Fallback: second or third named link
    return (named[1] && named[1] !== "Expand Post" && named[1] !== author) ? named[1] : ((named[2] && named[2] !== "Expand Post") ? named[2] : "");
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
    const body = cleanBody(bodyEl ? txt(bodyEl) : txt(a));
    const timestamp = extractTimestamp(a, named, author);

    const compEl = a.querySelector(".company, .title, [class*='company'], [class*='userTitle']");
    const company = compEl ? txt(compEl) : "";
    const role = classifyRole(author, company, a.className || "", body);
    const attachments = extractAttachments(a);

    return {
      id: a.id || ("c" + (i + 1)),
      timestamp,
      company,
      author,
      role,
      body,
      analysisLog: [],
      attachments,
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

  // title / status / priority / customer live on the case Detail tab and the
  // search-results row, NOT the Feed view this extractor runs on. The agent fills
  // them from the PHASE 1 search snapshot (it already saw Subject/Status/Priority/
  // Customer Project in the results table) by editing the raw JSON before finalize,
  // or by clicking the "Detail" tab and re-reading. Left "" here so the Feed pass
  // never blocks on header fields that aren't present.
  return {
    caseNumber,
    title: sectionValue("Subject"),       // usually "" on Feed view — agent fills from PHASE 1
    status: sectionValue("Status"),       // present if Detail fields are on page or search row
    priority: sectionValue("Priority"),   // present if Detail fields are on page
    severity: sectionValue("Severity"),
    product: sectionValue("Chipset") || sectionValue("Product"),      // present if Detail fields are on the page
    customer: sectionValue("Account Name") || sectionValue("Customer"),
    created: sectionValue("Created Date"),
    updated: sectionValue("Last Modified Date"),
    description: sectionValue("Description"),
    url: location.href,
    displayedCommentCount,
    comments,
  };
})();
