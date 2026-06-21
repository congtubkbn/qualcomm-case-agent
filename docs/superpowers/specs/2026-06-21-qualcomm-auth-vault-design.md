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
- **agent-browser vault as durable store + `AGENT_BROWSER_ENCRYPTION_KEY`
  (original design):** verified during implementation to NOT work. The auth
  vault ignores `AGENT_BROWSER_ENCRYPTION_KEY` (that env var only encrypts
  `--session-name` state). The vault self-manages its key in a **plaintext** file
  `~/.agent-browser/.encryption-key` sitting next to the AES-encrypted
  `~/.agent-browser/auth/<name>.json`. Copying both files off the machine = full
  compromise → not bound to the Windows user, fails the "real security"
  requirement. So the vault is NOT used as the durable store.

## Chosen design

### Storage model (corrected)

- Durable secret = **DPAPI ProtectedData file** `data/.secrets/qid.bin`, written
  with `[System.Security.Cryptography.ProtectedData]::Protect(bytes, null,
  CurrentUser)` — real Windows DPAPI, built into .NET (no module install), bound
  to the Windows user. Verified round-trip on this machine.
- The agent-browser auth vault is used **only as a transient stdin→form
  conduit**, never as durable storage. Per forced login: decrypt `qid.bin` in
  PowerShell → pipe into `auth save qualcomm --password-stdin` → `auth login
  qualcomm` (waits for form, fills, submits) → `auth delete qualcomm`. The vault
  entry exists only for the seconds between save and delete.
- Password never appears as a CLI argument or in the transcript: PowerShell holds
  it in-memory and pipes it via stdin; the agent's visible commands reference a
  `$pw` variable, not the value.
- `data/.secrets/` is git-ignored. The DPAPI ciphertext does not decrypt on
  another Windows user/machine — matching the existing profile portability rule.

### Phase 1 flow (replaces current Phase 1)

1. Launch with the same `--profile "data/chrome-profile"`; open the portal;
   snapshot.
2. **Dashboard loads** (session valid) → continue to Phase 2. **No key load, no
   ask, no OTP.** Normal path.
3. **Redirected to `account.qualcomm.com` (Okta)** → session expired:
   1. If `data/.secrets/qid.bin` exists → decrypt in PowerShell to an in-memory
      `$pw`. Else → **instruct the user to run the one-time capture snippet in
      their own real terminal** (`Read-Host -AsSecureString` → DPAPI Protect →
      `qid.bin`). The password is typed into their terminal, NEVER into the chat,
      so it never enters the transcript. Wait for them, then decrypt `qid.bin`.
   2. Drive the conduit (agent-side, no echo): decrypt `qid.bin` → pipe via
      stdin to `auth save qualcomm --url <okta-url>
      --username the.thoi@samsung.com --password-stdin` → `auth login qualcomm`
      (auto-fills + submits) → `auth delete qualcomm`.
4. **Human pastes the email OTP** in the open browser. Wait for the dashboard
   (`agent-browser wait --url` / re-snapshot).
5. **Login failed** (still on Okta / invalid-credentials error after submit) →
   treat as **wrong password**: delete `data/.secrets/qid.bin` (and any stray
   `qualcomm` vault entry), re-ask the user, re-encrypt, retry the conduit
   **once**. This is the only path that re-prompts. If it fails again → report
   and STOP (do not loop).
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

- Password never appears as a CLI argument, in the chat, or in the agent
  transcript: first capture is a user-run terminal snippet; later use is a
  decrypt→stdin pipe whose only visible output is agent-browser's status line.
- At rest: the only durable copy is `data/.secrets/qid.bin`, DPAPI-bound to the
  Windows user (`CurrentUser` scope). Useless if copied to another user/machine.
- The agent-browser vault holds the password only transiently (save→login→delete
  within one forced-login run); no durable plaintext-keyed copy survives.
- Nothing secret is committed: `data/.secrets/`, `data/chrome-profile/`,
  `data/cases/` all git-ignored.
- OTP and password never written to disk in plaintext or to output.

## Files touched

- `SKILL.md` (both copies: global `~/.claude/skills/...` and project
  `.claude/skills/...`) — rewrite **Phase 1**; update **Configuration** table
  (add `qid.bin` DPAPI secret, transient vault profile); update **Agent
  guardrails** (replace "never type password" with the vault/DPAPI model) and
  **Troubleshooting**. `allowed-tools` already include `PowerShell` and
  `Bash(agent-browser:*)`.
- `references/login-flow.md` (both copies) — full step-by-step: DPAPI
  encrypt/decrypt PowerShell helpers, the save→login→delete conduit,
  wrong-password vs wrong-OTP decision, rotation.
- New dir `data/.secrets/` + `.gitignore` entry.

## Resolved during implementation

- `AGENT_BROWSER_ENCRYPTION_KEY` does NOT encrypt the auth vault (only
  `--session-name` state). Vault self-manages a plaintext `.encryption-key`.
  → dropped that layer; durable secret is DPAPI `qid.bin` instead.
- DPAPI `ProtectedData` round-trip verified on this machine (CurrentUser scope).
- agent-browser vault confirmed AES-GCM encrypted at
  `~/.agent-browser/auth/<name>.json`; used transiently only.

## Open verification (first real login)

- Confirm the exact Okta login-page URL + field selectors `auth save` needs
  (`--url`, optional `--username-selector`/`--password-selector`); record them in
  `references/login-flow.md`. Okta sometimes uses a two-step (username → next →
  password) form; if so, `auth login` may need custom selectors or a manual
  snapshot-driven fill via `eval --stdin`.

## Out of scope

- Reading the OTP from the mailbox.
- Migrating the browser launch / TTY `Start-Process` fix (separate concern,
  separate spec).
- Any change to Phases 0, 2–6 (scrape, enrich, persist, report).
