// CLI entry point: thin argv wrapper around precedent_store.mjs. Prints one JSON line
// shaped { status, query, candidates } for a free-text issue query against a cases directory.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CASES_DIR, searchPrecedents } from './precedent_store.mjs';

const __filename = fileURLToPath(import.meta.url);

/**
 * Parses CLI arguments: non-flag args are joined as the free-text query.
 * @param {string[]} args
 * @returns {object}
 */
export function parseArgs(args) {
  const parsed = { query: '', casesDir: DEFAULT_CASES_DIR, limit: 10, help: false };
  const positional = [];

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--cases-dir=')) {
      parsed.casesDir = resolve(arg.slice('--cases-dir='.length));
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) parsed.limit = n;
    } else {
      positional.push(arg);
    }
  }

  parsed.query = positional.join(' ').trim();
  return parsed;
}

// CLI Execution entrypoint
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(`
Usage: node .claude/skills/qualcomm-issue-precedent/scripts/precedent_search.mjs <query text> [options]

Options:
  --cases-dir=<dir>   Custom cases directory path
  --limit=<n>         Max candidates to return (default 10)
  --help, -h          Show this help message
`);
    process.exit(0);
  }

  if (!options.query) {
    console.log(JSON.stringify({ status: 'error', reason: 'query text required', query: '', candidates: [] }));
    process.exit(1);
  }

  const candidates = searchPrecedents(options.query, options.casesDir, options.limit);
  console.log(JSON.stringify({ status: 'ok', query: options.query, candidates }));
}
