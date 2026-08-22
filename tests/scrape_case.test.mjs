// Tests for the finalizer — the module that decides what gets persisted.
//     node --test tests/
//
// Two layers, because the risk sits in both:
//   1. the pure helpers (identity, hashing, merging, gates), imported directly;
//   2. finalize() itself, exercised by SPAWNING the script against a throwaway
//      cache root. finalize() ends in process.exit, so a child process is the
//      honest way to test it — and what it actually persists only shows up
//      through the real file it writes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs', import.meta.url));
const m = await import(new URL('../.claude/skills/qualcomm-case-agent/scripts/scrape_case.mjs', import.meta.url));

const comment = (author, body, extra = {}) => ({ author, body, timestamp: '2 days ago', ...extra });

describe('computeHash', () => {
  const base = { displayedCommentCount: 2, comments: [comment('Alice', 'RRC reject on n78')] };

  it('is stable across runs and ignores fields outside comments', () => {
    const withExtra = { ...base, someOtherField: { x: 1 } };
    assert.equal(m.computeHash(base), m.computeHash(withExtra));
    assert.equal(m.computeHash(base), m.computeHash(structuredClone(base)));
  });

  it('changes when verbatim content changes', () => {
    assert.notEqual(m.computeHash(base), m.computeHash({ ...base, comments: [comment('Alice', 'RRC reject on n41')] }));
    assert.notEqual(m.computeHash(base), m.computeHash({ ...base, comments: [comment('Bob', 'RRC reject on n78')] }));
    assert.notEqual(m.computeHash(base), m.computeHash({ ...base, comments: [comment('Alice', 'RRC reject on n78', { timestamp: '1 day ago' })] }));
  });

  // displayedCommentCount is a portal-rendered counter, not case content: it
  // drifts between reads of an identical thread (observed on 08503838: 8 -> 2
  // with all 11 bodies unchanged). Hashing it turned that drift into a phantom
  // `updated` verdict carrying newComments: 0.
  it('ignores displayedCommentCount — a portal counter, not content', () => {
    assert.equal(m.computeHash(base), m.computeHash({ ...base, displayedCommentCount: 3 }));
    assert.equal(m.computeHash(base), m.computeHash({ ...base, displayedCommentCount: null }));
  });

  it('does not depend on the comment id scheme', () => {
    const a = { ...base, comments: [{ ...base.comments[0], id: 'c1' }] };
    const b = { ...base, comments: [{ ...base.comments[0], id: 'cdeadbeef0000' }] };
    assert.equal(m.computeHash(a), m.computeHash(b));
  });
});

describe('sortCommentsChronological', () => {
  // Regression case: two comments both parse to the same relative timestamp
  // ("15 days ago"). The portal's true visual order can diverge from raw
  // extraction/NodeList order — displayPosition (a getBoundingClientRect().top
  // -style page-order signal) must decide the tie, not originalIndex.
  it('breaks a timestamp tie using displayPosition when originalIndex disagrees', () => {
    const higher = { author: 'Engineer A', body: 'First reply body text.', timestamp: '15 days ago', displayPosition: 100 };
    const lower = { author: 'Engineer B', body: 'Second reply body text.', timestamp: '15 days ago', displayPosition: 250 };
    // originalIndex order is deliberately the OPPOSITE of true page order.
    const result = m.sortCommentsChronological([lower, higher]);
    assert.deepEqual(result.map(c => c.body), [higher.body, lower.body]);
  });

  it('falls back to originalIndex when displayPosition is unavailable', () => {
    const a = { author: 'A', body: 'first', timestamp: '3 days ago' };
    const b = { author: 'B', body: 'second', timestamp: '3 days ago' };
    const result = m.sortCommentsChronological([a, b]);
    assert.deepEqual(result.map(c => c.body), ['first', 'second']);
  });

  // Persisted (cached) comments never carry displayPosition (scrape_case.mjs's
  // finalize strips it — it's meaningless across page loads); only a
  // same-pass fresh extraction has it. A tie between one of each must not
  // compare incommensurable positions — fall back to originalIndex.
  it('falls back to originalIndex on a tie between a cached comment (no displayPosition) and a fresh one', () => {
    const cached = { author: 'Cached', body: 'old', timestamp: '3 days ago' };
    const fresh = { author: 'Fresh', body: 'new', timestamp: '3 days ago', displayPosition: 50 };
    const result = m.sortCommentsChronological([cached, fresh]);
    assert.deepEqual(result.map(c => c.body), ['old', 'new']);
  });
});

describe('findCollapsed', () => {
  it('flags a NEW comment still carrying the "Expand Post" control label', () => {
    const fresh = m.assignIds([comment('Alice', 'long body...\n\nExpand Post')]).comments;
    assert.equal(m.findCollapsed(fresh, [fresh[0].id]).length, 1);
  });

  it('ignores an OLD comment left deliberately collapsed (not in newIds)', () => {
    const cached = m.assignIds([comment('Bob', 'old body...\n\nExpand Post')]).comments;
    assert.equal(m.findCollapsed(cached, []).length, 0);
  });

  it('does not false-positive on a body that merely mentions the phrase mid-sentence', () => {
    const fresh = m.assignIds([comment('Alice', 'Please click Expand Post to see more, then reply.')]).comments;
    assert.equal(m.findCollapsed(fresh, [fresh[0].id]).length, 0);
  });
});

describe('countAssert', () => {
  it('blocks an under-capture, allows equal or over (nested replies)', () => {
    assert.equal(m.countAssert(4, 5).ok, false);
    assert.deepEqual(m.countAssert(4, 5), { ok: false, captured: 4, displayed: 5 });
    assert.equal(m.countAssert(5, 5).ok, true);
    assert.equal(m.countAssert(7, 5).ok, true);
  });

  it('persists with a warning when the portal showed no total', () => {
    const r = m.countAssert(3, null);
    assert.equal(r.ok, true);
    assert.match(r.warning, /displayedCommentCount/);
  });
});

describe('parseHeaderFlags', () => {
  it('honours only the header keys, ignoring anything else on the line', () => {
    assert.deepEqual(
      m.parseHeaderFlags(['--merge', '--title', 'NR SA attach', '--status', 'Open', '--nonsense', 'x']),
      { title: 'NR SA attach', status: 'Open' },
    );
  });

  it('ignores a flag with no value and a bare --merge', () => {
    assert.deepEqual(m.parseHeaderFlags(['--merge']), {});
    assert.deepEqual(m.parseHeaderFlags(['--title']), {});
  });
});

describe('commentKey / commentId', () => {
  it('normalizes whitespace and ignores drifting timestamps', () => {
    const a = comment('Alice', '  RRC   reject\nseen ', { timestamp: '2 days ago' });
    const b = comment('Alice', 'RRC reject seen', { timestamp: '3 days ago' });
    assert.equal(m.commentKey(a), m.commentKey(b));
    assert.equal(m.commentId(a), m.commentId(b));
  });

  it('matches a collapsed rendering of the same post (120-char prefix)', () => {
    const full = comment('Bob', 'x'.repeat(200));
    const collapsed = comment('Bob', 'x'.repeat(130));
    assert.equal(m.commentId(full), m.commentId(collapsed));
  });

  it('separates different authors and different bodies', () => {
    assert.notEqual(m.commentId(comment('Alice', 'same')), m.commentId(comment('Bob', 'same')));
    assert.notEqual(m.commentId(comment('Alice', 'one')), m.commentId(comment('Alice', 'two')));
  });
});

describe('assignIds', () => {
  it('is position-independent — a comment keeps its id wherever it now sits in the feed', () => {
    const older = comment('Bob', 'Initial report');
    const newer = comment('Alice', 'RRC reject on n78');
    const first = m.assignIds([newer, older]).comments;
    const afterANewPostArrives = m.assignIds([comment('Carol', 'new'), newer, older]).comments;
    assert.equal(first[0].id, afterANewPostArrives[1].id);
    assert.equal(first[1].id, afterANewPostArrives[2].id);
  });

  it('keeps ambiguous duplicates distinct and reports them', () => {
    const dup = comment('Alice', 'ping');
    const { comments, collisions } = m.assignIds([dup, { ...dup }]);
    assert.equal(comments.length, 2);
    assert.notEqual(comments[0].id, comments[1].id);
    assert.match(comments[1].id, /-2$/);
    assert.equal(collisions.length, 1);
  });

  it('overrides whatever id the extractor supplied', () => {
    const [c] = m.assignIds([comment('Alice', 'body', { id: 'c1' })]).comments;
    assert.notEqual(c.id, 'c1');
    assert.equal(c.id, m.commentId(comment('Alice', 'body')));
  });
});

describe('migrateIds', () => {
  const legacy = {
    comments: [comment('Alice', 'newest', { id: 'c1' }), comment('Bob', 'oldest', { id: 'c2' })],
    enrichment: {
      commentAnalyses: { c1: { summary: 'about newest' }, c2: { summary: 'about oldest' } },
    },
  };

  it('re-keys legacy positional ids onto content ids', () => {
    const out = m.migrateIds(structuredClone(legacy));
    const [newest, oldest] = out.comments;
    assert.equal(newest.id, m.commentId(comment('Alice', 'newest')));
    assert.equal(oldest.id, m.commentId(comment('Bob', 'oldest')));
  });

  it('drops a legacy enrichment field rather than carrying it forward', () => {
    const out = m.migrateIds(structuredClone(legacy));
    assert.equal(out.enrichment, undefined);
  });

  it('is a no-op on a cache already using content ids with no enrichment', () => {
    const once = m.migrateIds(structuredClone(legacy));
    assert.equal(m.migrateIds(once), once);
  });

  it('survives a cache with no enrichment at all', () => {
    assert.equal(m.migrateIds({ comments: [comment('A', 'b', { id: 'c1' })] }).enrichment, undefined);
  });
});

describe('mergeComments', () => {
  const cached = m.assignIds([comment('Bob', 'first', { timestamp: '5 days ago' }), comment('Alice', 'second', { timestamp: '3 days ago' })]).comments;

  it('prepends only genuinely new comments, keeping cached ones verbatim', () => {
    const raw = m.assignIds([comment('Carol', 'third', { timestamp: '1 hour ago' }), comment('Alice', 'second', { timestamp: '3 days ago' })]).comments;
    const { merged, newIds } = m.mergeComments(cached, raw);
    assert.equal(merged.length, 3);
    assert.equal(merged[2].author, 'Carol');
    assert.deepEqual(newIds, [merged[2].id]);
    assert.deepEqual(merged.slice(0, 2), cached);
  });

  it('reports nothing new when the partial capture only re-saw cached posts', () => {
    const raw = m.assignIds([comment('Alice', 'second', { timestamp: '3 days ago' })]).comments;
    const { merged, newIds } = m.mergeComments(cached, raw);
    assert.deepEqual(newIds, []);
    assert.deepEqual(merged, cached);
  });

  it('does not re-add a post that came back truncated in the update capture', () => {
    const long = comment('Dave', 'y'.repeat(300), { timestamp: '1 day ago' });
    const withLong = m.assignIds([...cached, long]).comments;
    const collapsed = m.assignIds([comment('Dave', 'y'.repeat(140), { timestamp: '1 day ago' })]).comments;
    assert.deepEqual(m.mergeComments(withLong, collapsed).newIds, []);
  });

  // I3: an edit to an old comment's body changes its content id, so it reads as
  // a brand new comment on the next merge — silently, with no way for a human
  // to tell "edit" from "genuinely new post" apart. The fix does not guess:
  // both versions are kept (never overwrite verbatim cached content — D9/V4),
  // but a same-author, high-similarity match is surfaced so a human can look.
  it('flags a same-author near-duplicate as a possible edit instead of silently duplicating it', () => {
    const original = m.assignIds([
      comment('Alice', 'RRC reject seen on n78 during the initial attach attempt. QXDM log attached below.', { timestamp: '2 days ago' }),
    ]).comments;
    const edited = m.assignIds([
      comment('Alice', 'RRC reject seen on n78 during the initial attach attempt. QXDM log attached below. Updated per QCOM request.', { timestamp: '1 day ago' }),
    ]).comments;
    const { merged, newIds, possibleEdits } = m.mergeComments(original, edited);
    assert.equal(merged.length, 2, 'both versions are kept — never silently merged or dropped');
    assert.deepEqual(newIds, [edited[0].id]);
    assert.deepEqual(possibleEdits, [{ author: 'Alice', oldId: original[0].id, newId: edited[0].id }]);
  });

  it('does not flag a genuinely different comment by the same author as a possible edit', () => {
    const cached = m.assignIds([
      comment('Alice', 'RRC reject seen on n78 during the initial attach attempt. QXDM log attached below.', { timestamp: '2 days ago' }),
    ]).comments;
    const raw = m.assignIds([
      comment('Alice', 'Please close this case, issue resolved after a firmware update on our end, thank you.', { timestamp: '1 day ago' }),
    ]).comments;
    assert.deepEqual(m.mergeComments(cached, raw).possibleEdits, []);
  });

  it('does not flag a near-duplicate posted by a different author', () => {
    const cached = m.assignIds([
      comment('Alice', 'RRC reject seen on n78 during the initial attach attempt. QXDM log attached below.', { timestamp: '2 days ago' }),
    ]).comments;
    const raw = m.assignIds([
      comment('Bob', 'RRC reject seen on n78 during the initial attach attempt. QXDM log attached below. +1', { timestamp: '1 day ago' }),
    ]).comments;
    assert.deepEqual(m.mergeComments(cached, raw).possibleEdits, []);
  });
});

/* ------------------------- finalize(), for real ------------------------- */

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qc-fin-'));
  mkdirSync(join(root, 'data', 'cases', '08603854'), { recursive: true });
  return root;
}

const casePath = root => join(root, 'data', 'cases', '08603854', 'case.json');

function runFinalize(root, raw, args = []) {
  const rawPath = join(root, 'data', 'cases', '08603854', 'case.raw.json');
  writeFileSync(rawPath, JSON.stringify(raw), 'utf8');
  const r = spawnSync(process.execPath, [SCRIPT, '08603854', rawPath, ...args], {
    encoding: 'utf8', env: { ...process.env, QUALCOMM_ROOT: root },
  });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  return { exit: r.status, verdict: JSON.parse(line || '{}') };
}

const RAW = {
  caseNumber: '08603854', title: 'NR SA attach failure', status: 'Open', priority: 'P2',
  displayedCommentCount: 2,
  comments: [comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago' }), comment('Bob', 'Initial report', { timestamp: '5 days ago' })],
};

describe('finalize (child process)', () => {
  it('writes the canonical case.json and indexes it', () => {
    const root = fixture();
    const { exit, verdict } = runFinalize(root, RAW);
    assert.equal(exit, m.EXIT.OK);
    assert.equal(verdict.commentCount, 2);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.equal(saved.title, 'NR SA attach failure');
    assert.equal(saved.hash, verdict.hash);
    assert.equal(saved.comments[0].id, m.commentId(comment('Bob', 'Initial report', { timestamp: '5 days ago' })));
    assert.equal(saved.comments[1].id, m.commentId(comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago' })));
    const index = JSON.parse(readFileSync(join(root, 'data', 'cases', '_index.json'), 'utf8'));
    assert.equal(index['08603854'].commentCount, 2);
  });

  it('drops a legacy enrichment field on a FULL re-capture of a cached case', () => {
    const root = fixture();
    runFinalize(root, RAW);
    const first = JSON.parse(readFileSync(casePath(root), 'utf8'));
    const aliceId = first.comments.find(c => c.author === 'Alice').id;
    first.enrichment = {
      engineerSummary: 'UE fails SA attach.',
      commentAnalyses: { [aliceId]: { summary: 'RRC reject', role: 'Analysis' } },
      enrichedAt: '2026-07-02T00:00:00.000Z',
    };
    writeFileSync(casePath(root), JSON.stringify(first, null, 2), 'utf8');

    const grown = { ...RAW, displayedCommentCount: 3, comments: [comment('Carol', 'log attached', { timestamp: '1 hour ago' }), ...RAW.comments] };
    const { exit, verdict } = runFinalize(root, grown);

    assert.equal(exit, m.EXIT.OK);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.equal(saved.enrichment, undefined);
    assert.equal(saved.comments.length, 3);
    assert.deepEqual(verdict.newCommentIds, [m.commentId(comment('Carol', 'log attached', { timestamp: '1 hour ago' }))]);
    assert.equal(verdict.newComments, 1);
    const index = JSON.parse(readFileSync(join(root, 'data', 'cases', '_index.json'), 'utf8'));
    assert.equal(index['08603854'].enrichedAt, undefined);
  });

  // A hard open()/reload can reset the Chatter feed to a thinner default view
  // than what was already captured (see run_case.mjs's landOnCase comment).
  // Before the union-merge fix, a FULL (non--merge) re-capture replaced
  // `comments` outright with whatever the fresh extraction found — silently
  // dropping a comment the cache already had confirmed.
  it('does not drop a cached comment when a FULL re-capture comes back thinner', () => {
    const root = fixture();
    runFinalize(root, RAW); // caches both Alice and Bob
    const thinner = { ...RAW, displayedCommentCount: 2, comments: [comment('Bob', 'Initial report', { timestamp: '5 days ago' })] };
    const { exit, verdict } = runFinalize(root, thinner);

    assert.equal(exit, m.EXIT.OK);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.equal(saved.comments.length, 2, 'Alice must survive a thinner full re-capture');
    assert.ok(saved.comments.some(c => c.author === 'Alice'));
    assert.deepEqual(verdict.newCommentIds, [], 'nothing genuinely new — the cache already had both');
  });

  it('migrates a legacy positional-id cache onto content ids, dropping any old enrichment', () => {
    const root = fixture();
    writeFileSync(casePath(root), JSON.stringify({
      ...RAW,
      comments: [{ ...RAW.comments[0], id: 'c1' }, { ...RAW.comments[1], id: 'c2' }],
      hash: 'stale',
      enrichment: { commentAnalyses: { c1: { summary: 'about Alice' }, c2: { summary: 'about Bob' } } },
    }), 'utf8');

    const grown = { ...RAW, displayedCommentCount: 3, comments: [comment('Carol', 'log attached', { timestamp: '1 hour ago' }), ...RAW.comments] };
    runFinalize(root, grown);

    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    const byAuthor = Object.fromEntries(saved.comments.map(c => [c.author, c.id]));
    assert.equal(byAuthor.Alice, m.commentId(comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago' })));
    assert.equal(byAuthor.Bob, m.commentId(comment('Bob', 'Initial report', { timestamp: '5 days ago' })));
    assert.equal(saved.enrichment, undefined);
  });

  it('merges only the new comments on an update run', () => {
    const root = fixture();
    runFinalize(root, RAW);
    const partial = {
      ...RAW, displayedCommentCount: 3,
      comments: [comment('Carol', 'log attached', { timestamp: '1 hour ago' }), comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago' })],
    };
    const { exit, verdict } = runFinalize(root, partial, ['--merge', '--status', 'Closed']);
    assert.equal(exit, m.EXIT.OK);
    assert.equal(verdict.newComments, 1);
    assert.equal(verdict.changed, true);
    assert.equal(verdict.headerChanged, true);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.deepEqual(saved.comments.map(c => c.author), ['Bob', 'Alice', 'Carol']);
    assert.equal(saved.status, 'Closed', 'a fresh header flag is the current truth on an update run');
  });

  it('preserves comment-level analysisLog annotations through update and full re-captures', () => {
    const root = fixture();
    runFinalize(root, RAW);

    // Annotate a cached comment with analysisLog
    const cached = JSON.parse(readFileSync(casePath(root), 'utf8'));
    const alice = cached.comments.find(c => c.author === 'Alice');
    alice.analysisLog = ['QXDM debug trace 0xB0C0', 'Packet capture attached'];
    alice.reviewedBy = 'triage-bot';
    writeFileSync(casePath(root), JSON.stringify(cached, null, 2), 'utf8');

    // 1. Run update (--merge) with a new comment
    const partial = {
      ...RAW, displayedCommentCount: 3,
      comments: [comment('Carol', 'new comment from Qualcomm', { timestamp: '1 hour ago' }), comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago' })],
    };
    const r1 = runFinalize(root, partial, ['--merge']);
    assert.equal(r1.exit, m.EXIT.OK);

    const saved1 = JSON.parse(readFileSync(casePath(root), 'utf8'));
    const aliceComment1 = saved1.comments.find(c => c.author === 'Alice');
    assert.deepEqual(aliceComment1.analysisLog, ['QXDM debug trace 0xB0C0', 'Packet capture attached']);
    assert.equal(aliceComment1.reviewedBy, 'triage-bot');

    // 2. Run full re-capture (no --merge) with all comments
    const fullReCapture = {
      ...RAW, displayedCommentCount: 3,
      comments: [comment('Carol', 'new comment from Qualcomm', { timestamp: '1 hour ago' }), ...RAW.comments],
    };
    const r2 = runFinalize(root, fullReCapture);
    assert.equal(r2.exit, m.EXIT.OK);

    const saved2 = JSON.parse(readFileSync(casePath(root), 'utf8'));
    const aliceComment2 = saved2.comments.find(c => c.author === 'Alice');
    assert.deepEqual(aliceComment2.analysisLog, ['QXDM debug trace 0xB0C0', 'Packet capture attached']);
    assert.equal(aliceComment2.reviewedBy, 'triage-bot');
  });

  it('strips role/company from every comment, even when the cache still carries them', () => {
    const root = fixture();
    runFinalize(root, RAW);

    const cached = JSON.parse(readFileSync(casePath(root), 'utf8'));
    cached.comments = cached.comments.map(c => ({ ...c, role: 'Customer', company: 'Acme Corp' }));
    writeFileSync(casePath(root), JSON.stringify(cached, null, 2), 'utf8');

    // Full re-capture
    const r1 = runFinalize(root, RAW);
    assert.equal(r1.exit, m.EXIT.OK);
    const saved1 = JSON.parse(readFileSync(casePath(root), 'utf8'));
    for (const c of saved1.comments) {
      assert.equal('role' in c, false);
      assert.equal('company' in c, false);
    }

    // Re-poison the cache, then run --merge with a new comment
    const poisoned = JSON.parse(readFileSync(casePath(root), 'utf8'));
    poisoned.comments = poisoned.comments.map(c => ({ ...c, role: 'Customer', company: 'Acme Corp' }));
    writeFileSync(casePath(root), JSON.stringify(poisoned, null, 2), 'utf8');

    const partial = {
      ...RAW, displayedCommentCount: 3,
      comments: [comment('Carol', 'log attached', { timestamp: '1 hour ago' }), comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago' })],
    };
    const r2 = runFinalize(root, partial, ['--merge']);
    assert.equal(r2.exit, m.EXIT.OK);
    const saved2 = JSON.parse(readFileSync(casePath(root), 'utf8'));
    for (const c of saved2.comments) {
      assert.equal('role' in c, false);
      assert.equal('company' in c, false);
    }
  });

  // Issue #42/#43: displayPosition is a within-run sort input (a
  // getBoundingClientRect().top value from ONE extraction pass), not durable
  // case content — it must never reach the persisted case.json, or a later
  // run's tie-break would compare positions measured on different pages.
  it('never persists displayPosition — it is a within-run sort input, not content', () => {
    const root = fixture();
    const raw = {
      ...RAW,
      comments: [
        comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago', displayPosition: 100 }),
        comment('Bob', 'Initial report', { timestamp: '5 days ago', displayPosition: 250 }),
      ],
    };
    const { exit } = runFinalize(root, raw);
    assert.equal(exit, m.EXIT.OK);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    for (const c of saved.comments) {
      assert.equal('displayPosition' in c, false);
    }
  });

  it('reports no change when an update run re-saw the same feed', () => {
    const root = fixture();
    const first = runFinalize(root, RAW);
    const { verdict } = runFinalize(root, RAW, ['--merge']);
    assert.equal(verdict.newComments, 0);
    assert.equal(verdict.changed, false);
    assert.equal(verdict.hash, first.verdict.hash);
  });

  it('refuses a capture that is short, empty or untitled — cache untouched', () => {
    const root = fixture();
    runFinalize(root, RAW);
    const good = readFileSync(casePath(root), 'utf8');

    assert.equal(runFinalize(root, { ...RAW, comments: [] }).exit, m.EXIT.INCOMPLETE);
    assert.equal(runFinalize(root, { ...RAW, displayedCommentCount: 9 }).exit, m.EXIT.INCOMPLETE);
    assert.equal(runFinalize(root, { ...RAW, title: '' }).exit, m.EXIT.INCOMPLETE);

    assert.equal(readFileSync(casePath(root), 'utf8'), good, 'a rejected capture must not touch the cached case');
  });

  it('rejects a full capture whose new comment is still collapsed ("Expand Post" not clicked)', () => {
    const root = fixture();
    const collapsedRaw = {
      ...RAW,
      comments: [comment('Carol', 'long protocol trace...\n\nExpand Post'), ...RAW.comments],
    };
    const { exit, verdict } = runFinalize(root, collapsedRaw);
    assert.equal(exit, m.EXIT.INCOMPLETE);
    assert.deepEqual(verdict.collapsedAuthors, ['Carol']);
  });

  it('does not re-reject an OLD comment that was already cached collapsed', () => {
    const root = fixture();
    // Case already has a cached comment that (from a prior broken run) still
    // ends in "Expand Post" — an update run must not block on it forever,
    // only on GENUINELY NEW comments.
    writeFileSync(casePath(root), JSON.stringify({
      ...RAW, comments: m.assignIds([comment('Dave', 'old trace...\n\nExpand Post'), ...RAW.comments]).comments,
    }), 'utf8');
    const partial = { ...RAW, displayedCommentCount: 3, comments: [comment('Carol', 'a fully expanded new post'), comment('Alice', 'RRC reject on n78')] };
    const { exit, verdict } = runFinalize(root, partial, ['--merge']);
    assert.equal(exit, m.EXIT.OK);
    assert.equal(verdict.newComments, 1);
  });

  it('rejects --merge with no cached case rather than writing a partial one', () => {
    const root = fixture();
    const { exit, verdict } = runFinalize(root, RAW, ['--merge']);
    assert.equal(exit, m.EXIT.BAD_ARGS);
    assert.match(verdict.reason, /no cached case\.json/);
  });

  it('flags colliding comment identities in the verdict', () => {
    const root = fixture();
    const dupes = { ...RAW, displayedCommentCount: 2, comments: [comment('Alice', 'ping'), comment('Alice', 'ping')] };
    const { exit, verdict } = runFinalize(root, dupes);
    assert.equal(exit, m.EXIT.OK);
    assert.equal(verdict.idCollisions, 1);
    assert.equal(verdict.commentCount, 2, 'an ambiguous duplicate is kept, not collapsed');
  });

  it('surfaces a same-author near-duplicate as possibleEdits, keeping both versions', () => {
    const root = fixture();
    runFinalize(root, RAW); // caches Alice's original wording
    const edited = {
      ...RAW, displayedCommentCount: 3,
      comments: [
        comment('Alice', 'RRC reject on n78 - dup'),
        ...RAW.comments,
      ],
    };
    const { exit, verdict } = runFinalize(root, edited, ['--merge']);
    assert.equal(exit, m.EXIT.OK);
    assert.equal(verdict.possibleEdits.length, 1);
    assert.equal(verdict.possibleEdits[0].author, 'Alice');
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.equal(saved.comments.length, 3, 'both the original and the edited version are kept — no silent overwrite');
  });
});
