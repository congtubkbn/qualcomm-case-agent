# Qualcomm Case Management Agent — Troubleshooting & Recovery Guide

Authoritative runbook for resolving pipeline blockers when `scripts/run_case.mjs` returns a non-zero exit or non-success verdict (`auth-required`, `blocked`, `not-found`, `busy`).

---

## Verdict Routing & Actions

| Exit | Verdict `status` | Root Cause | Action |
|------|------------------|------------|--------|
| 3 | `auth-required` | Okta SSO session expired | → **Recovery 1 (Okta Manual Re-auth)** |
| 4 | `not-found` | Case does not exist or account lacks access | → **Recovery 2 (Case Not Found / Authorization)** |
| 5 | `blocked` | Feed expansion stuck / DOM unrendered | → **Recovery 3 (Stuck Page / DOM Recovery)** |
| 6 | `busy` | Lock file `data/.capture.lock` is held | → **Recovery 4 (Lock Contention)** |
| 1 | `error` / CDP Refused | Chrome crashed or port 9222 unreachable | → **Recovery 0 (Chrome / CDP Port Reset)** |

---

## Recovery 0: Chrome & CDP Port 9222 Reset

Triggered when CDP connection is refused (`ECONNREFUSED` on port 9222) or Chrome processes become unresponsive.

1. **Kill stale Chrome instances and reset port 9222**:
   ```bash
   powershell -ExecutionPolicy Bypass -File ".claude/skills/qualcomm-case-agent/scripts/recover_chrome.ps1"
   ```
2. **Verify CDP readiness**:
   ```bash
   curl -s http://127.0.0.1:9222/json/version
   ```
   *Expected result*: HTTP 200 with JSON payload containing `webSocketDebuggerUrl`.
3. **Retry capture**:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>
   ```

---

## Recovery 1: Okta Session Re-Authentication (`auth-required`)

Triggered when the saved session in `data/chrome-profile/` has lapsed and Qualcomm redirects to `account.qualcomm.com`.

1. **User manual login in visible Chrome**:
   - Switch to the Chrome window opened on port 9222.
   - Enter credentials on `account.qualcomm.com`.
   - Retrieve 6-digit MFA OTP from Samsung email (expires in ~5 min) and submit.
   - Confirm navigation lands on `support.qualcomm.com`.
2. **Resume execution**:
   - Run `node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE>`.
   - New session cookies will automatically persist in `data/chrome-profile/`.

---

## Recovery 2: Case Not Found / Authorization (`not-found`)

Triggered when Global Search returns no results for the case number.

1. **Verify case code format**: Must be exactly 8 digits (e.g. `08460319`).
2. **Check account permissions**: Ensure the logged-in Qualcomm account has view privileges for this case.
3. If code is incorrect, re-run with valid code. If code is correct but unsearchable, report access limitation to user and STOP.

---

## Recovery 3: Stuck Page / Incomplete Expansion (`blocked`)

Triggered when the page DOM fails to hydrate or the feed expansion loop hits stuck limits.

1. **Inspect verdict evidence**:
   - Check `reason` and `evidence` in the JSON stdout.
   - Check diagnostic screenshot saved at `data/cases/<CODE>/capture.png` or `probe.png`.
2. **Force full re-pagination**:
   ```bash
   node ".claude/skills/qualcomm-case-agent/scripts/run_case.mjs" <CODE> --mode full
   ```
3. If portal UI has changed, inspect `.claude/skills/qualcomm-case-agent/scripts/expand_step.js` or `extract_case.js`.

---

## Recovery 4: Lock Contention (`busy`)

Triggered when another process holds `data/.capture.lock`.

1. Wait ~30 seconds and retry once.
2. If a previous run crashed or terminated uncleanly leaving a stale lock:
   - Check if the process recorded in `data/.capture.lock` is still active.
   - Delete `data/.capture.lock` if stale and re-run.
