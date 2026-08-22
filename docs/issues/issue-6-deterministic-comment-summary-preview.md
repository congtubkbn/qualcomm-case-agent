---
ID: #6
Status: AFK
Blocked by: [#5]
Type: Tracer Bullet
---

# Issue #6: Extract Deterministic Comment Summary Preview

## Goal
Implement a rule-based `summary` preview extractor in `extract_case.js`:
1. Parse the opening 1–2 meaningful sentences of each comment.
2. Strip greetings/salutations (e.g. `Dear QC`, `Dear Customer`, `Hello`, `Hi Hoon`, etc.) and log headers.
3. Attach `summary` to each comment in the extracted object.

## Verification
- Unit test in `tests/extract_case.test.mjs` confirming `summary` extraction for various comment patterns (Qualcomm responses, Customer reports, log snippets).
