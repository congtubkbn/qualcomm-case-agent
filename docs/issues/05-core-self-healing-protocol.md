---
ID: #117
Status: AFK
Blocked by: []
Type: Tracer Bullet
---

# 05 (#117): Core Self-Healing Protocol Engine (`ensure_protocol.mjs`) & NPM Postinstall Hook

**What to build:**
A lightweight, zero-dependency helper `scripts/ensure_protocol.mjs` that detects whether the `qc://` custom URI scheme is registered in Windows Registry (`HKCU:\Software\Classes\qc`). If missing on Windows, it automatically and silently invokes `register_protocol.ps1` to register the handler in <50ms without admin prompts. Wire this into `package.json` `postinstall` script and auto-invoke at runtime in `cases_overview.mjs` and `run_case.mjs` so any fresh machine automatically self-heals.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] Implement `scripts/ensure_protocol.mjs` with `isProtocolRegistered()` and `ensureProtocolRegistered()`.
- [x] Safe execution on non-Windows platforms (macOS/Linux returns false/no-op cleanly).
- [x] Add `"postinstall": "node scripts/ensure_protocol.mjs"` to `package.json`.
- [x] Hook `ensureProtocolRegistered()` into `cases_overview.mjs` and `run_case.mjs` on startup.
