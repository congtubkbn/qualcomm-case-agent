// Tests for the finalizer — the module that decides what gets persisted.
//     node --test tests/
//
// Three layers, because the risk sits in all three:
//   1. the pure helpers (identity, hashing, merging, gates), imported directly;
//   2. finalize()'s gate branches (BAD_ARGS/INCOMPLETE), called in-process and
//      asserted on the returned verdict object directly — finalize() itself
//      never calls process.exit; only the CLI entry-point guard at the bottom
//      of finalize_case.mjs does, after finalize() returns;
//   3. the documented manual CLI contract (`node finalize_case.mjs <CODE> ...`,
//      references/extraction.md), exercised by SPAWNING the script against a
//      throwaway cache root — what it actually persists only shows up through
//      the real file it writes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs', import.meta.url));
const m = await import(new URL('../.claude/skills/qualcomm-case-agent/scripts/finalize_case.mjs', import.meta.url));

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

  // Persisted (cached) comments never carry displayPosition (finalize_case.mjs's
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

describe('countAssert (Issue #91 gate reconciliation)', () => {
  it('blocks an under-capture with error object', () => {
    assert.equal(m.countAssert(4, 5).ok, false);
    assert.deepEqual(m.countAssert(4, 5), { ok: false, captured: 4, displayed: 5 });
  });

  it('allows exact count match without warning', () => {
    const res = m.countAssert(5, 5);
    assert.equal(res.ok, true);
    assert.equal(res.warning, undefined);
  });

  it('allows excess comments with warning documenting nested replies', () => {
    const res = m.countAssert(7, 5);
    assert.equal(res.ok, true);
    assert.equal(res.captured, 7);
    assert.equal(res.displayed, 5);
    assert.match(res.warning, /nested replies/i);
  });

  it('persists with a warning when the portal showed no total', () => {
    const r = m.countAssert(3, null);
    assert.equal(r.ok, true);
    assert.match(r.warning, /displayedCommentCount/);
  });
});

describe('genuineCommentCount', () => {
  it('excludes the synthesized description comment when present', () => {
    const desc = 'UE panics during SA handover.';
    const comments = [comment('Reporter', desc), comment('Alice', 'RRC reject on n78')];
    assert.equal(m.genuineCommentCount(comments, desc), 1);
  });

  it('counts every comment when no synthesized description comment is present', () => {
    const comments = [comment('Alice', 'RRC reject on n78'), comment('Bob', 'Initial report')];
    assert.equal(m.genuineCommentCount(comments, 'Some description never injected'), 2);
    assert.equal(m.genuineCommentCount(comments, ''), 2);
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

describe('extractSummary', () => {
  // Issue #86: this used to be duplicated (a copy in extract_case.js, a
  // separately-drifting copy here) — a fix landed in one and not the other,
  // so the finalize path kept generating "1. 2." previews for numbered
  // descriptions. It is now the single owner: no cross-file duplicate.

  it('keeps numbered-list content instead of degenerating to "1. 2."', () => {
    const body = '1. Insert Optus (505-02) SIM\n2. Put device into Telstra network testing mode';
    const summary = m.extractSummary(body);
    assert.notEqual(summary, '1. 2.');
    assert.equal(summary.includes('Insert Optus (505-02) SIM'), true);
    assert.equal(summary.includes('Put device into Telstra'), true);
  });

  it('does not end a sentence on a dot inside a token (.zip, dotted build version)', () => {
    const body = 'See attached FAILlog_TC1_RTD.zipMPSS.DE.3.1-01301.11-KAILUA_GEN_PACK-1.31422.641 for details.';
    const summary = m.extractSummary(body);
    assert.equal(summary.includes('.zipMPSS.DE.3.1-01301.11-KAILUA_GEN_PACK-1.31422.641'), true);
  });

  // A run of consecutive terminators ("?!") must end together as ONE
  // boundary — splitting them individually leaves a bare "!" fragment that
  // survives the meaningful-sentence filter and silently evicts real content
  // from the slice(0, 2) preview.
  it('treats a run of consecutive terminators ("?!") as one sentence boundary', () => {
    const summary = m.extractSummary('What?! Really. Third.');
    assert.equal(summary, 'What?! Really.');
  });

  it('strips salutations and takes the first 1-2 sentences', () => {
    const summary = m.extractSummary('Dear customer,\n\nThank you for opening the case.\nWe will check and update.');
    assert.equal(summary, 'Thank you for opening the case. We will check and update.');
  });

  it('strips a trailing Expand Post marker from both body and derived summary', () => {
    const summary = m.extractSummary('We are reviewing the trace.\n\nExpand Post');
    assert.equal(summary.includes('Expand Post'), false);
    assert.equal(summary, 'We are reviewing the trace.');
  });

  it('returns empty string for empty or non-string input', () => {
    assert.equal(m.extractSummary(''), '');
    assert.equal(m.extractSummary(null), '');
    assert.equal(m.extractSummary(undefined), '');
  });
});

describe('synthesizeDescriptionComment', () => {
  it('synthesizes a structured initial comment when description is non-empty', () => {
    const raw = {
      contactName: 'Test Contact',
      openedAt: '2026-08-20T10:00:00Z',
      description: 'Dear Qualcomm team,\n\nDevice encounters modem crash during VoNR call setup. Reproduction logs are attached.',
    };
    const c = m.synthesizeDescriptionComment(raw);
    assert.ok(c);
    assert.equal(c.author, 'Test Contact');
    assert.equal(c.timestamp, '2026-08-20T10:00:00Z');
    assert.equal(c.body, raw.description);
    // No summary here: extractSummary is the single owner of preview
    // generation, applied uniformly by finalize() to every persisted
    // comment (see the 'case description injection' tests below).
    assert.equal('summary' in c, false);
    assert.deepEqual(c.attachments, []);
  });

  it('defaults author to "Reporter" and timestamp to empty string when missing', () => {
    const raw = {
      description: 'Simple issue report text.',
    };
    const c = m.synthesizeDescriptionComment(raw);
    assert.ok(c);
    assert.equal(c.author, 'Reporter');
    assert.equal(c.timestamp, '');
    assert.equal(c.body, 'Simple issue report text.');
  });

  it('uses contactName and openedAt when present', () => {
    const raw = {
      contactName: 'Mai Ngoc',
      openedAt: 'August 20, 2026 at 10:00 AM',
      description: 'VoNR registration failure on n78.',
    };
    const c = m.synthesizeDescriptionComment(raw);
    assert.ok(c);
    assert.equal(c.author, 'Mai Ngoc');
    assert.equal(c.timestamp, 'August 20, 2026 at 10:00 AM');
    assert.equal(c.body, raw.description);
  });

  it('returns null for empty or whitespace-only description', () => {
    assert.equal(m.synthesizeDescriptionComment(null), null);
    assert.equal(m.synthesizeDescriptionComment({}), null);
    assert.equal(m.synthesizeDescriptionComment({ description: '' }), null);
    assert.equal(m.synthesizeDescriptionComment({ description: '   \n\t  ' }), null);
  });
});

// Newest-first presentation order supersedes PRD #105-109 ("Variant A": strict
// Oldest -> Newest, no renumbering by thread) — case.json/case.md now show the
// most recent activity first, with each reply grouped immediately after its
// parent (also newest-first among siblings). sortCommentsChronological above
// still runs first and stays ascending — it is the merge/dedup/hash engine;
// this is a separate, final ordering pass applied only to its output.
describe('orderCommentsForPresentation', () => {
  it('reverses a flat (no-reply) ascending list to newest-first', () => {
    const asc = m.assignIds([
      comment('Alice', 'first', { timestamp: '5 days ago' }),
      comment('Bob', 'second', { timestamp: '3 days ago' }),
      comment('Carol', 'third', { timestamp: '1 day ago' }),
    ]).comments.map(c => ({ ...c, parentId: null }));

    const ordered = m.orderCommentsForPresentation(asc);
    assert.deepEqual(ordered.map(c => c.author), ['Carol', 'Bob', 'Alice']);
  });

  it('keeps each reply immediately after its parent, both newest-first', () => {
    const withIds = m.assignIds([
      comment('Alice', 'post 1', { timestamp: '10 days ago' }),
      comment('Bob', 'reply to post 1, early', { timestamp: '9 days ago' }),
      comment('Carol', 'post 2', { timestamp: '5 days ago' }),
      comment('Dave', 'reply to post 1, later', { timestamp: '4 days ago' }),
      comment('Eve', 'reply to post 2', { timestamp: '3 days ago' }),
    ]).comments;
    const [post1, reply1a, post2, reply1b, reply2a] = withIds;
    const asc = [
      { ...post1, parentId: null },
      { ...reply1a, parentId: post1.id },
      { ...post2, parentId: null },
      { ...reply1b, parentId: post1.id },
      { ...reply2a, parentId: post2.id },
    ];

    const ordered = m.orderCommentsForPresentation(asc);
    // Thread order by each POST's own timestamp, newest first: post 2, then post 1.
    // Within a thread, replies newest-first immediately after the post.
    assert.deepEqual(ordered.map(c => c.author), ['Carol', 'Eve', 'Alice', 'Dave', 'Bob']);
  });

  it('treats a reply whose parent is missing from the array as top-level', () => {
    const asc = m.assignIds([
      comment('Alice', 'post 1', { timestamp: '2 days ago' }),
      comment('Bob', 'orphan reply', { timestamp: '1 day ago' }),
    ]).comments;
    const ordered = m.orderCommentsForPresentation([
      { ...asc[0], parentId: null },
      { ...asc[1], parentId: 'missing-parent-id' },
    ]);
    assert.deepEqual(ordered.map(c => c.author), ['Bob', 'Alice']);
  });

  it('returns [] for empty/non-array input', () => {
    assert.deepEqual(m.orderCommentsForPresentation([]), []);
    assert.deepEqual(m.orderCommentsForPresentation(null), []);
  });
});

describe('hasDescriptionComment', () => {
  it('returns true if a comment body matches the description', () => {
    const desc = 'Problem description body';
    const comments = [{ body: 'Other comment' }, { body: '  Problem description body  ' }];
    assert.equal(m.hasDescriptionComment(comments, desc), true);
  });

  it('returns false when no comment matches or description is empty', () => {
    assert.equal(m.hasDescriptionComment([], 'some desc'), false);
    assert.equal(m.hasDescriptionComment([{ body: 'other' }], 'some desc'), false);
    assert.equal(m.hasDescriptionComment([{ body: 'other' }], ''), false);
    assert.equal(m.hasDescriptionComment(null, 'some desc'), false);
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

describe('finalize() — in-process return value (gate branches)', () => {
  // A case code no real Qualcomm case will ever have — these branches read
  // (existsSync/readFileSync) from the real DATA_DIR before returning, since
  // finalize() only accepts a rawPath override, not a full DATA_DIR override.
  // None of them reach the write path (mkdirSync/writeFileSync), so using a
  // nonce code here means these tests never touch anything on real disk.
  const NONCE_CODE = 'TDD-GATE-TEST';

  it('returns BAD_ARGS (not exit) when the raw JSON path does not exist', () => {
    const root = fixture();
    const result = m.finalize(NONCE_CODE, join(root, 'missing.json'));
    assert.equal(result.code, m.EXIT.BAD_ARGS);
    assert.match(result.reason, /raw JSON not found/);
  });

  it('returns BAD_ARGS on malformed raw JSON', () => {
    const root = fixture();
    const rawPath = join(root, 'case.raw.json');
    writeFileSync(rawPath, '{not json', 'utf8');
    const result = m.finalize(NONCE_CODE, rawPath);
    assert.equal(result.code, m.EXIT.BAD_ARGS);
    assert.match(result.reason, /raw JSON parse error/);
  });

  it('returns BAD_ARGS when raw.comments is not an array', () => {
    const root = fixture();
    const rawPath = join(root, 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify({ comments: 'nope' }), 'utf8');
    const result = m.finalize(NONCE_CODE, rawPath);
    assert.equal(result.code, m.EXIT.BAD_ARGS);
    assert.match(result.reason, /must be an array/);
  });

  it('returns INCOMPLETE when the extraction has 0 comments', () => {
    const root = fixture();
    const rawPath = join(root, 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify({ comments: [] }), 'utf8');
    const result = m.finalize(NONCE_CODE, rawPath);
    assert.equal(result.code, m.EXIT.INCOMPLETE);
    assert.match(result.reason, /extracted 0 comments/);
  });

  it('returns BAD_ARGS on --merge with no cached case', () => {
    const root = fixture();
    const rawPath = join(root, 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify(RAW), 'utf8');
    const result = m.finalize(NONCE_CODE, rawPath, {}, true);
    assert.equal(result.code, m.EXIT.BAD_ARGS);
    assert.match(result.reason, /--merge but no cached case\.json/);
  });

  it('returns INCOMPLETE when a new comment is still collapsed ("Expand Post")', () => {
    const root = fixture();
    const rawPath = join(root, 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify({
      ...RAW,
      comments: [comment('Alice', 'long body...\n\nExpand Post')],
    }), 'utf8');
    const result = m.finalize(NONCE_CODE, rawPath);
    assert.equal(result.code, m.EXIT.INCOMPLETE);
    assert.equal(result.collapsedAuthors[0], 'Alice');
  });

  it('returns INCOMPLETE when captured comments fall short of the displayed count', () => {
    const root = fixture();
    const rawPath = join(root, 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify({
      ...RAW,
      displayedCommentCount: 5,
      comments: [comment('Alice', 'only one comment captured')],
    }), 'utf8');
    const result = m.finalize(NONCE_CODE, rawPath);
    assert.equal(result.code, m.EXIT.INCOMPLETE);
    assert.equal(result.captured, 1);
    assert.equal(result.displayed, 5);
  });

  it('returns INCOMPLETE when title is empty', () => {
    const root = fixture();
    const rawPath = join(root, 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify({ ...RAW, title: '' }), 'utf8');
    const result = m.finalize(NONCE_CODE, rawPath);
    assert.equal(result.code, m.EXIT.INCOMPLETE);
    assert.match(result.reason, /empty title/);
  });
});

describe('finalize (child process)', () => {
  it('writes the canonical case.json and indexes it', () => {
    const root = fixture();
    const { exit, verdict } = runFinalize(root, RAW);
    assert.equal(exit, m.EXIT.OK);
    assert.equal(verdict.commentCount, 2);
    const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
    assert.equal(saved.title, 'NR SA attach failure');
    assert.equal(saved.hash, verdict.hash);
    assert.equal(saved.comments[0].id, m.commentId(comment('Alice', 'RRC reject on n78', { timestamp: '2 days ago' })));
    assert.equal(saved.comments[1].id, m.commentId(comment('Bob', 'Initial report', { timestamp: '5 days ago' })));
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
    assert.deepEqual(saved.comments.map(c => c.author), ['Carol', 'Alice', 'Bob']);
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

  describe('case description injection', () => {
    it('injects non-empty description as initial comment in case.json with accurate metadata', () => {
      const root = fixture();
      const rawWithDesc = {
        ...RAW,
        contactName: 'Acme Corp',
        openedAt: 'August 15, 2026 at 9:00 AM',
        description: 'Device crashes during 5G SA handover. Please find attached reproduction logs.',
      };
      const { exit, verdict } = runFinalize(root, rawWithDesc);
      assert.equal(exit, m.EXIT.OK);
      assert.equal(verdict.commentCount, 3); // 2 chatter + 1 description

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.comments.length, 3);
      const descComment = saved.comments[saved.comments.length - 1]; // Chronologically first -> now last (newest-first presentation order)
      assert.equal(descComment.author, 'Acme Corp');
      assert.equal(descComment.timestamp, new Date(Date.parse('August 15, 2026 9:00 AM')).toISOString());
      assert.equal(descComment.rawTimestamp, 'August 15, 2026 at 9:00 AM');
      assert.equal(descComment.body, rawWithDesc.description);
      assert.equal(descComment.summary, 'Device crashes during 5G SA handover. Please find attached reproduction logs.');
      assert.deepEqual(descComment.attachments, []);
      assert.match(descComment.id, /^c[a-f0-9]{12}$/);
      assert.equal(saved.description, rawWithDesc.description, 'retains root description for backward compatibility');
    });

    it('falls back to "Reporter" and empty timestamp when contactName and openedAt are absent', () => {
      const root = fixture();
      const rawWithDesc = {
        ...RAW,
        contactName: '',
        openedAt: '',
        description: 'Simple problem description without metadata.',
      };
      const { exit } = runFinalize(root, rawWithDesc);
      assert.equal(exit, m.EXIT.OK);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      const descComment = saved.comments[saved.comments.length - 1]; // oldest -> now last (newest-first presentation order)
      assert.equal(descComment.author, 'Reporter');
      assert.equal(descComment.timestamp, '');
      assert.equal(descComment.body, rawWithDesc.description);
    });

    it('does not create blank comments for empty or whitespace-only description', () => {
      const root = fixture();
      const rawEmptyDesc = {
        ...RAW,
        description: '   \n\t  ',
      };
      const { exit, verdict } = runFinalize(root, rawEmptyDesc);
      assert.equal(exit, m.EXIT.OK);
      assert.equal(verdict.commentCount, 2);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.comments.length, 2);
      assert.ok(!saved.comments.some(c => !c.body.trim()));
    });

    it('does not duplicate description comment across repeated --merge invocations', () => {
      const root = fixture();
      const initialRaw = {
        ...RAW,
        contactName: 'Acme Corp',
        openedAt: 'August 18, 2026 at 9:00 AM',
        description: 'UE fails to attach to cell.',
      };
      const r1 = runFinalize(root, initialRaw);
      assert.equal(r1.exit, m.EXIT.OK);
      assert.equal(r1.verdict.commentCount, 3);

      // Subsequent update run with same or empty description
      const updateRaw = {
        ...initialRaw,
        displayedCommentCount: 3,
        comments: [
          comment('Dave', 'New response from QCOM', { timestamp: '1 hour ago' }),
          ...RAW.comments,
        ],
      };
      const r2 = runFinalize(root, updateRaw, ['--merge']);
      assert.equal(r2.exit, m.EXIT.OK);
      assert.equal(r2.verdict.newComments, 1);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.comments.length, 4); // 1 desc + 2 original chatter + 1 new chatter
      const descOccurrences = saved.comments.filter(c => c.body === 'UE fails to attach to cell.');
      assert.equal(descOccurrences.length, 1, 'description comment must not be duplicated');
    });
  });

  describe('Salesforce Detail metadata persistence', () => {
    it('persists all extracted Detail fields into canonical case.json on full capture', () => {
      const root = fixture();
      const rawWithDetail = {
        ...RAW,
        contactName: 'Mai Ngoc',
        customerProject: 'VinFast VF9 MY26',
        customerTracking: 'CT-9988',
        openedAt: 'August 10, 2026 at 09:30 AM',
        closedAt: 'August 20, 2026 at 04:15 PM',
        accountName: 'VinFast Auto LLC',
        relatedCRs: 'CR3798678, CR3801234',
        caseRecordType: 'Customer Support',
        description: 'VoNR call drops during 5G SA to EPS Fallback transition.',
      };
      const { exit } = runFinalize(root, rawWithDetail);
      assert.equal(exit, m.EXIT.OK);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.contactName, 'Mai Ngoc');
      assert.equal(saved.customerProject, 'VinFast VF9 MY26');
      assert.equal(saved.customerTracking, 'CT-9988');
      assert.equal(saved.openedAt, 'August 10, 2026 at 09:30 AM');
      assert.equal(saved.closedAt, 'August 20, 2026 at 04:15 PM');
      assert.equal(saved.accountName, 'VinFast Auto LLC');
      assert.equal(saved.relatedCRs, 'CR3798678, CR3801234');
      assert.equal(saved.caseRecordType, 'Customer Support');
      assert.equal(saved.description, 'VoNR call drops during 5G SA to EPS Fallback transition.');

      // Description comment author should be Contact Name — oldest -> now last (newest-first presentation order)
      const descComment = saved.comments[saved.comments.length - 1];
      assert.equal(descComment.author, 'Mai Ngoc');
      assert.equal(descComment.timestamp, new Date(Date.parse('August 10, 2026 09:30 AM')).toISOString());
      assert.equal(descComment.rawTimestamp, 'August 10, 2026 at 09:30 AM');
    });

    it('preserves cached Detail metadata during partial update (--merge) runs', () => {
      const root = fixture();
      const initialDetail = {
        ...RAW,
        contactName: 'Mai Ngoc',
        customerProject: 'VinFast VF9 MY26',
        customerTracking: 'CT-9988',
        openedAt: 'August 10, 2026 at 09:30 AM',
        closedAt: 'August 20, 2026 at 04:15 PM',
        accountName: 'VinFast Auto LLC',
        relatedCRs: 'CR3798678',
        caseRecordType: 'Customer Support',
        description: 'VoNR call drops during 5G SA.',
      };
      const r1 = runFinalize(root, initialDetail);
      assert.equal(r1.exit, m.EXIT.OK);

      // Thinner update capture (e.g. feed only without Detail tab re-extraction)
      const updateRaw = {
        caseNumber: RAW.caseNumber,
        title: RAW.title,
        displayedCommentCount: 3,
        comments: [
          comment('Engineer', 'New update comment', { timestamp: '1 hour ago' }),
          ...RAW.comments,
        ],
      };
      const r2 = runFinalize(root, updateRaw, ['--merge']);
      assert.equal(r2.exit, m.EXIT.OK);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.contactName, 'Mai Ngoc');
      assert.equal(saved.customerProject, 'VinFast VF9 MY26');
      assert.equal(saved.customerTracking, 'CT-9988');
      assert.equal(saved.openedAt, 'August 10, 2026 at 09:30 AM');
      assert.equal(saved.closedAt, 'August 20, 2026 at 04:15 PM');
      assert.equal(saved.accountName, 'VinFast Auto LLC');
      assert.equal(saved.relatedCRs, 'CR3798678');
      assert.equal(saved.caseRecordType, 'Customer Support');
      assert.equal(saved.description, 'VoNR call drops during 5G SA.');
    });

    it('derives parentId correctly for 1 post and 3 replies', () => {
      const root = fixture();
      const rawThread = {
        caseNumber: '08633581',
        title: 'Crash during handover',
        comments: [
          { author: 'Alice', body: 'Post 1', timestamp: '2026-08-10T10:00:00Z', parentIndex: null },
          { author: 'Bob', body: 'Reply 1a', timestamp: '2026-08-10T11:00:00Z', parentIndex: 0 },
          { author: 'Charlie', body: 'Reply 1b', timestamp: '2026-08-10T12:00:00Z', parentIndex: 0 },
          { author: 'Alice', body: 'Reply 1c', timestamp: '2026-08-10T13:00:00Z', parentIndex: 0 },
        ],
      };
      const { exit } = runFinalize(root, rawThread);
      assert.equal(exit, m.EXIT.OK);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.comments.length, 4);
      assert.equal(saved.comments[0].parentId, null);
      const post1Id = saved.comments[0].id;
      assert.equal(saved.comments[1].parentId, post1Id);
      assert.equal(saved.comments[2].parentId, post1Id);
      assert.equal(saved.comments[3].parentId, post1Id);
      assert.equal('parentIndex' in saved.comments[1], false);
      assert.equal('isReply' in saved.comments[1], false);
    });

    it('resolves parentId on a 2-phase capture (--merge)', () => {
      const root = fixture();
      const initialCapture = {
        caseNumber: '08633581',
        title: 'Crash during handover',
        comments: [
          { author: 'Alice', body: 'Post 1', timestamp: '2026-08-10T10:00:00Z', parentIndex: null },
        ],
      };
      const r1 = runFinalize(root, initialCapture);
      assert.equal(r1.exit, m.EXIT.OK);

      const updateCapture = {
        caseNumber: '08633581',
        title: 'Crash during handover',
        comments: [
          { author: 'Alice', body: 'Post 1', timestamp: '2026-08-10T10:00:00Z', parentIndex: null },
          { author: 'Bob', body: 'Reply 1a', timestamp: '2026-08-10T11:00:00Z', parentIndex: 0 },
        ],
      };
      const r2 = runFinalize(root, updateCapture, ['--merge']);
      assert.equal(r2.exit, m.EXIT.OK);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.comments.length, 2);
      const post1 = saved.comments.find(c => c.body === 'Post 1');
      const reply1a = saved.comments.find(c => c.body === 'Reply 1a');
      assert.equal(post1.parentId, null);
      assert.equal(reply1a.parentId, post1.id);
    });
  });

  describe('Chatter relative timestamp normalization (Issue #87)', () => {
    it('resolves relative timestamps at capture time to absolute ISO strings and stores rawTimestamp', () => {
      const root = fixture();
      const captureTime = '2026-08-22T12:00:00.000Z';
      const rawWithRelative = {
        caseNumber: '08603854',
        title: 'NR SA attach failure',
        status: 'Open',
        priority: 'P2',
        displayedCommentCount: 2,
        comments: [
          comment('Carol', 'newer post', { timestamp: '1 hour ago' }),
          comment('Bob', 'older post', { timestamp: '5 days ago' }),
        ],
      };

      const { exit, verdict } = runFinalize(root, rawWithRelative, ['--ref-date', captureTime]);
      assert.equal(exit, m.EXIT.OK);
      assert.equal(verdict.commentCount, 2);

      const saved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(saved.comments.length, 2);

      // Comment 0 = Carol (1 hour before 2026-08-22T12:00:00Z) — newest-first presentation order
      const expectedCarolTs = new Date(Date.parse(captureTime) - 3600 * 1000).toISOString();
      assert.equal(saved.comments[0].author, 'Carol');
      assert.equal(saved.comments[0].timestamp, expectedCarolTs);
      assert.equal(saved.comments[0].rawTimestamp, '1 hour ago');

      // Comment 1 = Bob (5 days before 2026-08-22T12:00:00Z)
      const expectedBobTs = new Date(Date.parse(captureTime) - 5 * 86400 * 1000).toISOString();
      assert.equal(saved.comments[1].author, 'Bob');
      assert.equal(saved.comments[1].timestamp, expectedBobTs);
      assert.equal(saved.comments[1].rawTimestamp, '5 days ago');
    });

    it('unchanged Case re-captured after simulated passage of time yields identical comment order and reports no-update', () => {
      const root = fixture();
      const initialCaptureTime = '2026-08-10T12:00:00.000Z';
      const initialRaw = {
        caseNumber: '08603854',
        title: 'NR SA attach failure',
        status: 'Open',
        priority: 'P2',
        displayedCommentCount: 2,
        comments: [
          comment('Carol', 'investigating', { timestamp: '2 days ago' }),
          comment('Bob', 'initial problem report', { timestamp: '6 days ago' }),
        ],
      };

      // 1. Initial capture
      const r1 = runFinalize(root, initialRaw, ['--ref-date', initialCaptureTime]);
      assert.equal(r1.exit, m.EXIT.OK);

      const initialSaved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      const initialOrder = initialSaved.comments.map(c => c.author);
      const initialHash = initialSaved.hash;

      // 2. Simulated passage of time (10 days later, portal now renders "12 days ago" and "16 days ago")
      const laterCaptureTime = '2026-08-20T12:00:00.000Z';
      const laterRaw = {
        caseNumber: '08603854',
        title: 'NR SA attach failure',
        status: 'Open',
        priority: 'P2',
        displayedCommentCount: 2,
        comments: [
          comment('Carol', 'investigating', { timestamp: '12 days ago' }),
          comment('Bob', 'initial problem report', { timestamp: '16 days ago' }),
        ],
      };

      // Re-capture in full mode
      const r2 = runFinalize(root, laterRaw, ['--ref-date', laterCaptureTime]);
      assert.equal(r2.exit, m.EXIT.OK);
      assert.equal(r2.verdict.changed, false, 'Hash must not change on unchanged case after time passage');
      assert.equal(r2.verdict.newComments, 0, 'No new comments should be reported');
      assert.deepEqual(r2.verdict.newCommentIds, []);

      const laterSaved = JSON.parse(readFileSync(casePath(root), 'utf8'));
      assert.equal(laterSaved.hash, initialHash);
      assert.deepEqual(laterSaved.comments.map(c => c.author), initialOrder, 'Comment ordering must not drift');
    });
  });
});

describe('finalize (child process): dashboard render isolation', () => {
  // dashboard.html pre-created as a directory forces renderDashboardHtml's
  // writeFileSync to throw EISDIR — a real-world stand-in for any HTML
  // rendering bug (#141/#143: render failures must not crash capture).
  it('still writes _overview.json and succeeds when the dashboard render throws', () => {
    const root = fixture();
    mkdirSync(join(root, 'data', 'cases', 'dashboard.html'), { recursive: true });

    const rawPath = join(root, 'data', 'cases', '08603854', 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify(RAW), 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, '08603854', rawPath], {
      encoding: 'utf8', env: { ...process.env, QUALCOMM_ROOT: root },
    });
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    const verdict = JSON.parse(line || '{}');

    assert.equal(r.status, m.EXIT.OK, r.stderr);
    assert.equal(verdict.commentCount, 2);
    assert.match(r.stderr, /Warning: dashboard render failed/);

    const overview = JSON.parse(readFileSync(join(root, 'data', 'cases', '_overview.json'), 'utf8'));
    assert.equal(overview.cases[0].caseNumber, '08603854');
  });

  it('creates and synchronizes _overview.json and dashboard.html on successful capture finalization', () => {
    const root = fixture();
    const rawPath = join(root, 'data', 'cases', '08603854', 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify(RAW), 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT, '08603854', rawPath], {
      encoding: 'utf8', env: { ...process.env, QUALCOMM_ROOT: root },
    });
    assert.equal(r.status, m.EXIT.OK, r.stderr);

    const overviewFile = join(root, 'data', 'cases', '_overview.json');
    const dashboardFile = join(root, 'data', 'cases', 'dashboard.html');
    assert.equal(existsSync(overviewFile), true);
    assert.equal(existsSync(dashboardFile), true);

    const overview = JSON.parse(readFileSync(overviewFile, 'utf8'));
    assert.equal(overview.cases.length, 1);
    assert.equal(overview.cases[0].caseNumber, '08603854');
    assert.equal(overview.cases[0].title, 'NR SA attach failure');
  });

  it('invokes dependency-injected syncCaseOverview option when finalizing', () => {
    const root = fixture();
    const rawPath = join(root, 'data', 'cases', '08603854', 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify(RAW), 'utf8');

    let syncCalledWith = null;
    const result = m.finalize('08603854', rawPath, {}, false, {
      casesDir: join(root, 'data', 'cases'),
      syncCaseOverview: (code, opts) => {
        syncCalledWith = { code, opts };
        return { hadEntry: true, overviewData: {}, rendered: true };
      },
    });

    assert.equal(result.code, m.EXIT.OK);
    assert.ok(syncCalledWith);
    assert.equal(syncCalledWith.code, '08603854');
    assert.equal(syncCalledWith.opts.action, 'upsert');
    assert.equal(syncCalledWith.opts.casesDir, join(root, 'data', 'cases'));
  });

  // Regression: options.casesDir used to reach only afterFinalize() (the
  // overview sync above) — the actual case.json/_index.json read+write still
  // went through the module-level DATA_DIR. Any in-process finalize() call
  // using a case code that happens to match a REAL cached case (as every test
  // in this file does — "08603854") silently overwrote that real capture with
  // test fixture data. Confirmed happening against a real checkout before the
  // fix; this pins casesDir as the sole source of truth for both paths.
  it('writes case.json and _index.json under options.casesDir, never under the real DATA_DIR', () => {
    const root = fixture();
    const rawPath = join(root, 'data', 'cases', '08603854', 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify(RAW), 'utf8');
    const isolatedCasesDir = join(root, 'data', 'cases');

    const result = m.finalize('08603854', rawPath, {}, false, { casesDir: isolatedCasesDir });

    assert.equal(result.code, m.EXIT.OK);
    assert.equal(result.path, join(isolatedCasesDir, '08603854', 'case.json'));
    assert.equal(existsSync(join(isolatedCasesDir, '08603854', 'case.json')), true);
    assert.equal(existsSync(join(isolatedCasesDir, '_index.json')), true);

    const realDataDir = fileURLToPath(new URL('../data/cases', import.meta.url));
    if (existsSync(join(realDataDir, '08603854', 'case.json'))) {
      const real = JSON.parse(readFileSync(join(realDataDir, '08603854', 'case.json'), 'utf8'));
      assert.notEqual(real.title, 'NR SA attach failure', 'the real cached case must be untouched by this in-process call');
    }
  });

  it('warns and continues when syncCaseOverview throws an error', (t) => {
    const root = fixture();
    const rawPath = join(root, 'data', 'cases', '08603854', 'case.raw.json');
    writeFileSync(rawPath, JSON.stringify(RAW), 'utf8');
    const writeSpy = t.mock.method(process.stderr, 'write');

    const result = m.finalize('08603854', rawPath, {}, false, {
      casesDir: join(root, 'data', 'cases'),
      syncCaseOverview: () => {
        throw new Error('simulated sync crash');
      },
    });

    assert.equal(result.code, m.EXIT.OK);
    const warnings = writeSpy.mock.calls.map((c) => c.arguments[0]).join('');
    assert.match(warnings, /Warning: overview auto-sync failed \(simulated sync crash\)/);
  });
});



