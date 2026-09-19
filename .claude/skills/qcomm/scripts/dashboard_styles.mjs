// Embedded CSS stylesheet for the offline Qualcomm case dashboard.

/**
 * @returns {string}
 */
export function renderStyles() {
  return `  <style>
    :root {
      --bg: #fafaf9;
      --card-bg: #ffffff;
      --text-primary: #18181b;
      --text-secondary: #52525b;
      --text-muted: #a1a1aa;
      --border: #d4d4d8;
      --border-strong: #a1a1aa;
      --border-subtle: #f4f4f5;
      --accent: #1d4ed8;
      --accent-hover: #1e40af;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --badge-open-bg: #eff6ff;
      --badge-open-text: #1d4ed8;
      --badge-progress-text: #b45309;
      --badge-closed-text: #52525b;
      --badge-action-bg: #fef2f2;
      --badge-action-text: #b91c1c;
      --badge-pending-qc-text: #7c3aed;
      --badge-pending-cust-text: #0891b2;
      --badge-p1-bg: #fef2f2;
      --badge-p1-text: #b91c1c;
      --badge-p2-bg: #fff7ed;
      --badge-p2-text: #c2410c;
      --summary-bg: #f0fdf4;
      --summary-border: #bbf7d0;
      --summary-text: #166534;
      --shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.08);
      --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }

    [data-theme="dark"] {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text-primary: #f8fafc;
      --text-secondary: #cbd5e1;
      --text-muted: #64748b;
      --border: #334155;
      --border-strong: #475569;
      --border-subtle: #182234;
      --accent: #3b82f6;
      --accent-hover: #60a5fa;
      --badge-open-bg: rgba(59, 130, 246, 0.15);
      --badge-open-text: #93c5fd;
      --badge-progress-text: #fcd34d;
      --badge-closed-text: #cbd5e1;
      --badge-action-bg: rgba(239, 68, 68, 0.15);
      --badge-action-text: #fca5a5;
      --badge-pending-qc-text: #c4b5fd;
      --badge-pending-cust-text: #67e8f9;
      --badge-p1-bg: rgba(239, 68, 68, 0.2);
      --badge-p1-text: #fca5a5;
      --badge-p2-bg: rgba(249, 115, 22, 0.2);
      --badge-p2-text: #fdba74;
      --summary-bg: rgba(34, 197, 94, 0.1);
      --summary-border: rgba(34, 197, 94, 0.25);
      --summary-text: #86efac;
      --shadow-sm: 0 1px 3px 0 rgb(0 0 0 / 0.3);
      --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.3);
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0f172a;
        --card-bg: #1e293b;
        --text-primary: #f8fafc;
        --text-secondary: #cbd5e1;
        --text-muted: #64748b;
        --border: #334155;
        --border-strong: #475569;
        --border-subtle: #182234;
        --accent: #3b82f6;
        --accent-hover: #60a5fa;
        --badge-open-bg: rgba(59, 130, 246, 0.15);
        --badge-open-text: #93c5fd;
        --badge-progress-text: #fcd34d;
        --badge-closed-text: #cbd5e1;
        --badge-action-bg: rgba(239, 68, 68, 0.15);
        --badge-action-text: #fca5a5;
        --badge-pending-qc-text: #c4b5fd;
        --badge-pending-cust-text: #67e8f9;
        --badge-p1-bg: rgba(239, 68, 68, 0.2);
        --badge-p1-text: #fca5a5;
        --badge-p2-bg: rgba(249, 115, 22, 0.2);
        --badge-p2-text: #fdba74;
        --summary-bg: rgba(34, 197, 94, 0.1);
        --summary-border: rgba(34, 197, 94, 0.25);
        --summary-text: #86efac;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text-primary);
      line-height: 1.5;
      padding: 24px;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .brand-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .meta {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }
    .toolbar-pill {
      display: flex;
      align-items: center;
      gap: 2px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px;
    }
    .pill-divider {
      width: 1px;
      height: 18px;
      background: var(--border);
      margin: 0 2px;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--text-primary);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .icon-btn:hover {
      background: var(--badge-open-bg);
      color: var(--accent);
    }
    .icon-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .interval-wrap {
      position: relative;
    }
    .interval-popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      display: none;
      flex-direction: column;
      min-width: 84px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-md);
      padding: 4px;
      z-index: 20;
    }
    .interval-popover.open {
      display: flex;
    }
    .interval-popover button {
      all: unset;
      box-sizing: border-box;
      width: 100%;
      padding: 6px 10px;
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-secondary);
      border-radius: 5px;
      cursor: pointer;
    }
    .interval-popover button:hover {
      background: var(--badge-open-bg);
      color: var(--accent);
    }
    .interval-popover button.active {
      color: var(--accent);
      font-weight: 700;
    }
    .controls-bar {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 24px;
    }
    @media (min-width: 768px) {
      .controls-bar {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
      }
    }
    .search-box {
      flex: 1;
      max-width: 480px;
      position: relative;
    }
    .search-input {
      width: 100%;
      padding: 7px 10px;
      border: 1px solid var(--border);
      background: var(--card-bg);
      color: var(--text-primary);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .search-input:focus {
      border-color: var(--accent);
      outline: 1px solid var(--accent);
      outline-offset: 1px;
    }
    .filter-tabs {
      display: flex;
      flex-wrap: wrap;
      border: 1px solid var(--border);
      width: fit-content;
    }
    .filter-tab {
      background: var(--card-bg);
      border: none;
      border-right: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 7px 12px;
      font-family: var(--mono);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-tab:last-child {
      border-right: none;
    }
    .filter-tab:hover {
      color: var(--text-primary);
    }
    .filter-tab.active {
      background: var(--text-primary);
      color: var(--card-bg);
    }
    .table-wrap {
      overflow-x: auto;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
    }
    .cases-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .cases-table thead th {
      text-align: left;
      font-family: var(--mono);
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-strong);
      padding: 8px 12px;
      white-space: nowrap;
    }
    tr.case-row {
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background-color 0.1s ease;
    }
    tr.case-row:hover {
      background: var(--border-subtle);
    }
    tr.case-row.hidden {
      display: none !important;
    }
    tr.case-row td {
      padding: 9px 12px;
      vertical-align: middle;
    }
    tr.detail-row {
      display: none;
    }
    tr.detail-row td {
      background: var(--border-subtle);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px 16px;
    }
    tr.case-row.expanded + tr.detail-row {
      display: table-row;
    }
    .caret-cell {
      width: 20px;
      text-align: center;
    }
    .caret {
      color: var(--text-muted);
      font-size: 11px;
      display: inline-block;
    }
    .case-col {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 320px;
      max-width: 480px;
    }
    .case-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cell-case {
      font-family: var(--mono);
      white-space: nowrap;
    }
    .case-number {
      font-family: var(--mono);
      font-weight: 700;
      font-size: 13px;
      color: var(--accent);
      text-decoration: none;
    }
    a.case-number:hover {
      text-decoration: underline;
      color: var(--accent-hover);
    }
    .cell-title {
      max-width: 380px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .cell-title a {
      color: var(--text-primary);
      text-decoration: none;
    }
    .cell-title a:hover {
      color: var(--accent);
      text-decoration: underline;
    }
    .case-meta-subline {
      font-size: 11.5px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .case-meta-subline strong {
      color: var(--text-secondary);
      font-weight: 500;
    }
    .meta-dot {
      color: var(--text-muted);
      opacity: 0.6;
    }
    .time-col {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-secondary);
      display: flex;
      flex-direction: column;
      gap: 2px;
      white-space: nowrap;
    }
    .status-col {
      display: flex;
      flex-direction: column;
      gap: 4px;
      white-space: nowrap;
    }
    .pri-badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      width: fit-content;
    }
    .pri-critical {
      background: var(--badge-p1-bg);
      color: var(--badge-p1-text);
    }
    .pri-high {
      background: var(--badge-p2-bg);
      color: var(--badge-p2-text);
    }
    .pri-normal {
      background: var(--border-subtle);
      color: var(--text-secondary);
    }
    .activity-col {
      font-size: 11.5px;
      color: var(--text-secondary);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .activity-comm-count {
      color: var(--text-muted);
    }
    .activity-staleness {
      color: var(--text-muted);
    }
    .actions-cell {
      display: flex;
      gap: 4px;
      align-items: center;
      justify-content: flex-end;
    }
    .action-btn, .copy-btn, .hide-btn, .unhide-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-secondary);
      font-family: var(--mono);
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .action-btn:hover, .copy-btn:hover {
      background: var(--border-subtle);
      border-color: var(--border);
      color: var(--text-primary);
    }
    .copy-btn.copied, .delete-btn.copied {
      background: var(--summary-bg) !important;
      color: var(--summary-text) !important;
      border-color: var(--summary-border) !important;
    }
    .hide-btn:hover {
      background: var(--badge-action-bg);
      color: var(--badge-action-text);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .delete-btn:hover {
      background: var(--badge-action-bg);
      color: var(--badge-action-text);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .unhide-btn {
      display: none;
    }
    .unhide-btn:hover {
      background: var(--summary-bg);
      color: var(--summary-text);
      border-color: var(--summary-border);
    }
    body[data-active-filter="hidden"] .hide-btn {
      display: none !important;
    }
    body[data-active-filter="hidden"] .unhide-btn {
      display: inline-flex !important;
    }
    body:not([data-active-filter="hidden"]) .unhide-btn {
      display: none !important;
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      max-width: 640px;
      width: calc(100% - 32px);
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.25), 0 8px 10px -6px rgb(0 0 0 / 0.25);
      transform: translateY(16px) scale(0.98);
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .modal-overlay.active .modal-card {
      transform: translateY(0) scale(1);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .modal-title {
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .modal-close-btn {
      background: transparent;
      border: none;
      font-size: 24px;
      line-height: 1;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      transition: color 0.15s ease, background 0.15s ease;
    }
    .modal-close-btn:hover {
      color: var(--text-primary);
      background: var(--border-subtle);
    }
    .modal-body {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    @media (min-width: 580px) {
      .comparison-grid {
        grid-template-columns: 1fr 1fr;
      }
    }
    .comparison-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--text-secondary);
    }
    .comparison-header {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }
    .comparison-header strong {
      color: var(--text-primary);
      font-size: 13px;
    }
    .mode-tag {
      display: inline-block;
      align-self: flex-start;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mode-qc {
      background: var(--badge-open-bg);
      color: var(--badge-open-text);
    }
    .mode-web {
      background: var(--summary-bg);
      color: var(--summary-text);
    }
    .cmd-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .cmd-text {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-primary);
      word-break: break-all;
    }
    .copy-cmd-btn, .copy-cmd-btn-sm {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .copy-cmd-btn-sm {
      padding: 3px 8px;
      font-size: 11px;
    }
    .copy-cmd-btn:hover, .copy-cmd-btn-sm:hover {
      background: var(--accent);
      color: #ffffff;
      border-color: var(--accent);
    }
    .copy-cmd-btn.copied, .copy-cmd-btn-sm.copied {
      background: var(--summary-bg) !important;
      color: var(--summary-text) !important;
      border-color: var(--summary-border) !important;
    }
    .cmd-box-alt {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .cmd-text-inline {
      font-family: var(--mono);
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      color: var(--text-primary);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-project { background: var(--border-subtle); color: var(--text-secondary); border: 1px solid var(--border); margin-left: 4px; }
    .status-tag {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 6px;
      border: 1px solid currentColor;
      white-space: nowrap;
    }
    .status-tag-open { color: var(--badge-open-text); }
    .status-tag-in_progress { color: var(--badge-progress-text); }
    .status-tag-closed { color: var(--badge-closed-text); }
    .status-tag-action_required { color: var(--badge-action-text); }
    .status-tag-pending_qualcomm { color: var(--badge-pending-qc-text); }
    .status-tag-pending_customer { color: var(--badge-pending-cust-text); }
    .status-tag-other { color: var(--text-muted); }
    .meta-row {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 12px;
    }
    .detail-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      margin-top: 10px;
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }
    .comments-collapse-wrap {
      margin-top: 10px;
    }
    .comments-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      font-family: var(--mono);
      font-size: 11.5px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .comments-toggle-btn:hover {
      background: var(--border-subtle);
      color: var(--text-primary);
      border-color: var(--border-strong);
    }
    .comments-toggle-btn .chevron {
      font-size: 10px;
      transition: transform 0.2s ease;
      display: inline-block;
    }
    .comments-toggle-btn.expanded .chevron {
      transform: rotate(90deg);
    }
    .comments-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      padding-left: 4px;
    }
    .comments-drawer {
      display: none;
    }
    .comments-drawer.open {
      display: flex;
    }
    .comment-item {
      background: var(--border-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      font-size: 13px;
    }
    .comment-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    .comment-author {
      font-weight: 600;
      color: var(--text-primary);
    }
    .comment-body {
      color: var(--text-secondary);
      word-break: break-word;
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 15px;
      display: none;
    }
    .empty-state.visible {
      display: block;
    }
  </style>`;
}
