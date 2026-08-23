---
Status: AFK
Blocked by: [#100]
Type: Tracer Bullet
---

## Parent
Part of #99

## What to build
Update `render_case.mjs` and summary renderers to produce smart dual links in the generated `case.md` and `summary.md`.

Format:
`- **Portal:** [Open in Qualcomm Profile (qc://)](qc://case/<caseNumber>) · [Web Link](<caseUrl>)`

If no `url` is recorded in `case.json`, fallback to generating the `qc://case/<caseNumber>` link and Qualcomm search link.

## Acceptance criteria
- [ ] `generateMarkdown()` in `render_case.mjs` outputs `qc://case/<caseNumber>` alongside the web link.
- [ ] Unit tests in `tests/render_case.test.mjs` are updated and pass with 100% success.

## Blocked by
- #100
