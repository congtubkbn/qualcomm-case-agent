---
Status: AFK
Blocked by: [#100]
Type: Infra
---

## Parent
Part of #99

## What to build
Provide PowerShell scripts to register and unregister the `qc://` custom URL protocol in the Windows Registry under `HKCU:\Software\Classes\qc` (without requiring administrator/UAC elevation), and expose npm CLI commands.

1. `scripts/register_protocol.ps1`:
   - Writes `HKCU:\Software\Classes\qc` registry keys pointing to `node "<project_root>\scripts\open_qc_case.mjs" "%1"`.
   - Handles Windows paths with spaces cleanly.
2. `scripts/unregister_protocol.ps1`:
   - Safely removes `HKCU:\Software\Classes\qc`.
3. `package.json` updates:
   - Add `"setup:protocol": "powershell -ExecutionPolicy Bypass -File scripts/register_protocol.ps1"`
   - Add `"uninstall:protocol": "powershell -ExecutionPolicy Bypass -File scripts/unregister_protocol.ps1"`

## Acceptance criteria
- [ ] `register_protocol.ps1` sets up `HKCU:\Software\Classes\qc` properly without requiring admin rights.
- [ ] `unregister_protocol.ps1` cleanly removes the key.
- [ ] `npm run setup:protocol` and `npm run uninstall:protocol` work as expected from project root.

## Blocked by
- #100
