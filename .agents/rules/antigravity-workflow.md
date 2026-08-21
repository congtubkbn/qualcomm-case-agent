---
trigger: always_on
---

# Google Antigravity Workflow Rules: Human-AI Alignment & Implementation

These rules govern all code modifications, feature designs, and implementations in this workspace. You MUST strictly adhere to this workflow. Treat these rules as hard constraints, not optional guidelines.

---

## 1. GIAI ĐOẠN 1: ALIGNMENT & SHARED DESIGN (THE "GRILL ME" PHASE)
- **DO NOT** write code, generate plans, or start implementation immediately based on vague or brief requirements.
- **MUST Invoke "Grill Me" Protocol**: Actively interview the user. You must:
  1. Ask exactly **ONE question at a time** to maintain focus.
  2. For each question, propose a concrete **"My Recommendation"** based on the existing codebase architecture.
  3. Explore and walk down the design tree systematically (database schema -> API contract -> UI).
  4. Continue this feedback loop until reaching a **Shared Design Concept** (absolute agreement on all core aspects).
- **Out of Scope Boundary**: Capture and document what is explicitly decided as "Out of Scope" to define a rigid Definition of Done (DoD).

## 2. GIAI ĐOẠN 2: CODIFY THE DESTINATION (CREATE PRD)
- Summarize the alignment decisions into a single **PRD (Product Requirements Document)**.
- Save the PRD locally (e.g., `docs/prd/feature-name.md`) or write it directly to GitHub Issues.
- The PRD must contain:
  1. **Problem Statement**: What problem is the user facing?
  2. **Solution**: High-level architectural approach.
  3. **User Stories**: Clear "Definition of Done" (DoD) for each user interaction.
  4. **Deep Modules Map**: Explicitly specify which files/modules are affected. Keep modules **"Deep"** (simple public interface, hiding complex implementations).
  5. **Testing Decisions**: Specify the exact testing strategy and boundaries.

## 3. GIAI ĐOẠN 3: THE JOURNEY (CREATE GITHUB ISSUES WITH BLOCKING DAG)
- **Vertical Slices Only**: Split the PRD into "vertical slices" of functionality. Every task/issue must cut through all layers of the stack (DB, Server API, Frontend UI) to ensure near-instant integrated feedback loops. No horizontal slicing (doing all DB first, then all API).
- **Define Dependencies (DAG)**: Format each GitHub Issue with the following metadata block at the very top to define the Directed Acyclic Graph (DAG) on the Kanban board:
  ```markdown
  ---
  ID: #<Number>
  Status: [AFK | Human-in-the-Loop]
  Blocked by: [#ID_1, #ID_2]
  Type: [Critical Bug | Infra | Tracer Bullet | Polish | Refactor]
  ---
  ```
- **Doc Rot Prevention**: Once an issue is fully merged and completed, it MUST be closed on GitHub. Never leave active or outdated PRDs/specs inside the repository's active files, as they rot and mislead future agents.

## 4. GIAI ĐOẠN 4: IMPLEMENTATION LOOP (THE "NIGHT SHIFT" / AFK AGENT)
- **Context Clearing Prerequisite**: Before writing code, the conversation context must be cleared (e.g., click **"New Conversation"** in Antigravity) to reset the token count and place the agent back into the **"Smart Zone" (< 100k tokens)**.
- Read the active GitHub issues backlog using `gh cli` or local markdown files. Identify tasks marked as `AFK` that are **NOT blocked** by any open issues.
- **Strict TDD (Test-Driven Development) Cycle (Red-Green-Refactor)**:
  1. **Red**: Write a single, highly specific failing integration/unit test first. Execute the test runner and confirm it fails.
  2. **Green**: Write the minimal code required to pass the test. Run tests to confirm it passes.
  3. **Refactor**: Clean up the code. Maintain the "Deep Module" principle.
- **Run Feedback Loops**: Execute local build, type-checks (`npm run typecheck`), and the test suite. Do not declare a task complete if any feedback loop fails. Fix errors iteratively.
- **Commit**: Make a clean, atomic git commit for the issue containing both the implementation and the tests.

## 5. GIAI ĐOẠN 5: SMART-ZONE CODE REVIEW & HUMAN QA
- **Context Clearing for Review**: Review your own code in an isolated session or fresh context window. Do not review code with a bloated history (>100k tokens), as it forces you into the "Dumb Zone."
- **Human QA**: Hand over the implementation to the user for manual validation to impose human taste, quality, and design standards.
- **Handling Feedback**: Any bugs or aesthetic gaps found during Human QA must be registered as a **new blocking GitHub issue**. Do not attempt to fix them on the fly without a tracked task.
