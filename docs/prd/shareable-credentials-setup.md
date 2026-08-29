# Spec: Shareable Qualcomm Credentials Configuration

## Problem Statement

Currently, the Qualcomm support ID email address (`the.thoi@samsung.com`) is hardcoded as a fallback/default throughout the codebase (`login_fill.js`, `fast_landing.mjs`) and documentation (`SKILL.md`, `login-flow.md`, `manual-flow.md`). If a colleague attempts to run the `qualcomm-case-agent` tool, it defaults to the original user's email, preventing them from using their own credentials and completing Okta authentication without manually editing the source code.

## Solution

Remove all hardcoded references to the Samsung email in the logic, make the username configurable, and introduce a user-friendly setup command. Users will configure their own credentials (email and password) via a guided PowerShell setup script, saving them locally in the git-ignored `data/.secrets/` folder. The main orchestrator will load these local settings or accept command-line overrides, and will fail with a clear configuration instruction if credentials are not configured.

## User Stories

1. As a new user (colleague), I want a user-friendly setup script (`npm run setup:credentials`) that prompts me for my Qualcomm ID email and password, so that I can configure my local environment without editing any code files.
2. As a user, I want my configured Qualcomm ID email and password to be saved securely in the git-ignored `data/.secrets/` directory, so that my credentials are not committed to git.
3. As a developer/agent running the case capture command, I want the tool to automatically read my configured email and password, so that the password autofill and authentication succeed under my account.
4. As a user, I want the tool to support an optional `--username` or `--user` flag when launching the case capture, so that I can override the default configured account for specific runs.
5. As a developer, I want the tool to fail immediately with a clear diagnostic message if credentials are not configured, so that I know exactly what command to run to set them up.
6. As a colleague reading the project documentation, I want to see generic setup instructions rather than user-specific hardcoded emails, so that I can easily understand how to authenticate.

## Implementation Decisions

- **Credentials Setup Script**: Rename the existing `capture_password.ps1` script to `capture_credentials.ps1`. The script will prompt the user for both their Qualcomm ID (email) and their password.
- **Local Secret Storage**:
  - The email will be saved in plaintext in `data/.secrets/qid.user`.
  - The password will be saved in `data/.secrets/qid.bin`, encrypted using Windows DPAPI (CurrentUser scope) as before.
- **NPM Script Shortcut**: Register `"setup:credentials"` in `package.json` to execute `capture_credentials.ps1`.
- **Config Resolution**:
  - Update paths and config logic to resolve the username by checking:
    1. The `--username` or `--user` command-line argument.
    2. The `QUALCOMM_USER` environment variable.
    3. The `data/.secrets/qid.user` local file.
  - If none of these are set, the execution must halt with a clear error advising the user to run `npm run setup:credentials`. No fallback to `the.thoi@samsung.com` will be utilized.
- **Login Autofill Script**: Update the page script so it accepts the resolved username passed from the main process, failing if no username is supplied.
- **Documentation**: Clean up `SKILL.md` and reference markdown files to replace hardcoded emails with placeholders or generic guides, explaining the configuration steps clearly.

## Testing Decisions

- A good test only validates external behaviors (correct config resolution and failure modes) rather than implementation details.
- **Tests to build/modify**:
  - Add unit tests for the configuration resolution logic (resolving username from file, environment variable, or flag).
  - Verify that `login_fill` script evaluation receives the resolved username correctly.
  - Verify that running capture with missing credentials returns a clear `error` status.
- **Prior Art**: Refer to existing `tests/secret_store.test.mjs` and `tests/login_fill.test.mjs` for mock-based testing patterns.

## Out of Scope

- Multi-user profile mapping within a single Chrome instance (the Chrome profile remains single-user at `data/chrome-profile/`).
- Automated email OTP retrieval (OTP remains a human-in-the-loop task due to mailbox access constraints).
- Cross-platform password encryption (the script remains Windows/DPAPI-centric as established in the project constraints).

## Further Notes

- All changes will maintain backward compatibility with the current user's local setup by allowing them to run `npm run setup:credentials` once to set their email and password.
- Documentation updates will be verified against the design validation checks.
