// scripts/readiness.js
//
// PHASE 1 readiness probe. Run it after `agent-browser open <global-search URL>`
// to classify the page state WITHOUT a blind sleep:
//
//     agent-browser eval --stdin < .claude/skills/qualcomm-case-agent/scripts/readiness.js
//
// Why a file (not an inline eval): the probe carries regex (/no results/i) and CSS
// selectors with nested quotes (a[href*="/s/case/"]). Inline, those break command-line
// quoting differently under Bash vs PowerShell — the same reason intake.mjs keeps its
// regex off the command line and extract_case.js runs via --stdin. Keep it here.
//
// Same two rules as extract_case.js:
//   1. One IIFE whose final expression IS the result object (eval runs in EXPRESSION
//      context — a bare top-level `return` throws "Illegal return statement").
//   2. Return the OBJECT, not JSON.stringify(object) — agent-browser serializes once.
//
// The Salesforce Lightning portal is a client-rendered SPA: right after `open`, the
// accessibility tree (snapshot) can be empty while the DOM is still hydrating. snapshot
// alone CANNOT tell "still loading" from "zero results" from "blank/dead page" — they
// all read as "(empty page)". This probe computes a single `state` browser-side so the
// SKILL.md poll loop branches on one enum field instead of grepping raw JSON:
//
//   AUTH    location bounced to account.qualcomm.com   → Recovery 1 (Auth)
//   READY   search-result rows present                 → continue (click result)
//   EMPTY   load finished, genuinely zero results       → STOP (wrong code / no access)
//   BLANK   DOM essentially empty (dead/blank page)      → Recovery 2 (Empty/Stuck)
//   LOADING hydrating — none of the above yet            → wait, probe again
(function () {
  var nodes = document.querySelectorAll('*').length;
  var text  = (document.body && document.body.innerText || '').trim();
  // READY signal: a Lightning search-results row, or any link into a real case record.
  var rows  = document.querySelectorAll(
                'tr[data-row-key-value], a[href*="/s/case/"], lightning-base-formatted-text'
              ).length;
  // LOADING signal: Lightning spinner still on screen.
  var spin  = document.querySelectorAll('lightning-spinner, .slds-spinner').length;
  // EMPTY signal: Lightning "no results" illustration text.
  var noRes = /no results|0 result|nothing to see/i.test(text);

  var state;
  if (location.hostname === 'account.qualcomm.com') state = 'AUTH';
  else if (rows > 0)                                state = 'READY';
  else if (noRes && spin === 0)                     state = 'EMPTY';
  else if (nodes < 50)                              state = 'BLANK';
  else                                              state = 'LOADING';

  return {
    state: state,
    url: location.href,
    host: location.hostname,
    nodes: nodes,
    rows: rows,
    spinner: spin,
    noResults: noRes,
    title: document.title
  };
})()
