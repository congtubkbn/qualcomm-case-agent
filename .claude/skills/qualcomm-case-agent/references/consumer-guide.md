# qualcomm-case-agent — Consumer Interface Guide

For downstream agents, skills (e.g. `qualcomm-case-summary`, `qualcomm-case-overview`), and automated workflows that consume Qualcomm case data produced by `qualcomm-case-agent`. Consult this guide before accessing `data/cases/`.

## Quick start (3 steps)

1. **Invoke capture unconditionally**: Run `run_case.mjs` with the 8-digit case code (see "Invoke pattern" below). Because the capture pipeline is incremental, unchanged cases return `no-update` quickly without re-scraping.
2. **Verify JSON verdict**: Inspect stdout JSON verdict line to confirm success (`status: "created" | "updated" | "no-update"`).
3. **Read structured artifacts**: Access `data/cases/<CODE>/case.json` (or `data/cases/_overview.json` for multi-case aggregates) and extract required fields.

## File paths

All paths are relative to the workspace root. Each case has its own folder `data/cases/<CODE>/`.
The root `data/cases/` holds the global index, multi-case overview, and dashboard:

| File | Contents |
|------|----------|
| `data/cases/_index.json` | Registry (root): `{ "<CODE>": { syncedAt, commentCount, hash } }` |
| `data/cases/_overview.json` | Aggregated multi-case overview data (status, priority, counts, etc.) |
| `data/cases/dashboard.html` | Visual multi-case HTML dashboard rendered by cases overview |
| `data/cases/<CODE>/case.json` | Full case data (see schema below) |
| `data/cases/<CODE>/case.md` | Full human review — every comment verbatim |
| `data/cases/<CODE>/summary.json` | Case summary digest and flow narrative (produced by `qualcomm-case-summary`) |
| `data/cases/<CODE>/summary.md` | Rendered summary for human review (produced by `qualcomm-case-summary`) |

## Key schema fields

```json
{
  "caseNumber": "string",
  "title": "string | null",
  "status": "string | null",
  "priority": "string | null",
  "severity": "string | null",
  "product": "string | null",
  "accountName": "string | null",
  "contactName": "string | null",
  "customerProject": "string | null",
  "customerTracking": "string | null",
  "relatedCRs": "string | null",
  "caseRecordType": "string | null",
  "openedAt": "string | null",
  "closedAt": "string | null",
  "updated": "string | null",
  "description": "string | null",
  "url": "string",
  "displayedCommentCount": 0,
  "comments": [
    {
      "id": "stable content-derived sha256 id",
      "timestamp": "string",
      "rawTimestamp": "string (optional)",
      "author": "string",
      "body": "verbatim text",
      "summary": "1-2 sentence preview",
      "parentId": "string | null",
      "attachments": [{ "name": "string", "url": "string" }]
    }
  ],
  "detailExtracted": true,
  "capture": {
    "pendingExpand": 0,
    "pendingMoreComments": 0,
    "clicks": 0,
    "detailTabExtracted": true,
    "screenshot": "capture.png"
  },
  "hash": "sha256 over verbatim comments",
  "extractedAt": "ISO-8601"
}
```

### Notable field details

- **`detailExtracted`** (`boolean`): Tells a consumer whether the Salesforce Detail-tab extraction pass succeeded. If `detailExtracted` is `true`, a `null` in Detail-tab fields (`accountName`, `contactName`, `customerProject`, `customerTracking`, `relatedCRs`, `caseRecordType`, `openedAt`, `closedAt`) indicates genuine absence on the case. If `false`, the Detail tab pass encountered an issue or was skipped.
- **`comments[].id`** (`string`, always present): Content-derived SHA-256 hash of comment author and body prefix, guaranteeing stable identity across incremental captures.
- **`comments[].summary`** (`string`, always present): 1-2 sentence preview automatically generated from `body`. Derived directly from verbatim comment text.
- **`comments[].rawTimestamp`** (`string`, conditional): When the portal's relative timestamp ("13h ago", "Yesterday", etc.) was resolved to an ISO-8601 string, the original portal string is preserved in `rawTimestamp`. Top-level timestamps and comments not rendered in relative format retain the portal's unnormalized format (e.g. `"7/23/2026, 6:46 PM"`).
- **`comments[].attachments`** (`array`): Objects contain `name` and `url` (download URL on the Qualcomm Support portal). Note the property is `url`, not `href`.
- **`capture`** (`object`): Expansion and QA telemetry recorded during extraction (`pendingExpand`, `pendingMoreComments`, `clicks`, `detailTabExtracted`, `screenshot`).

## Invoke pattern

To ensure case data is present and fresh, invoke `qualcomm-case-agent` with the 8-digit case code unconditionally before reading. The pipeline operates incrementally, resolving cache freshness and returning `no-update` when the local cache is current.

**Headless CLI (used by automated consumers like `run_summary.mjs`):**
```bash
node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs <CODE>
```
Stdout returns exactly one JSON verdict line:
```json
{"status":"created"|"updated"|"no-update", ...}
```

**Agent invocation (Claude Code, Cline, Antigravity):**
Invoke the `qualcomm-case-agent` skill or instruct the agent to capture/sync the case code:
```
sync case <CODE>
```

## Pseudocode

Matching the pattern used by `run_summary.mjs`:

```javascript
// 1. Invoke capture/sync unconditionally (incremental: fast no-op if unchanged)
const result = await exec(`node .claude/skills/qualcomm-case-agent/scripts/run_case.mjs ${CODE}`);
const verdict = JSON.parse(result.stdout.trim().split('\n').pop());

// 2. Branch on verdict status
if (['created', 'updated', 'no-update'].includes(verdict.status)) {
  const casePath = `data/cases/${CODE}/case.json`;
  const caseData = JSON.parse(readFile(casePath));
  const comments = caseData.comments; // newest-first, replies grouped under parent
} else {
  // Handle auth-required, blocked, not-found, busy, etc. per SKILL.md
}
```

## Rules for consumers

- **Immutability & Local Ownership**: Treat all files and records under `data/cases/` as immutable read-only resources. Case artifacts, global index (`_index.json`), and overview caches (`_overview.json`) are maintained exclusively by `qualcomm-case-agent`.
- **Confidentiality & NDA Containment**: Retain all case data, comments (`comments[].body`), and previews (`comments[].summary`) strictly within the local workspace environment to uphold Qualcomm NDA compliance. Process all downstream analysis locally.
- **Presentation Ordering**: Rely on the pre-ordered comment structure (newest activity first at index 0, with reply threads nested directly beneath their parent post per `finalize_case.mjs`'s `orderCommentsForPresentation`).
- **Unconditional Synchronization**: Invoke capture directly prior to reading data to maintain cache freshness automatically without manual file existence checks.

## Full schema reference

The schema defined in [Key schema fields](#key-schema-fields) specifies the complete consumer-facing data contract.

For code implementation of data assembly, serialization, QA validation, and markdown rendering:
- `scripts/finalize_case.mjs`: Assembly of canonical `case.json`, SHA-256 hash computation, and `_index.json` registration.
- `scripts/verify_case.mjs`: Post-capture structural invariant checks and QA gate validation.
- `scripts/render_case.mjs`: Verbatim markdown rendering to `case.md`.

For the authoritative verdict status table and exit code contract, consult [`SKILL.md`](../SKILL.md#step-3--branch-on-json-verdict).
