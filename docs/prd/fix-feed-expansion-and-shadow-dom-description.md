# PRD: Fix Chatter Feed Expansion Loop & Shadow DOM Description Extraction

## Problem Statement

When extracting Qualcomm support cases (such as Case `08316063`), two critical bugs prevent successful case capture and result in data omission:

1. **Infinite Expand Loop & Blocked Extraction**:
   - Salesforce Chatter renders a hidden `<a class="cuf-more hidden"><div class="">Expand Post</div></a>` tag inside `.cuf-feedBodyText` even when a post is already fully expanded or was never truncated.
   - `check_collapsed.js` uses regex `/Expand Post\s*$/i.test(bodyOf(art))` which evaluates to `true` on already-expanded posts due to DOM text inheritance, causing a false positive `stillCollapsed` count.
   - `expand_step.js` attempts to click these `display: none` elements repeatedly, exhausting the 40-round expand limit (129+ clicks) and causing `run_case.mjs` to fail with `status: blocked`.
   - `extract_case.js` leaks trailing `"Expand Post"` text into comment bodies and summaries.

2. **Missing Case Description & Detail Tab Metadata**:
   - The header accordion toggle for `Description` sits inside the Shadow DOM of `<lightning-accordion-section>`, but `expand_step.js` only searches Light DOM `button` elements, failing to open the description accordion.
   - The `Detail` tab layout fields (including `Problem Description` -> `Description`, `Customer Project`, `Account Name`, etc.) are rendered inside LWC Shadow DOM trees (`<records-record-layout-item>`, `<lightning-formatted-text>`).
   - `extract_case.js` uses `document.querySelectorAll` which cannot pierce Shadow DOM boundaries, causing `sectionValue` to return empty strings for `description` and other detail fields.

## Solution

1. **Accurate Visibility-Based Collapse Detection**:
   - In `check_collapsed.js` and `expand_step.js`, verify whether expand controls are genuinely active and visible (`display !== 'none'`, `offsetParent !== null`, and no `.hidden`/`.fadeOut` classes) instead of naive regex matching on parent text content.
   - In `extract_case.js`, sanitize comment body extraction to strip `.cuf-more` DOM nodes or trailing `"Expand Post"` strings.

2. **Shadow-DOM-Aware Element Discovery & Extraction**:
   - In `expand_step.js`, upgrade the `Description` section locator to use recursive Shadow DOM traversal (`deepByText`) so the accordion button is expanded.
   - In `extract_case.js`, implement a recursive shadow-piercing query helper (`deepQsa`) for `sectionValue` and record layout lookups so `Description` and all Salesforce Detail metadata are reliably captured.

## User Stories

1. As a developer running `qualcomm-case-agent`, I want `run_case.mjs <CODE>` to complete successfully on cases with long or expanded feeds without getting stuck in an infinite expand loop.
2. As a support engineer viewing `case.json` and `case.md`, I want comment bodies and summaries to be clean and free of leftover UI button text like `"Expand Post"`.
3. As an engineer reviewing Qualcomm cases, I want the initial case `description` to be populated accurately from both the header accordion and the `Detail` tab's `Problem Description` field.
4. As an analyst running `/qualcomm-case-summary <CODE>`, I want case summaries to accurately reflect the initial problem statement described in the case description.
5. As a QA engineer, I want automated unit and integration tests to verify both Shadow DOM metadata parsing and collapse-state settle checks.

## Implementation Decisions

### 1. Module: `check_collapsed.js`
- Replace naive regex test on `bodyOf(art)` with DOM visibility evaluation of `.cuf-more` and expand controls.
- An article is considered collapsed if and only if it contains an active expand control with `display !== 'none'`, `visibility !== 'hidden'`, and `offsetParent !== null`.

### 2. Module: `expand_step.js`
- Filter `expandControls` to only visible elements before dispatching synthetic clicks.
- Upgrade header `Description` section button search to use `deepByText('button', /^Description$/i)` to pierce `<lightning-accordion-section>` Shadow DOM.

### 3. Module: `extract_case.js`
- Replace plain `document.querySelectorAll` in `sectionValue` with recursive `deepQsa` that traverses `#shadow-root (open)` across the document tree.
- In `cleanBody` or article comment mapping, strip any `.cuf-more` text or trailing `Expand Post` markers from `body` and `summary`.

### 4. Module: `run_case.mjs` & `cdp_client.mjs`
- Ensure settle check integration with `check_collapsed.js` receives clean boolean counts.
- Preserve fallback CDP trusted click dispatching when stubborn unexpanded elements are detected.

## Testing Decisions

- **Seam**: Test `check_collapsed.js`, `expand_step.js`, and `extract_case.js` via mock DOM environments (JSDOM with shadowRoot mocks and synthetic fixtures replicating Salesforce Lightning structure) as well as live execution via CDP against Case `08316063`.
- **Test Cases**:
  - Verify `check_collapsed.js` returns `stillCollapsed: 0` when `.cuf-more` has `.hidden` / `display: none`.
  - Verify `expand_step.js` clicks `Description` button inside shadowRoot and does not click hidden expand controls.
  - Verify `extract_case.js` extracts `Description` and `Customer Project` from nested shadow DOM structures.
  - Verify comment bodies do not contain `"Expand Post"`.

## Out of Scope

- Modifying the summary prompt generation or executive summary presentation formats in `qualcomm-case-summary`.
- Changing authentication / Okta MFA login flows.

## Further Notes

- Cases `08316063` and existing cached cases will be verified against the updated extraction pipeline.
