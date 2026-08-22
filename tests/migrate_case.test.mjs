// tests/migrate_case.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/migrate_case.mjs', import.meta.url));

describe('tools/migrate_case.mjs', () => {
  it('re-sorts comments chronologically, fixes roles, and updates case.json and case.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-mig-'));
    const caseDir = join(dir, '08637663');
    mkdirSync(caseDir, { recursive: true });

    const fixture = {
      caseNumber: '08637663',
      title: 'CR 4555226 side effect',
      comments: [
        {
          id: 'c_new1',
          author: 'Aiden An',
          role: 'Customer',
          body: 'Dear customer\nPlease check latest TAU update.\nThanks\nAiden',
          timestamp: '',
        },
        {
          id: 'c_new2',
          author: 'beomjun kim',
          role: 'Customer',
          body: 'Dear QCOM\nFocus on VoNR.\nThanks.',
          timestamp: '',
        },
        {
          id: 'c_old1',
          author: 'Kyungnam Ken Lee',
          role: 'Customer',
          body: 'Dear customer,\nThank you for opening the case.',
          timestamp: 'August 7, 2026 at 9:52 PM',
        },
        {
          id: 'c_mid1',
          author: 'Seunghoon Lee',
          role: 'Customer',
          body: 'Dear Customer,\nI will check and update you\nThanks,\nHoon',
          timestamp: 'August 9, 2026 at 6:07 PM',
        },
      ],
    };

    const jsonPath = join(caseDir, 'case.json');
    writeFileSync(jsonPath, JSON.stringify(fixture, null, 2), 'utf8');

    const r = spawnSync(process.execPath, [SCRIPT, jsonPath], { encoding: 'utf8' });
    assert.equal(r.status, 0);

    const updated = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(updated.comments.length, 4);

    // Comment 0 should be Kyungnam Ken Lee (Aug 7)
    assert.equal(updated.comments[0].author, 'Kyungnam Ken Lee');
    assert.equal(updated.comments[0].role, 'Qualcomm');

    // Comment 1 should be Seunghoon Lee (Aug 9)
    assert.equal(updated.comments[1].author, 'Seunghoon Lee');
    assert.equal(updated.comments[1].role, 'Qualcomm');

    // Latest comments should be at the end
    assert.equal(updated.comments[2].author, 'Aiden An');
    assert.equal(updated.comments[2].role, 'Qualcomm');
    assert.equal(updated.comments[3].author, 'beomjun kim');
    assert.equal(updated.comments[3].role, 'Customer');

    // case.md should be rendered
    assert.ok(existsSync(join(caseDir, 'case.md')));
    const md = readFileSync(join(caseDir, 'case.md'), 'utf8');
    assert.match(md, /### 1\. August 7, 2026 at 9:52 PM · Kyungnam Ken Lee \(Qualcomm\)/);
  });
});
