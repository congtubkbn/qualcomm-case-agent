# PRD: Qualcomm Case Agent JSON Schema Optimization & Cleanup

## 1. Problem Statement
The current JSON schema (`case.json`) produced by the Qualcomm scraper/agent contains unnecessary legacy fields, noise from the Salesforce Lightning DOM, and misses valuable high-level comment summaries:
1. **Garbage Timestamps**: Tooltip/aria-label strings like `"Click for single-item view of this post."` or `"Expand Post"` are captured as timestamps when proper timestamps are missed.
2. **Obsolete/Redundant Fields**: `analysisLog` is constantly empty (`[]` or `null`) inside raw comment objects because logs are embedded directly in the `body`.
3. **Missing Comment Intent / Summary**: Scanning long comment threads or code logs requires reading full bodies without a quick rule-based snippet / intent preview (`summary`).
4. **Clarification of Roles & IDs**:
   - `id`: Content-derived hash (author + first 120 chars) used for stable enrichment keying across full/incremental runs.
   - `attachments`: Keep as a clean array of `{ name, url }`, only populated when real attachments exist.

## 2. Shared Solution & Design Decisions
### 2.1 Optimized Schema Specification
```json
{
  "caseNumber": "08637663",
  "title": "[DE7.0] CR 4555226 side effect",
  "status": "Hold-Pending Action Item",
  "priority": "2 - High",
  "severity": "",
  "product": "",
  "customer": "",
  "created": "",
  "updated": "",
  "description": "",
  "url": "https://support.qualcomm.com/s/case/500dK00000ONSaTQAX/...",
  "displayedCommentCount": 14,
  "comments": [
    {
      "id": "c7405f4ac0e16",
      "timestamp": "08/13/2026, 1:04 PM",
      "author": "Kyungnam Ken Lee",
      "role": "Qualcomm",
      "summary": "Thank you for opening the case. We'll check and update.",
      "body": "Dear customer,\n\nThank you for opening the case.\nWe'll check and update.\n\nThank you",
      "attachments": []
    }
  ],
  "capture": { ... },
  "hash": "...",
  "extractedAt": "2026-08-22T00:29:41.158Z"
}
```

### 2.2 Core Field Decisions
1. **`id`**: Keep as-is. Content-derived hash is vital for linking downstream LLM enrichments (`enrichment.commentAnalyses`, `caseFlow`) without breaking on re-scrapes.
2. **`timestamp`**:
   - Explicitly blacklist UI tooltip/aria text (`"Click for single-item view..."`, `"Expand Post"`, `"Chatter Feed Item"`).
   - Prefer ISO / standard datetime from element `title` or `datetime` attributes; fallback to clean relative text (`"9 days ago"`); fallback to `""` if none.
3. **`analysisLog`**: **Removed** from raw comment schema.
4. **`attachments`**: Maintained as `[]` or omitted when empty.
5. **`summary`**: Extracted deterministically as a rule-based preview (first 1–2 meaningful sentences, stripping greetings like "Dear QC", "Dear Customer", "Hello") at scraper time, with optional LLM enrichment overwrite.
6. **Existing Cache Migration**: **Out of Scope** — only apply to future scrapes/captures.

## 3. Deep Modules Map
- [extract_case.js](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/extract_case.js): Clean DOM timestamp selectors, strip `analysisLog`, extract `summary` preview.
- [scrape_case.mjs](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs): Adjust hashing function (remove `analysisLog` dependency), validate comment fields.
- [render_case.mjs](file:///e:/the.thoi/Project/access-qualcomm/.claude/skills/qualcomm-case-agent/scripts/render_case.mjs): Update Markdown rendering to use `summary` if helpful and remove `analysisLog` code block rendering.
- [tests](file:///e:/the.thoi/Project/access-qualcomm/tests/): Update unit tests (`extract_case.test.mjs`, `scrape_case.test.mjs`, `render_case.test.mjs`).

## 4. Definition of Done (DoD)
- [ ] No comment in freshly captured `case.json` has `"Click for single-item view of this post."` as timestamp.
- [ ] `analysisLog` is removed from `comments` array in new extractions.
- [ ] Every comment contains a clean `summary` preview string.
- [ ] All tests in `npm test` pass cleanly.
