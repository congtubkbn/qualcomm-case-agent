// CLI orchestrator: wires the overview store, dashboard renderer, and CLI table renderer
// together into the `cases_overview` command.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProtocolRegistered } from '../../../../scripts/ensure_protocol.mjs';
import {
  afterFinalize,
  applyFilter,
  buildOverviewData,
  DEFAULT_CASES_DIR,
  syncCaseOverview,
  updateCaseOverview,
} from './overview_store.mjs';
import { renderDashboardHtml } from './dashboard_renderer.mjs';
import { renderCliTable } from './cli_renderer.mjs';

/**
 * Backwards-compatibility re-exports.
 * Prefer importing directly from overview_store.mjs (ADR 0005).
 * @deprecated
 */
export { afterFinalize, syncCaseOverview, updateCaseOverview };


const __filename = fileURLToPath(import.meta.url);

/**
 * Opens a local file in the default OS web browser.
 * @param {string} filePath
 */
export function openInBrowser(filePath) {
  if (process.env.NODE_ENV === 'test' || process.env.QUALCOMM_NO_BROWSER === '1' || process.env.CI) {
    return;
  }
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * Parses CLI arguments.
 * @param {string[]} args
 * @returns {object}
 */
export function parseArgs(args) {
  const parsed = {
    rebuild: false,
    json: false,
    html: false,
    open: false,
    noOpen: false,
    filter: null,
    casesDir: DEFAULT_CASES_DIR,
    help: false,
  };

  let explicitOpen = false;
  let explicitNoOpen = false;

  for (const arg of args) {
    if (arg === '--rebuild') {
      parsed.rebuild = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--html') {
      parsed.html = true;
    } else if (arg === '--open') {
      parsed.open = true;
      explicitOpen = true;
    } else if (arg === '--no-open') {
      parsed.noOpen = true;
      explicitNoOpen = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--filter=')) {
      parsed.filter = arg.slice('--filter='.length);
    } else if (arg.startsWith('--cases-dir=')) {
      parsed.casesDir = resolve(arg.slice('--cases-dir='.length));
    }
  }

  if (explicitNoOpen) {
    parsed.open = false;
  } else if (explicitOpen) {
    parsed.open = true;
  } else if (parsed.json) {
    parsed.open = false;
  } else {
    // Default CLI behavior: auto-open dashboard in browser
    parsed.open = true;
  }

  return parsed;
}

// CLI Execution entrypoint
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    ensureProtocolRegistered({ silent: true });
  } catch {}
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`
Usage: node .claude/skills/qcomm/scripts/cases_overview.mjs [options]

Options:
  --rebuild           Force full re-scan of case directories and update _overview.json and dashboard.html
  --html              Generate data/cases/dashboard.html
  --open              Explicitly open data/cases/dashboard.html in default web browser (default)
  --no-open           Do not automatically open dashboard in browser
  --json              Emit JSON output to stdout (disables auto-open)
  --filter=<status>   Filter output cases by status (e.g. --filter=open)
  --cases-dir=<dir>   Custom cases directory path
  --help, -h          Show this help message
`);
    process.exit(0);
  }

  const overviewPath = join(options.casesDir, '_overview.json');
  const dashboardPath = join(options.casesDir, 'dashboard.html');
  let overview;

  if (options.rebuild || !existsSync(overviewPath)) {
    overview = buildOverviewData(options.casesDir);
    const tempPath = join(options.casesDir, `_overview.json.tmp.${process.pid}.${Date.now()}`);
    writeFileSync(tempPath, JSON.stringify(overview, null, 2), 'utf8');
    renameSync(tempPath, overviewPath);
  } else {
    try {
      overview = JSON.parse(readFileSync(overviewPath, 'utf8'));
    } catch {
      overview = buildOverviewData(options.casesDir);
      const tempPath = join(options.casesDir, `_overview.json.tmp.${process.pid}.${Date.now()}`);
      writeFileSync(tempPath, JSON.stringify(overview, null, 2), 'utf8');
      renameSync(tempPath, overviewPath);
    }
  }

  // Always keep dashboard.html updated when rebuilding or requesting HTML/Open
  if (options.rebuild || options.html || options.open || !existsSync(dashboardPath)) {
    renderDashboardHtml(overview, dashboardPath);
  }

  if (options.open) {
    openInBrowser(dashboardPath);
  }

  const displayData = applyFilter(overview, options.filter);

  if (options.json) {
    console.log(JSON.stringify(displayData, null, 2));
  } else {
    console.log(renderCliTable(displayData));
  }
}
