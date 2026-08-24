---
ID: #118
Status: AFK
Blocked by: [#117]
Type: Tracer Bullet
---

# 06 (#118): Dashboard Dual-Mode Links (`🔗 Web Link`) & Protocol Help Modal

**What to build:**
Update the HTML dashboard generator in `cases_overview.mjs` to render a dedicated `🔗 Web Link` action button on every case card, directly pointing to `https://support.qualcomm.com/s/case/...` in a new tab (`target="_blank" rel="noopener noreferrer"`). Add a `⚙️ Protocol Help` button to the Dashboard header that opens an interactive modal with protocol status, explanation of `qc://` vs `Web Link`, and a 1-click copy button for the PowerShell registration command.

**Blocked by:** #117 (05: Core Self-Healing Protocol Engine (`ensure_protocol.mjs`) & NPM Postinstall Hook)

**Status:** ready-for-agent

- [ ] Render `🔗 Web Link` button alongside `Copy ID` / `Hide` / `Delete` on each case card.
- [ ] Fallback to Qualcomm global search link if specific case URL is missing in metadata.
- [ ] Add `⚙️ Protocol Help` button in Dashboard header with modal UI.
- [ ] Add 1-click copy button inside modal for manual registration command.
- [ ] Re-generate `data/cases/dashboard.html` with new UI components.
