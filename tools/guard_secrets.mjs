// tools/guard_secrets.mjs — pre-commit guard: refuse to commit session/credential paths.
//
//     node tools/guard_secrets.mjs    abort (exit 1) if any staged path is forbidden
//
// Why: .gitignore alone loses to `git add -f` or to a future edit of the ignore file
// itself. This check runs at commit time, independent of ignore state, so a live
// session or credential path can never land in history even when force-staged.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_MATCHERS = [
  p => p.startsWith('data/.secrets/'),
  p => /(?:^|\/)chrome-profile\//.test(p),
  p => /(?:^|[/._-])session\.json$/i.test(p),
];

export function findForbiddenStagedPaths(paths) {
  return paths.filter(p => {
    const normalized = p.split('\\').join('/');
    return FORBIDDEN_MATCHERS.some(test => test(normalized));
  });
}

function main() {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);

  const offenders = findForbiddenStagedPaths(staged);
  if (offenders.length === 0) return;

  console.error('pre-commit: refusing to commit session/credential paths:');
  for (const path of offenders) console.error(`  ${path}`);
  console.error('Unstage these paths (git restore --staged <path>) before committing.');
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
