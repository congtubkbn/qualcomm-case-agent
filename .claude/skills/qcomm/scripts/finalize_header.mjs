// scripts/finalize_header.mjs
//
// Header-flag policy: the fields the agent already holds in-context from the
// PHASE 1 search row (title/status/priority/severity), passed to finalize_case.mjs
// as CLI flags so the big raw file never has to be re-Read just to add a title
// (O(1) tokens, not O(case size)), plus the Detail-tab metadata field list.

// Header fields the agent already holds in-context from the PHASE 1 search row.
// Passing them as flags lets the script backfill the big raw file in CODE — the
// agent never re-Reads case.raw.json just to add a title (O(1) tokens, not O(case size)).
export const HEADER_KEYS = ['title', 'status', 'priority', 'severity'];

// Salesforce Lightning Detail tab metadata fields persisted to canonical case.json.
export const DETAIL_KEYS = [
  'contactName',
  'openedAt',
  'closedAt',
  'customerProject',
  'customerTracking',
  'accountName',
  'relatedCRs',
  'caseRecordType',
];

// Parse `--title "..."` style flags into an overrides object. Only HEADER_KEYS honored.
// Also supports `--ref-date <date>` for test reference date injection.
export function parseHeaderFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-zA-Z-]+)$/.exec(argv[i]);
    if (m && argv[i + 1] != null) {
      if (HEADER_KEYS.includes(m[1])) {
        out[m[1]] = argv[++i];
      } else if (m[1] === 'ref-date' || m[1] === 'reference-date') {
        out.refDate = argv[++i];
      }
    }
  }
  return out;
}
