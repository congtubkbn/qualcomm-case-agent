// Embedded client-side script for the offline Qualcomm case dashboard
// (filtering, searching, theme toggle, auto-refresh, modal interactions).

/**
 * @returns {string}
 */
export function renderClientScript() {
  return `  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const searchInput = document.getElementById('searchInput');
      const filterTabs = document.querySelectorAll('.filter-tab');
      const rows = document.querySelectorAll('.case-row');
      const emptyState = document.getElementById('emptyState');
      const themeToggle = document.getElementById('themeToggle');
      const hiddenCountEl = document.getElementById('hiddenCount');
      const intervalBtn = document.getElementById('intervalBtn');
      const intervalPopover = document.getElementById('intervalPopover');
      const refreshNowBtn = document.getElementById('refreshNowBtn');
      const protocolHelpBtn = document.getElementById('protocolHelpBtn');
      const protocolModal = document.getElementById('protocolModal');
      const closeModalBtn = document.getElementById('closeModalBtn');
      const copyProtocolCmdBtn = document.getElementById('copyProtocolCmdBtn');
      const copyNpmCmdBtn = document.getElementById('copyNpmCmdBtn');

      rows.forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('button') || e.target.closest('a')) return;
          if (row.classList.contains('hidden')) return;
          const isOpen = row.classList.toggle('expanded');
          const caretEl = row.querySelector('.caret');
          if (caretEl) caretEl.textContent = isOpen ? '▾' : '▸';
        });
      });

      const STORAGE_KEY_HIDDEN = 'qc_dashboard_hidden_cases';
      const STORAGE_KEY_THEME = 'qc_dashboard_theme';
      const STORAGE_KEY_FILTER = 'qc_dashboard_active_filter';
      const STORAGE_KEY_SEARCH = 'qc_dashboard_search_query';
      const STORAGE_KEY_REFRESH = 'qc_dashboard_refresh_interval';

      function safeStorageGet(key, fallback = null) {
        try {
          const val = localStorage.getItem(key);
          return val !== null ? val : fallback;
        } catch {
          return fallback;
        }
      }

      function safeStorageSet(key, value) {
        try {
          localStorage.setItem(key, value);
        } catch {}
      }

      let hiddenCases = new Set();
      try {
        const stored = safeStorageGet(STORAGE_KEY_HIDDEN);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            hiddenCases = new Set(parsed);
          }
        }
      } catch {
        hiddenCases = new Set();
      }

      function saveHiddenCases() {
        safeStorageSet(STORAGE_KEY_HIDDEN, JSON.stringify(Array.from(hiddenCases)));
      }

      function updateHiddenCount() {
        if (hiddenCountEl) {
          hiddenCountEl.textContent = hiddenCases.size;
        }
      }

      let currentFilter = safeStorageGet(STORAGE_KEY_FILTER, 'all');
      const validFilter = Array.from(filterTabs).some(t => t.getAttribute('data-filter') === currentFilter);
      if (!validFilter) {
        currentFilter = 'all';
      }
      filterTabs.forEach(t => {
        if (t.getAttribute('data-filter') === currentFilter) {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });

      let currentSearch = safeStorageGet(STORAGE_KEY_SEARCH, '');
      if (searchInput && currentSearch) {
        searchInput.value = currentSearch;
      }

      function applyFilters() {
        document.body.setAttribute('data-active-filter', currentFilter);
        let visibleCount = 0;
        const query = currentSearch.toLowerCase().trim();

        rows.forEach(row => {
          const rowId = row.getAttribute('data-case-id') || '';
          const rowCategory = row.getAttribute('data-status-category') || '';
          const rowText = (row.getAttribute('data-search') || '').toLowerCase();
          const isHidden = hiddenCases.has(rowId);

          let matchesFilter = false;
          if (currentFilter === 'hidden') {
            matchesFilter = isHidden;
          } else {
            if (isHidden) {
              matchesFilter = false;
            } else {
              matchesFilter = (currentFilter === 'all') || (rowCategory === currentFilter);
            }
          }

          const matchesSearch = !query || rowText.includes(query);

          if (matchesFilter && matchesSearch) {
            row.classList.remove('hidden');
            visibleCount++;
          } else {
            row.classList.add('hidden');
            row.classList.remove('expanded');
            const caretEl = row.querySelector('.caret');
            if (caretEl) caretEl.textContent = '▸';
          }
        });

        if (emptyState) {
          if (visibleCount === 0) {
            emptyState.textContent = currentFilter === 'hidden'
              ? 'No hidden cases. Click "Hide" on any case row to move it here.'
              : 'No Qualcomm cases match the selected filter and search criteria.';
            emptyState.classList.add('visible');
          } else {
            emptyState.classList.remove('visible');
          }
        }
      }

      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          currentSearch = e.target.value;
          safeStorageSet(STORAGE_KEY_SEARCH, currentSearch);
          applyFilters();
        });
      }

      filterTabs.forEach(tab => {
        tab.addEventListener('click', () => {
          filterTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          currentFilter = tab.getAttribute('data-filter');
          safeStorageSet(STORAGE_KEY_FILTER, currentFilter);
          applyFilters();
        });
      });

      document.querySelectorAll('.hide-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            hiddenCases.add(caseId);
            saveHiddenCases();
            updateHiddenCount();
            applyFilters();
          }
        });
      });

      document.querySelectorAll('.unhide-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            hiddenCases.delete(caseId);
            saveHiddenCases();
            updateHiddenCount();
            applyFilters();
          }
        });
      });

      async function copyTextToClipboard(text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const textArea = document.createElement('textarea');
          textArea.value = text;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }
      }

      function flashCopied(btn, restingIcon) {
        btn.textContent = '✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = restingIcon;
          btn.classList.remove('copied');
        }, 1200);
      }

      document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            await copyTextToClipboard(caseId);
            flashCopied(btn, '📋');
          }
        });
      });

      // Delete buttons — copy a natural-language chat instruction only.
      // Never a CLI command: per ADR 0003 the dashboard must not produce
      // anything pasteable straight into a terminal to bypass the
      // agent-confirmed delete flow.
      document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const caseId = btn.getAttribute('data-case-id');
          if (caseId) {
            await copyTextToClipboard(\`xóa case \${caseId} khỏi cache local\`);
            flashCopied(btn, '🗑️');
          }
        });
      });

      document.querySelectorAll('.comments-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isExpanded = btn.classList.toggle('expanded');
          const chevron = btn.querySelector('.chevron');
          if (chevron) chevron.textContent = isExpanded ? '▾' : '▸';
          const drawer = btn.nextElementSibling;
          if (drawer) drawer.classList.toggle('open', isExpanded);
        });
      });

      function openModal() {
        if (protocolModal) {
          protocolModal.classList.add('active');
          protocolModal.setAttribute('aria-hidden', 'false');
          document.body.style.overflow = 'hidden';
        }
      }

      function closeModal() {
        if (protocolModal) {
          protocolModal.classList.remove('active');
          protocolModal.setAttribute('aria-hidden', 'true');
          document.body.style.overflow = '';
        }
      }

      if (protocolHelpBtn) {
        protocolHelpBtn.addEventListener('click', openModal);
      }

      if (closeModalBtn) {
        closeModalBtn.addEventListener('click', closeModal);
      }

      if (protocolModal) {
        protocolModal.addEventListener('click', (e) => {
          if (e.target === protocolModal) {
            closeModal();
          }
        });
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && protocolModal && protocolModal.classList.contains('active')) {
          closeModal();
        }
      });

      if (copyProtocolCmdBtn) {
        copyProtocolCmdBtn.addEventListener('click', async () => {
          const cmd = 'powershell -ExecutionPolicy Bypass -File .claude/skills/qcomm/scripts/register_protocol.ps1';
          await copyTextToClipboard(cmd);
          flashCopied(copyProtocolCmdBtn, 'Copy Command');
        });
      }

      if (copyNpmCmdBtn) {
        copyNpmCmdBtn.addEventListener('click', async () => {
          const cmd = 'npm run setup:protocol';
          await copyTextToClipboard(cmd);
          flashCopied(copyNpmCmdBtn, 'Copy');
        });
      }

      // Theme toggle — icon-only, glyph reflects the active theme (no visible label)
      if (themeToggle) {
        function effectiveIsDark() {
          const current = document.documentElement.getAttribute('data-theme');
          if (current === 'dark') return true;
          if (current === 'light') return false;
          return window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        function syncThemeIcon() {
          themeToggle.textContent = effectiveIsDark() ? '☀️' : '🌙';
        }

        const savedTheme = safeStorageGet(STORAGE_KEY_THEME);
        if (savedTheme) {
          document.documentElement.setAttribute('data-theme', savedTheme);
        }
        syncThemeIcon();

        themeToggle.addEventListener('click', () => {
          const next = effectiveIsDark() ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', next);
          safeStorageSet(STORAGE_KEY_THEME, next);
          syncThemeIcon();
        });
      }

      // Auto-refresh countdown timer (default 300s = 5m). No visible ticker text —
      // remaining time surfaces only via the interval button's title tooltip.
      const savedRefreshInterval = safeStorageGet(STORAGE_KEY_REFRESH);
      let refreshSeconds = savedRefreshInterval !== null ? parseInt(savedRefreshInterval, 10) : 300;
      if (isNaN(refreshSeconds)) refreshSeconds = 300;

      let remainingSeconds = refreshSeconds;
      let refreshTimer = null;

      function formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }

      function updateTickerDisplay() {
        if (!intervalBtn) return;
        intervalBtn.title = refreshSeconds <= 0
          ? 'Auto-refresh: Off'
          : 'Auto-refresh in: ' + formatTime(remainingSeconds);
      }

      function startCountdown() {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        if (refreshSeconds <= 0) {
          updateTickerDisplay();
          return;
        }
        remainingSeconds = refreshSeconds;
        updateTickerDisplay();
        refreshTimer = setInterval(() => {
          remainingSeconds--;
          if (remainingSeconds <= 0) {
            clearInterval(refreshTimer);
            window.location.reload();
          } else {
            updateTickerDisplay();
          }
        }, 1000);
      }

      if (intervalBtn && intervalPopover) {
        function closeIntervalPopover() {
          intervalPopover.classList.remove('open');
          intervalBtn.setAttribute('aria-expanded', 'false');
        }

        intervalBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = intervalPopover.classList.toggle('open');
          intervalBtn.setAttribute('aria-expanded', String(isOpen));
        });

        intervalPopover.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('click', () => {
            intervalPopover.querySelectorAll('button').forEach(b => {
              b.classList.remove('active');
              b.setAttribute('aria-checked', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-checked', 'true');
            refreshSeconds = parseInt(btn.getAttribute('data-val'), 10) || 0;
            safeStorageSet(STORAGE_KEY_REFRESH, String(refreshSeconds));
            startCountdown();
            closeIntervalPopover();
          });
        });

        document.addEventListener('click', closeIntervalPopover);
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') closeIntervalPopover();
        });

        const activeBtn = intervalPopover.querySelector(\`button[data-val="\${refreshSeconds}"]\`);
        if (activeBtn) {
          intervalPopover.querySelectorAll('button').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-checked', 'false');
          });
          activeBtn.classList.add('active');
          activeBtn.setAttribute('aria-checked', 'true');
        }
      }

      if (refreshNowBtn) {
        refreshNowBtn.addEventListener('click', () => {
          window.location.reload();
        });
      }

      startCountdown();

      updateHiddenCount();
      applyFilters();
    });
  </script>`;
}
