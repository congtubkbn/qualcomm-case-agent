// Proof that run_case.mjs's PortalDriver seam actually works end-to-end with
// FixturePortalDriver: no Chrome, no CDP, no network — just JSON on disk.
// This is the cheapest possible confirmation that criterion 3 of #240 holds;
// the full offline CLI contract matrix (all 4 commands, all verdict shapes)
// is #241's job, not this test's.
//     node --test tests/qcomm_fixture_portal_driver.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

process.env.QUALCOMM_ROOT = mkdtempSync(join(tmpdir(), 'qc-fixture-driver-'));

const SCRIPTS = new URL('../.claude/skills/qcomm/scripts/', import.meta.url);
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'qcomm-cases');

describe('run() with FixturePortalDriver (offline replay)', () => {
  it('produces a created verdict and writes case.json/case.md from a fixture, with no Chrome involved', async () => {
    const { run } = await import(new URL('run_case.mjs', SCRIPTS));
    const { FixturePortalDriver } = await import(new URL('fixture_portal_driver.mjs', SCRIPTS));
    const { DATA_DIR } = await import(new URL('_paths.mjs', SCRIPTS));

    const driver = new FixturePortalDriver({ fixtureDir: FIXTURE_ROOT });
    const v = await run('08000099', { mode: 'auto', driver });

    assert.equal(v.status, 'created');
    // 2, not 1: finalize_case.mjs synthesizes the case `description` as an
    // initial comment when the fixture's one real comment doesn't already
    // restate it — see synthesizeDescriptionComment() in finalize_case.mjs.
    assert.equal(v.commentCount, 2);
    assert.equal(v.verified, true);

    const caseDir = join(DATA_DIR, '08000099');
    assert.ok(existsSync(join(caseDir, 'case.json')), 'case.json should be written');
    assert.ok(existsSync(join(caseDir, 'case.md')), 'case.md should be rendered');
  });

  it('reports no-articles blocked when the fixture has no raw.json for the code', async () => {
    const { run } = await import(new URL('run_case.mjs', SCRIPTS));
    const { FixturePortalDriver } = await import(new URL('fixture_portal_driver.mjs', SCRIPTS));

    const driver = new FixturePortalDriver({ fixtureDir: FIXTURE_ROOT });
    const v = await run('08000098', { mode: 'auto', driver });

    assert.equal(v.status, 'blocked');
    assert.match(v.reason, /no fixture raw\.json/);
  });
});
