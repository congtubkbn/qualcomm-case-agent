# PRD & Technical Spec: Qualcomm Case Extraction & Local Storage Pipeline

- **Feature Name**: `qualcomm-case-extraction-and-local-storage`
- **Target Component**: `qualcomm-case-agent` (Data Extraction, Chatter Feed Expansion, Local Storage, Smart Diff, Offline Markdown Renderer)
- **Status**: Ready for Implementation
- **Author**: Antigravity & User Alignment Session

---

## Problem Statement

When engineers work with Qualcomm Support on Salesforce Lightning (`support.qualcomm.com`), they frequently need to inspect support cases—both their own and those created by colleagues across various teams—to understand status, root cause findings, reproduction steps, and active discussions.

However, the portal presents significant obstacles:
1. **Collapsed & Paginated Discussions**: Chatter feeds hide critical engineering discussions behind multiple layers of collapsed elements ("Expand Post", "Show more comments / Chatter feed items"). Essential troubleshooting steps, QXDM log analysis, and patch suggestions are easily missed.
2. **Scattered Case Information**: Case metadata (Subject, Description, Status, Priority, Severity, Chipset/Product, Account Name) is split across disparate UI regions (Details tabs, Search headers, Feed panels).
3. **Lack of Offline Access and Analysis**: Engineers cannot easily read cases offline or feed complete case context into downstream AI tools and scripts for further automated root-cause analysis.
4. **Loss of Manual Notes during Re-Sync**: When re-syncing an existing case to check for new Qualcomm replies, overwriting local state destroys previously recorded engineering notes or analysis tags.

---

## Solution

A robust, zero-token browser extraction pipeline integrated seamlessly into the `qualcomm-case-agent` skill that:
1. Reuses authenticated Chrome browser sessions to land on any target case.
2. Automatically navigates and expands 100% of collapsed comments and nested replies without truncating text or introducing character encoding corruption (mojibake).
3. Extracts and unifies all case metadata and chronological discussion entries.
4. Stores data locally under `data/cases/<CASE_CODE>/` in structured formats:
   - `case.raw.json`: Verbatim DOM extraction snapshot.
   - `case.json`: Normalized schema containing metadata, full timeline with author role categorization, attachment references, and dedicated `analysisLog` / `enrichment` fields.
   - `case.md`: Engineer-friendly offline Markdown report.
5. Implements a Smart Diff engine that merges newly fetched comments and status updates without overwriting existing analysis notes.

---

## User Stories

1. As an embedded systems engineer, I want to run the `qualcomm-case-agent` skill with a case number, so that I can automatically retrieve the full case details without manual copying and pasting.
2. As a software engineer, I want the extraction engine to automatically click and expand all "Expand Post" buttons, so that long comment bodies are captured completely rather than truncated.
3. As a developer troubleshooting a wireless issue, I want the system to expand all hidden Chatter feed items, so that the entire historical discussion thread is preserved.
4. As an engineer reading case discussions, I want comment bodies cleaned of Salesforce Lightning non-breaking space artifacts and mojibake, so that the text is legible and clean.
5. As a triage engineer, I want each comment in the discussion timeline to identify the author's role (Qualcomm Support vs Customer/OEM vs System), so that I can immediately tell who provided which analysis or patch.
6. As an engineer tracking attachments, I want all attached filenames and download references in comments to be cataloged in the timeline, so that I know which logs or patches were exchanged.
7. As a developer reviewing case status, I want primary metadata (Subject, Description, Status, Priority, Severity, Product/Chipset, Account) consolidated at the top of the case record, so that I have immediate context on the issue.
8. As an engineer working offline or in low-connectivity environments, I want a clean `case.md` file generated locally, so that I can read the full case without opening a browser.
9. As an AI-assisted developer, I want a structured `case.json` file saved locally, so that downstream LLM analysis workflows can process the case history programmatically.
10. As a developer re-syncing an active case, I want the system to detect new comments and update the status while preserving existing `analysisLog` and `enrichment` fields, so that my previous analytical work is never lost.
11. As a project lead tracking updates, I want terminal summary output to report whether the case is new or updated along with the count of newly added comments, so that I can quickly gauge case activity.
12. As a security-conscious engineer handling NDA data, I want all raw and normalized case files stored strictly within local git-ignored directories, so that confidential logs and client data never leave the machine.

---

## Implementation Decisions

### 1. Data Extraction & DOM Expansion Engine
- **Single-Pass In-Page Expansion**: The expansion script executes directly in the browser's context, finding all collapsed triggers ("Expand Post", "Show more comments", "Feed item loaders") and triggering them until no collapsed nodes remain or a stable state is achieved.
- **Verbatim Text Extraction & Normalization**: Comments are extracted from `.feedBodyInner` / `.cuf-feedBodyText` to separate comment text cleanly from Salesforce author/timestamp headers. Specific mojibake patterns (`â”¬Ã¡`, double-encoded non-breaking spaces) are cleaned via targeted string replacement without corrupting Vietnamese or accented characters.
- **Role Heuristics**: Author role is categorized based on company affiliation, email domain, or UI badges (distinguishing Qualcomm engineers from customer OEM engineers).

### 2. Local Storage Schema & Directory Layout
- **Storage Path**: `data/cases/<CASE_CODE>/` containing:
  - `case.raw.json`: The exact snapshot returned by the in-page extractor.
  - `case.json`: The normalized case object.
  - `case.md`: The rendered Markdown summary.
- **Normalized Schema Contract**:
  - `caseNumber`: string
  - `title` / `subject`: string
  - `description`: string
  - `status`: string
  - `priority`: string
  - `severity`: string
  - `product` / `chipset`: string
  - `customer` / `account`: string
  - `url`: string
  - `scrapedAt`: ISO timestamp string
  - `comments`: Array of comment objects:
    - `id`: unique string
    - `index`: integer (chronological order)
    - `author`: string
    - `role`: string (`Qualcomm` | `Customer` | `System`)
    - `timestamp`: string
    - `body`: string (clean text)
    - `attachments`: Array of `{ name, url }`
    - `analysisLog`: Array of strings / notes (reserved for engineer/AI enrichment)
  - `enrichment`: Object containing high-level AI analysis, root cause, and open action items.

### 3. Smart Diff & Merge Logic
- When `data/cases/<CASE_CODE>/case.json` already exists:
  - Existing `analysisLog` on matching comment IDs/timestamps are preserved.
  - Case-level `enrichment` object is preserved.
  - New comments are appended to the timeline in chronological order.
  - Status and metadata changes are updated, and a diff summary is calculated.

### 4. Offline Markdown Rendering
- Renders a clean, readable Markdown layout with:
  - Case Header (Title, Status badge, Severity, Chipset, Account, URL).
  - Problem Description section.
  - Chronological Discussion Flow (with distinct block quotes or formatting for Qualcomm vs Customer responses).
  - Attachments Table.
  - Analysis & Action Items section.

---

## Testing Decisions

### What Makes a Good Test
- Tests must verify external behavior and data contracts, never brittle DOM selector details or internal helper state.
- Extraction tests must run against realistic mock DOM fixtures representing Salesforce Lightning structures (collapsed posts, multiple replies, special characters).
- Diffing and merging tests must verify that existing notes and analysis entries remain intact when merging newly scraped data.
- Markdown rendering tests must verify completeness of sections, correct handling of empty fields, and proper ordering of comments.

### Modules Tested
1. **DOM Extractor & Cleaner**: Verifies text cleaning, author extraction, role classification, and attachment parsing on fixture HTML.
2. **Expansion Logic**: Verifies that iteration continues until all collapsed elements are triggered.
3. **Smart Diff & Merge Engine**: Verifies appending new comments, updating status, and preserving `analysisLog` / `enrichment`.
4. **Markdown Renderer**: Verifies generated Markdown format against expected section structure.

### Prior Art
- Existing unit tests in `tests/scrape_case.test.mjs` and `tests/render_case.test.mjs`.

---

## Out of Scope

1. **Write Operations**: No capability to post comments, update fields, or modify cases on the Qualcomm portal (strictly read-only).
2. **Binary Dump Downloads**: No automated downloading of multi-gigabyte QXDM log archives or crash dump binaries (only attachment metadata/links are captured).
3. **Cloud Synchronization**: No transmission of case contents to remote servers or third-party cloud storage (all data remains 100% on the local filesystem).
4. **Authentication Automation**: Does not attempt to bypass or automate Okta OTP verification; relies on persistent Chrome session reuse.

---

## Further Notes

- The skill `qualcomm-case-agent` acts as the primary user-facing orchestrator.
- All files written to `data/cases/` are ignored by git to uphold confidentiality (NDA) compliance.
