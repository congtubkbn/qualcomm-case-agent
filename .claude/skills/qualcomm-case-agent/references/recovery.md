# Recovery paths — Chrome/CDP, Auth, Empty/Stuck page

Reactive branches for the Qualcomm Case Management Agent. SKILL.md's hot path stays
clean; these run only when a phase reports the matching failure. Each runs at most
ONCE per invocation unless noted. Commands assume the `qcase` CLI is on PATH
(installed via `npm link` in `scripts/`) and agent-browser is attached (PHASE 0).

---

## Recovery 0 — Chrome/CDP Not Available

Run when `agent-browser open` errors or times out. The daemon may have a stale PID
pointing at a dead Chrome — clean that up first, then launch fresh:

```powershell
# 1. Clear any stale daemon state (safe: path-filtered, never touches user's personal Chrome)
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -like "*\.agent-browser\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process agent-browser-win32-x64 -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "$env:USERPROFILE\.agent-browser\default.pid",
            "$env:USERPROFILE\.agent-browser\default.port",
            "$env:USERPROFILE\.agent-browser\default.stream" -Force -ErrorAction SilentlyContinue
```

```bash
# 2. Launch real Chrome + attach (idempotent: reuses CDP 9222 if already up after cleanup)
qcase chrome
# The helper prints the exact ws:// connect command — run it:
#   agent-browser connect "ws://127.0.0.1:9222/devtools/browser/<id>"
# Do NOT use bare `connect 9222` — Windows resolves localhost to IPv6 ::1, Chrome binds IPv4 only → timeout
```

After attaching, retry PHASE 1 once. If `open` errors again → report and STOP.

**Why real Chrome?** The bundled Playwright Chromium can ship a broken build whose CDP
handshake times out on every `open`. Real Chrome is stable and OS-trusted.

---

## Recovery 1 — Auth Required

Run when PHASE 1 `open` or a post-click navigation shows `account.qualcomm.com`. Full
flow + failure handling: **`login-flow.md`**.

The session is stored in `data\chrome-profile\` (persistent `--user-data-dir`). When
valid, no login or OTP is needed. This recovery only triggers when the Okta session
token has lapsed.

**Step 1 — Try profile auto-fill first (preferred, no script needed)**

Chrome password manager pre-fills credentials when the profile is intact. Just click through:

```bash
agent-browser snapshot -i
# Expected: textbox "Username" pre-filled with the.thoi@samsung.com
# Check "Keep me signed in" to extend session duration (~30 days):
agent-browser check @<keep-me-signed-in-ref>
agent-browser click @<next-ref>
agent-browser wait 3000
agent-browser snapshot -i
# Expected: textbox "Password" pre-filled (shown as ••••••••)
agent-browser click @<verify-ref>
agent-browser wait 5000
agent-browser snapshot -i
```

**Decision after Verify click:**

| Outcome | Signal | Action |
|---------|--------|--------|
| Dashboard loads | nav shows Cases/Projects links | session established → retry PHASE 1 |
| OTP screen appears | heading "Enter a verification code" | go to Step 3 (OTP) |
| Still on password screen / error | password field still visible, error text | → Step 2 (`qcase login`) |
| Username NOT pre-filled | blank textbox | → Step 2 (`qcase login`) |

**Step 2 — Fallback: `qcase login` (only if Step 1 failed)**

`data\.secrets\qid.bin` exists → run the DPAPI-decrypted two-step helper:
```bash
qcase login
```

`qid.bin` missing → ask user to run in a **real PowerShell terminal** (NOT cmd, NOT chat):
```
qcase capture-pw
```
Wait for "Saved … bytes", then run `qcase login`.

After `qcase login`, check snapshot again with the same decision table above.

**Step 3 — OTP (only if presented)**

Drive OTP screens by snapshot: **"Send me an email"** → **"Enter a verification code
instead"** → user pastes 6-digit code → **"Verify"**. Selectors in `login-flow.md`.

**Failure table:**

| Situation | Action |
|-----------|--------|
| Wrong password (never advanced past password screen) | delete `qid.bin`; ask user to re-run `qcase capture-pw`; retry ONCE. Fails again → STOP. |
| OTP rejected/expired | OTP problem — do NOT delete `qid.bin`. User requests fresh code and re-pastes. |
| Email unavailable + session expired | cannot authenticate — report and STOP. |

**Never** echo the password or OTP. The only durable secret is `qid.bin` (DPAPI-encrypted).

> **Why "Keep me signed in":** Okta default session is ~2h; checking this box extends to
> ~30 days, dramatically reducing how often Recovery 1 triggers. Always check it when the
> checkbox is present.

---

## Recovery 2 — Empty/Stuck Page

Run when PHASE 1 polling ends in `state=BLANK`, or `state=LOADING` after the 6-round
(12s) ceiling — the page is on the right URL but never rendered results. **Diagnose in
place; never navigate to a guessed URL.** Runs at most ONCE.

```bash
# 1. Auth bounce that the probe's host check may have raced? Re-confirm host directly.
agent-browser eval "(function(){ return location.hostname; })()"
#    = account.qualcomm.com → go to Recovery 1 (Auth) instead.

# 2. Reload the SAME url once (transient SPA hydration failure), then re-poll readiness.
agent-browser open "https://support.qualcomm.com/s/global-search/<CODE>"   # SAME link — not a different route
for i in 1 2 3 4 5 6; do
  R=$(qcase script readiness | agent-browser eval --stdin)
  echo "$R"
  echo "$R" | grep -qE '"state":"(READY|EMPTY|AUTH)"' && break
  agent-browser wait 2000
done
```

Decision after the reload poll:

| Result | Action |
|--------|--------|
| `READY` | recovered → return to PHASE 1 (click the result) |
| `EMPTY` | genuinely zero results → STOP (wrong code / no access) |
| `AUTH` | → Recovery 1 |
| still `BLANK`/`LOADING` | portal down or render broken → **STOP**, report final probe `{state,url,host,nodes,rows,title}` |

**Hard ceiling:** Recovery 2 runs once. Do not loop it, do not escalate to other URLs. A
persistently blank page is reported, not worked around.
