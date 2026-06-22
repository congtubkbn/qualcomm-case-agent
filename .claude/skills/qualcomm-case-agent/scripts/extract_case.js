// scripts/extract_case.js
//
// Default case extractor for PHASE 2. Run it against the ALREADY-EXPANDED case
// page (PHASE 1.5 done) with:
//
//     agent-browser eval --stdin < .claude/skills/qualcomm-case-agent/scripts/extract_case.js \
//       > data/cases/<CODE>.raw.json
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
  const qsa = sel => Array.from(document.querySelectorAll(sel));

  // Case number: document.title is reliably "Case: <CODE>" on the case page.
  // Require the colon form + a leading digit so the Cases LIST view (title
  // "Cases") can't false-match and yield a junk id like "s". Fall back to a
  // "Case <CODE>" heading, then the URL slug.
  const titleMatch = (document.title || "").match(/Case:\s*(\d[\w-]*)/i);
  const caseHeading = qsa("h1, [role='heading']").find(h => /^Case\s+\d/i.test(txt(h)));
  const caseNumber = (titleMatch && titleMatch[1])
    || (caseHeading ? txt(caseHeading).replace(/^Case\s+/i, "").trim() : "")
    || location.pathname.split("/").filter(Boolean).pop();

  // Optional section helper for collapsible "Subject"/"Description" panels IF the
  // case page exposes them (some layouts only show these on the Detail tab — see
  // note below). Returns "" when absent, which is expected on a Feed-only view.
  const sectionValue = label => {
    const btn = qsa("button").find(b => txt(b) === label);
    if (!btn) return "";
    const host = btn.closest("li, div") || btn.parentElement;
    const p = host && host.querySelector("p");
    return p ? txt(p) : "";
  };

  // Comments: every Chatter article (top-level posts AND nested replies are
  // <article>). Clean body comes from .feedBodyInner — that element excludes the
  // author/timestamp header and the Like/Comment/views footer, so we don't have
  // to string-surgery them off the whole-article innerText.
  const comments = qsa("article").map((a, i) => {
    const named = Array.from(a.querySelectorAll("a")).map(txt).filter(Boolean);
    const author = named[0] || "";
    // Second named link is the timestamp unless it's the "Expand Post" control.
    const tsCandidate = named[1] && named[1] !== "Expand Post" ? named[1] : (named[2] || "");
    const bodyEl = a.querySelector(".feedBodyInner, .cuf-feedBodyText, [class*='feedBody']");
    const body = bodyEl ? txt(bodyEl) : txt(a);
    return {
      id: a.id || ("c" + (i + 1)),
      timestamp: tsCandidate,
      company: "",
      author,
      role: "",
      body,
      analysisLog: [],
      attachments: [],
    };
  }).filter(c => c.body.length > 0);

  // Displayed total: "N Chatter Feed Items" status badge in the Feed region.
  let displayedCommentCount = null;
  const feedStatus = qsa("[role='status']").find(s => /Chatter Feed Item/i.test(txt(s)));
  if (feedStatus) {
    const m = txt(feedStatus).match(/(\d+)/);
    displayedCommentCount = m ? Number(m[1]) : null;
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
    status: "",                            // from PHASE 1 search row
    priority: "",                          // from PHASE 1 search row
    severity: "",
    product: sectionValue("Chipset"),      // present only if Detail fields are on the page
    customer: sectionValue("Account Name"),
    created: "",
    updated: "",
    description: sectionValue("Description"),
    url: location.href,
    displayedCommentCount,
    comments,
  };
})();
