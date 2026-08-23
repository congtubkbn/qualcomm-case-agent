---
ID: #73
Status: AFK
Blocked by: [#72]
Type: Tracer Bullet
---

## What to build
- In `expand_step.js`, update header Description accordion toggle lookup to use recursive shadow-piercing helper `deepByText('button', /^Description$/i)` so `<lightning-accordion-section>` Shadow DOM is penetrated.
- In `extract_case.js`, implement `deepQsa` helper to recursively traverse shadow roots for `sectionValue` and layout item parsing so `Description`, `Problem Description`, `Customer Project`, `Account Name`, and other Detail tab fields are reliably extracted.
- Add unit tests verifying shadow DOM traversal and field extraction.

## Acceptance criteria
- [x] Header `Description` accordion button is found and clicked when collapsed
- [x] `sectionValue` in `extract_case.js` extracts `Description` and other fields from inside LWC Shadow DOM
- [x] Detail tab metadata extraction populates `description` accurately
- [x] Unit tests pass
