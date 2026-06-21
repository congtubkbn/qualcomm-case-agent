# Qualcomm Case Agent — Auth Vault Redesign

**Date:** 2026-06-21
**Status:** Approved (design)
**Scope:** Rewrite Phase 1 (Authenticate) of the `qualcomm-case-agent` skill so the
agent captures the Qualcomm ID password once, stores it under a DPAPI-protected
agent-browser vault, and auto-fills it on forced re-login — while keeping session
reuse as the primary "don't ask again" mechanism and leaving the email OTP a
human-paste step.

---

## Problem

Current `SKILL.md` Phase 1 mandates the human sign in fully by hand on every
session expiry: type the Qualcomm ID password AND paste the email OTP. The agent
is forbidden from ever touching the password. The user wants:

1. Agent asks for the password only when it actually needs to log in.
2. Agent stores it so subsequent forced logins auto-fill the password.
3. A still-valid session is reused silently — no prompt, no OTP.
4. The password is re-requested only when it is wrong.

## Hard constraint (surfaced and accepted)

Qualcomm ID enforces **email OTP MFA**. A stored password fills only the password
field; the 6-digit OTP goes to the Samsung mailbox, which the agent cannot read.

- **Fully unattended login is impossible** while OTP MFA is on.
- **Session reuse** (valid `--profile` cookies → no login at all) remains the real
  "don't ask again" path.
- Password storage only saves typing the password field during a *forced*
  re-login; the human still pastes the OTP.

Decision: keep OTP human-paste. (Agent-read-mailbox is out of scope — a separate
brainstorm if ever wanted.)

## Rejected mechanisms

- **`cmdkey` / Windows Credential Manager direct (v3's idea):** store-only. The
  secret cannot be read back in plaintext, so it cannot auto-fill a web form.
  Unusable for this purpose.
- **agent-browser vault with no encryption key:** vault is plaintext on disk
  unless `AGENT_BROWSER_ENCRYPTION_KEY` is set. Rejected on its own; used only
  *with* the DPAPI key layer below.

## Chosen design

### Storage model

- Password lives in the **agent-browser auth vault** under profile name
  `qualcomm`. It is entered exactly once via `--password-stdin` (never a CLI
  argument, never echoed, never in the agent transcript).
- The vault is encrypted at rest via `AGENT_BROWSER_ENCRYPTION_KEY`.
- That encryption key is persisted as a **DPAPI-encrypted file**
  `data/.secrets/abkey.bin`, using
  `[System.Security.Cryptography.ProtectedData]::Protect(..., CurrentUser)` —
  real Windows DPAPI, built into .NET (no module install), tied to the Windows
  user. The skill decrypts it into the `AGENT_BROWSER_ENCRYPTION_KEY` env var at
  the start of each run that may need login.
- `data/.secrets/` is git-ignored. The DPAPI ciphertext does not decrypt on
  another Windows user/machine — matching the existing profile portability rule.

### Phase 1 flow (replaces current Phase 1)

1. Launch with the same `--profile "data/chrome-profile"`; open the portal;
   snapshot.
2. **Dashboard loads** (session valid) → continue to Phase 2. **No key load, no
   ask, no OTP.** Normal path.
3. **Redirected to `account.qualcomm.com` (Okta)** → session expired:
   1. Load the DPAPI key: if `data/.secrets/abkey.bin` exists → decrypt → set
      `AGENT_BROWSER_ENCRYPTION_KEY`. Else generate a random 32-byte hex key,
      DPAPI-encrypt it to that file, set the env var.
   2. If vault profile `qualcomm` exists (`agent-browser auth list`) →
      `agent-browser auth login qualcomm` (auto-fills username + password,
      submits).
   3. If no `qualcomm` profile → **ask the user for the password once**, then
      `<password> | agent-browser auth save qualcomm --url <okta-url>
      --username the.thoi@samsung.com --password-stdin`, then
      `agent-browser auth login qualcomm`.
4. **Human pastes the email OTP** in the open browser. Wait for the dashboard
   (`agent-browser wait --url` / re-snapshot).
5. **Login failed** (still on Okta / invalid-credentials error after submit) →
   treat as **wrong password**: `agent-browser auth delete qualcomm`, re-ask the
   user, re-save, retry `auth login` **once**. This is the only path that
   re-prompts. If it fails again → report and STOP (do not loop).
6. Dashboard reached → profile cookies persist automatically → the next run hits
   step 2 and is silent.

### Wrong-password detection

After `auth login` + OTP wait, verify success by URL/snapshot:
- On dashboard → success.
- Still on `account.qualcomm.com` with a visible credential error, OR the OTP
  step never appeared (password rejected before MFA) → wrong password → step 5.
- Distinguish from "OTP wrong/expired" (form advanced to OTP entry but failed
  there): that is an OTP problem, not a password problem — re-prompt for OTP, do
  not delete the vault entry.

## Security properties

- Password never appears as a CLI argument or in the agent transcript (stdin
  only; `auth list`/`auth show` hide it).
- At rest: vault encrypted by a key that is itself DPAPI-protected to the Windows
  user. Two layers; neither stores a readable plaintext password on disk.
- Nothing secret is committed: `data/.secrets/`, `data/chrome-profile/`,
  `data/cases/` all git-ignored.
- OTP and password never written to disk or output, per existing guardrails.

## Files touched

- `SKILL.md` — rewrite **Phase 1**; update **Configuration** table (add vault
  profile, DPAPI key file, encryption env var); update **Agent guardrails** and
  **Troubleshooting** (remove "never type password"; add vault + DPAPI notes);
  add `Bash(powershell:*)`/already present, confirm `allowed-tools` cover it.
- `references/login-flow.md` — full step-by-step: DPAPI key load/generate
  PowerShell, `auth save`/`auth login` commands, wrong-password vs wrong-OTP
  decision, rotation (`auth delete` + re-save).
- New dir `data/.secrets/` + `.gitignore` entry.

## Out of scope

- Reading the OTP from the mailbox.
- Migrating the browser launch / TTY `Start-Process` fix (separate concern,
  separate spec).
- Any change to Phases 0, 2–6 (scrape, enrich, persist, report).

## Open verification (during implementation)

- Confirm the exact Okta login-page URL + field selectors agent-browser
  `auth save` needs (`--url`, optional `--username-selector`/`--password-selector`)
  on first real run; record them in `references/login-flow.md`.
- Confirm `AGENT_BROWSER_ENCRYPTION_KEY` covers the `auth` vault at rest (docs
  state it for session state; validate it also encrypts auth profiles, else
  fall back to DPAPI-encrypting the vault file directly).
