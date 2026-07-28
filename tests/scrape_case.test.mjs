// Tests for the finalizer — the module that decides what gets persisted.
//     node --test tests/
//
// Two layers, because the risk sits in both:
//   1. the pure helpers (identity, hashing, merging, gates), imported directly;
//   2. finalize() itself, exercised by SPAWNING the script against a throwaway
//      cache root. finalize() ends in process.exit, so a child process is the
//      honest way to test it — and the P0 it guards (a full re-capture wiping
//      `enrichment`) only shows up through the real file it writes.

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

  it('is stable across runs and ignores enrichment', () => {
    const withAnalysis = { ...base, enrichment: { engineerSummary: 'x', commentAnalyses: { a: {} } } };
    assert.equal(m.computeHash(base), m.computeHash(withAnalysis));
    assert.equal(m.computeHash(base), m.computeHash(structuredClone(base)));
  });

  it('changes when verbatim content changes', () => {
    assert.notEqual(m.computeHash(base), m.computeHash({ ...base, comments: [comment('Alice', 'RRC reject on n41')] }));
    assert.notEqual(
      m.computeHash(base),
      m.computeHash({ ...base, comments: [comment('Alice', 'RRC reject on n78', { analysisLog: ['0xB0C0'] })] }),
    );
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
  it('is position-independent — the P0 that broke enrichment mapping', () => {
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
      commentSummaries: { c1: 'legacy flat' },
      caseFlow: [{ step: 1, what: 'reported', refComments: ['c2'] }],
    },
  };

  it('re-keys comments and every enrichment back-reference together', () => {
    const out = m.migrateIds(structuredClone(legacy));
    const [newest, oldest] = out.comments;
    assert.equal(newest.id, m.commentId(comment('Alice', 'newest')));
    assert.equal(out.enrichment.commentAnalyses[newest.id].summary, 'about newest');
    assert.equal(out.enrichment.commentAnalyses[oldest.id].summary, 'about oldest');
    assert.equal(out.enrichment.commentSummaries[newest.id], 'legacy flat');
    assert.deepEqual(out.enrichment.caseFlow[0].refComments, [oldest.id]);
    assert.equal(Object.keys(out.enrichment.commentAnalyses).includes('c1'), false);
  });

  it('is a no-op on a cache already using content ids', () => {
    const once = m.migrateIds(structuredClone(legacy));
    assert.equal(m.migrateIds(once), once);
  });

  it('survives a cache with no enrichment at all', () => {
    assert.equal(m.migrateIds({ comments: [comment('A', 'b', { id: 'c1' })] }).enrichment, undefined);
  });
});

describe('mergeComments', () => {
  const cached = m.assignIds([comment('Alice', 'second'), comment('Bob', 'first')]).comments;

  it('prepends only genuinely new comments, keeping cached ones verbatim', () => {
    const raw = m.assignIds([comment('Carol', 'third'), comment('Alice', 'second')]).comments;
    const { merged, newIds } = m.mergeComments(cached, raw);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].author, 'Carol');
    assert.deepEqual(newIds, [merged[0].id]);
    assert.deepEqual(merged.slice(1), cached);
  });

  it('reports nothing new when the partial capture only re-saw cached posts', () => {
    const raw = m.assignIds([comment('Alice', 'second')]).comments;
    const { merged, newIds } = m.mergeComments(cached, raw);
    assert.deepEqual(newIds, []);
    assert.deepEqual(merged, cached);
  });

  it('does not re-add a post that came back truncated in the update capture', () => {
    const long = comment('Dave', 'y'.repeat(300));
    const withLong = m.assignIds([long, ...cached]).comments;
    const collapsed = m.assignIds([comment('Dave', 'y'.repeat(140))]).comments;
    assert.deepEqual(m.mergeComments(withLong, collapsed).newIds, []);
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
  comments: [comment('Alice', 'RRC reject on n78'), comment('Bob', 'Initial report')],
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
    assert.equal(saved.comments[0].id, m.commentId(comment('Alice', 'RRC reject on n78')));
    const index = JSON.parse(readFileSync(join(root, 'data', 'cases', '_index.json'), 'utf8'));
    assert.equal(index['08603854'].commentCount, 2);
  });

  // The P0: `--mode full` is the documented remedy when the fast no-update probe
  // may have missed a nested reply. Before this fix it silently replaced the file
  // with the raw capture, destroying every analysis in the case.
  it('preserves enrichment through a FULL re-capture of a cached case', () => {
    const root = fixture();
    runFinalize(root, RAW);
    const first = JSON.parse(readFileSync(casePath(root), 'utf8'));
    const aliceId = first.comments[0].id;
    first.enrichment = {
      engineerSummary: 'UE fails SA attach.',
      caseFlow: [{ step: 1, what: 'symptom', refComments: [first.comments[1].id] }],
      commentAnalyses: { [aliceId]: { summary: 'RRC reject', role: 'Analysis' } },
      enrichedAt: '2026-07-02T00:00:00.000Z',
    };
    writeFileSync(casePath(root), JSON.stringify(first, null, 2), 'utf8');

    const grown = { ...RAW, displayedCommentCount: 3, comments: [comment('Carol', 'log attached'), ...RAW.comments] };
    const { exit, verdict } = runFinalize(root, grown);

    assert.equal(exit, m.EXIT.OK);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.equal(saved.enrichment.engineerSummary, 'UE fails SA attach.');
    assert.equal(saved.enrichment.commentAnalyses[aliceId].summary, 'RRC reject',
      'the cached analysis must re-attach to the SAME comment after a re-capture');
    assert.equal(saved.comments.length, 3);
    // Only the genuinely new comment is offered for analysis.
    assert.deepEqual(verdict.newCommentIds, [m.commentId(comment('Carol', 'log attached'))]);
    assert.equal(verdict.newComments, 1);
    // …and the index still knows the case is analyzed.
    const index = JSON.parse(readFileSync(join(root, 'data', 'cases', '_index.json'), 'utf8'));
    assert.equal(index['08603854'].enrichedAt, '2026-07-02T00:00:00.000Z');
  });

  // A hard open()/reload can reset the Chatter feed to a thinner default view
  // than what was already captured (see run_case.mjs's landOnCase comment).
  // Before the union-merge fix, a FULL (non--merge) re-capture replaced
  // `comments` outright with whatever the fresh extraction found — silently
  // dropping a comment the cache already had confirmed.
  it('does not drop a cached comment when a FULL re-capture comes back thinner', () => {
    const root = fixture();
    runFinalize(root, RAW); // caches both Alice and Bob
    const thinner = { ...RAW, displayedCommentCount: 2, comments: [comment('Bob', 'Initial report')] };
    const { exit, verdict } = runFinalize(root, thinner);

    assert.equal(exit, m.EXIT.OK);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.equal(saved.comments.length, 2, 'Alice must survive a thinner full re-capture');
    assert.ok(saved.comments.some(c => c.author === 'Alice'));
    assert.deepEqual(verdict.newCommentIds, [], 'nothing genuinely new — the cache already had both');
  });

  it('migrates a legacy positional-id cache instead of mis-attaching analyses', () => {
    const root = fixture();
    writeFileSync(casePath(root), JSON.stringify({
      ...RAW,
      comments: [{ ...RAW.comments[0], id: 'c1' }, { ...RAW.comments[1], id: 'c2' }],
      hash: 'stale',
      enrichment: { commentAnalyses: { c1: { summary: 'about Alice' }, c2: { summary: 'about Bob' } } },
    }), 'utf8');

    const grown = { ...RAW, displayedCommentCount: 3, comments: [comment('Carol', 'log attached'), ...RAW.comments] };
    runFinalize(root, grown);

    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    const byAuthor = Object.fromEntries(saved.comments.map(c => [c.author, c.id]));
    assert.equal(saved.enrichment.commentAnalyses[byAuthor.Alice].summary, 'about Alice');
    assert.equal(saved.enrichment.commentAnalyses[byAuthor.Bob].summary, 'about Bob');
    assert.equal(saved.enrichment.commentAnalyses.c1, undefined);
  });

  it('merges only the new comments on an update run', () => {
    const root = fixture();
    runFinalize(root, RAW);
    const partial = {
      ...RAW, displayedCommentCount: 3,
      comments: [comment('Carol', 'log attached'), comment('Alice', 'RRC reject on n78')],
    };
    const { exit, verdict } = runFinalize(root, partial, ['--merge', '--status', 'Closed']);
    assert.equal(exit, m.EXIT.OK);
    assert.equal(verdict.newComments, 1);
    assert.equal(verdict.changed, true);
    assert.equal(verdict.headerChanged, true);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.deepEqual(saved.comments.map(c => c.author), ['Carol', 'Alice', 'Bob']);
    assert.equal(saved.status, 'Closed', 'a fresh header flag is the current truth on an update run');
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
});
