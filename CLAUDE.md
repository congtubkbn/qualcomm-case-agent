# access-qualcomm

## Platform

Windows. PowerShell for all shell commands — no Unix syntax.
See `.clinerules/windows-environment.md`.

## Capture pipeline

Deterministic, model-free case capture from support.qualcomm.com.
Design, layers, invariants, entry-point contract: [`docs/DESIGN.md`](docs/DESIGN.md).
Domain language (Case, Comment, Comment Tree, …): [`CONTEXT.md`](CONTEXT.md).

Data under `data/` is NDA-protected and entirely git-ignored.
Never send case content to an external service.

## Commands

Run `npm run` or read `package.json` scripts for the full list.
Key scripts: `npm test`, `npm run case -- <code>`,
`npm run docs`, `npm run docs:check`.

## Tests

`tests/*.test.mjs` via `node --experimental-test-module-mocks --test`.
Mock `browser.mjs` at module level — no real browser.
New test files are picked up automatically.
Read `tests/qcomm_run_case.test.mjs` for the mocking pattern.

## Skills

One Claude Code skill under `.claude/skills/`:
- **qcomm** — intake → login → finalize → render.
  Entry: `node .claude/skills/qcomm/scripts/run_case.mjs <8-digit-code>`.
  Returns a JSON verdict (`status` field); branch on status, not exit code.

## Session / auth

Okta OAuth + email OTP, persisted in `data/chrome-profile/`.
Lapsed session → `auth-required` → human re-authenticates in browser.
CDP port 9773 (off well-known range); `ensureChrome()` validates
`--user-data-dir` ownership before reusing a connection (see issue #104).

## Agent conventions

- Issues/specs: GitHub issues in `congtubkbn/qualcomm-case-agent`.
  See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
- Triage labels: [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
- Domain docs: `CONTEXT.md` + `docs/adr/`.
  See [`docs/agents/domain.md`](docs/agents/domain.md).

## Editing code

Edit only lines the request touches. Match existing style.
Orphans your changes create: clean up. Pre-existing dead code: mention, leave.
Every changed line traces to the user's request.
