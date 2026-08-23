---
ID: #72
Status: AFK
Blocked by: []
Type: Critical Bug
---

## What to build
- In `check_collapsed.js`, replace naive regex `/Expand Post\s*$/` on `bodyOf(art)` with DOM visibility inspection on `.cuf-more` / expand controls (`display !== 'none'`, `offsetParent !== null`, and absence of `.hidden`/`.fadeOut` classes).
- In `expand_step.js`, filter `expandControls` to only active visible controls before dispatching synthetic clicks.
- In `extract_case.js`, clean comment body extraction to strip `.cuf-more` DOM text or trailing `"Expand Post"` markers from `body` and `summary`.
- Add unit tests verifying collapse detection with hidden elements and clean comment extraction.

## Acceptance criteria
- [x] `check_collapsed.js` returns `stillCollapsed: 0` when all `.cuf-more` elements are hidden
- [x] `expand_step.js` does not dispatch clicks to hidden expand controls
- [x] Extracted comment bodies and summaries do not contain trailing `"Expand Post"`
- [x] Unit tests pass
