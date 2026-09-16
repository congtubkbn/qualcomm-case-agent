// Tests for comment_tree.mjs — the sole owner of the Comment Tree shape
// (case.json's nested subs:[] structure). Moved here from
// qcomm_finalize_case.test.mjs and qcomm_render_case.test.mjs when those
// files' own copies of flatten/build/walk were consolidated (#241 follow-up).
//     node --test tests/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  flattenComments,
  buildNestedTree,
  countAllComments,
  findCommentNode,
  cloneCommentTree,
  walkCommentTree,
} from '../.claude/skills/qcomm/scripts/comment_tree.mjs';
import { assignIds } from '../.claude/skills/qcomm/scripts/finalize_identity.mjs';

const comment = (author, body, extra = {}) => ({ author, body, timestamp: '2 days ago', ...extra });

describe('countAllComments', () => {
  it('counts comments recursively through subs', () => {
    const comments = [
      { id: '1', subs: [{ id: '1a', subs: [] }, { id: '1b', subs: [] }] },
      { id: '2', subs: [] },
    ];
    assert.equal(countAllComments(comments), 4);
  });

  it('returns 0 for non-array or empty input', () => {
    assert.equal(countAllComments([]), 0);
    assert.equal(countAllComments(null), 0);
    assert.equal(countAllComments(undefined), 0);
  });
});

describe('buildNestedTree', () => {
  it('returns a flat (no-reply) list unchanged, oldest-first, each with subs:[]', () => {
    const flat = assignIds([
      comment('Alice', 'first', { timestamp: '5 days ago' }),
      comment('Bob', 'second', { timestamp: '3 days ago' }),
      comment('Carol', 'third', { timestamp: '1 day ago' }),
    ]).comments.map(c => ({ ...c, parentId: null }));

    const tree = buildNestedTree(flat);
    assert.deepEqual(tree.map(c => c.author), ['Alice', 'Bob', 'Carol']);
    for (const c of tree) {
      assert.ok(Array.isArray(c.subs), 'subs must be an array');
      assert.equal(c.subs.length, 0);
      assert.equal('parentId' in c, false, 'parentId must not appear in output');
    }
  });

  it('puts replies in their parent\'s subs, oldest-first', () => {
    const withIds = assignIds([
      comment('Alice', 'post 1', { timestamp: '10 days ago' }),
      comment('Bob', 'reply to post 1, early', { timestamp: '9 days ago' }),
      comment('Carol', 'post 2', { timestamp: '5 days ago' }),
      comment('Dave', 'reply to post 1, later', { timestamp: '4 days ago' }),
      comment('Eve', 'reply to post 2', { timestamp: '3 days ago' }),
    ]).comments;
    const [post1, reply1a, post2, reply1b, reply2a] = withIds;
    const flat = [
      { ...post1, parentId: null },
      { ...reply1a, parentId: post1.id },
      { ...post2, parentId: null },
      { ...reply1b, parentId: post1.id },
      { ...reply2a, parentId: post2.id },
    ];

    const tree = buildNestedTree(flat);
    assert.deepEqual(tree.map(c => c.author), ['Alice', 'Carol']);
    assert.deepEqual(tree[0].subs.map(s => s.author), ['Bob', 'Dave']);
    assert.deepEqual(tree[1].subs.map(s => s.author), ['Eve']);
    for (const c of tree) {
      assert.equal('parentId' in c, false);
      for (const s of c.subs) assert.equal('parentId' in s, false);
    }
    for (const s of [...tree[0].subs, ...tree[1].subs]) {
      assert.deepEqual(s.subs, []);
    }
  });

  it('treats a reply whose parent is missing from the array as top-level', () => {
    const flat = assignIds([
      comment('Alice', 'post 1', { timestamp: '2 days ago' }),
      comment('Bob', 'orphan reply', { timestamp: '1 day ago' }),
    ]).comments;
    const tree = buildNestedTree([
      { ...flat[0], parentId: null },
      { ...flat[1], parentId: 'missing-parent-id' },
    ]);
    assert.deepEqual(tree.map(c => c.author), ['Alice', 'Bob']);
    assert.deepEqual(tree[0].subs, []);
    assert.deepEqual(tree[1].subs, []);
  });

  it('returns [] for empty/non-array input', () => {
    assert.deepEqual(buildNestedTree([]), []);
    assert.deepEqual(buildNestedTree(null), []);
  });
});

describe('flattenComments', () => {
  it('is the inverse of buildNestedTree: flatten(build(x)) restores parentId', () => {
    const withIds = assignIds([
      comment('Alice', 'post 1'),
      comment('Bob', 'reply to post 1'),
    ]).comments;
    const [post1, reply1] = withIds;
    const flatIn = [
      { ...post1, parentId: null },
      { ...reply1, parentId: post1.id },
    ];

    const roundTripped = flattenComments(buildNestedTree(flatIn));
    assert.deepEqual(roundTripped, flatIn);
  });

  it('defaults a missing parentId to null', () => {
    const [flat] = flattenComments([{ id: '1', author: 'Alice', subs: [] }]);
    assert.equal(flat.parentId, null);
  });

  it('returns [] for non-array input', () => {
    assert.deepEqual(flattenComments(null), []);
    assert.deepEqual(flattenComments(undefined), []);
  });
});

describe('findCommentNode', () => {
  const tree = [
    { id: 'c1', subs: [{ id: 'c1_1', subs: [] }] },
    { id: 'c2', subs: [] },
  ];

  it('finds a top-level node by id', () => {
    assert.equal(findCommentNode(tree, 'c2'), tree[1]);
  });

  it('finds a nested node by id', () => {
    assert.equal(findCommentNode(tree, 'c1_1'), tree[0].subs[0]);
  });

  it('returns null when no node matches', () => {
    assert.equal(findCommentNode(tree, 'missing'), null);
  });
});

describe('cloneCommentTree', () => {
  it('deep-clones so mutating the clone leaves the original untouched', () => {
    const original = [{ id: 'c1', subs: [{ id: 'c1_1', subs: [] }] }];
    const clone = cloneCommentTree(original);
    clone[0].subs.push({ id: 'c1_2', subs: [] });
    assert.equal(original[0].subs.length, 1);
    assert.equal(clone[0].subs.length, 2);
  });

  it('returns [] for empty/undefined input', () => {
    assert.deepEqual(cloneCommentTree([]), []);
    assert.deepEqual(cloneCommentTree(undefined), []);
  });
});

describe('walkCommentTree', () => {
  it('returns empty array when comments is not an array or is empty', () => {
    assert.deepEqual(walkCommentTree(null), []);
    assert.deepEqual(walkCommentTree(undefined), []);
    assert.deepEqual(walkCommentTree([]), []);
  });

  it('assigns hierarchical numbers and metadata to nested comment trees', () => {
    const tree = [
      {
        id: 'c1',
        author: 'A',
        subs: [
          { id: 'c1_1', author: 'B', subs: [] },
          { id: 'c1_2', author: 'C', subs: [] },
        ],
      },
      {
        id: 'c2',
        author: 'D',
        subs: [{ id: 'c2_1', author: 'E', subs: [] }],
      },
      {
        id: 'c3',
        author: 'F',
        subs: [],
      },
    ];

    const walked = walkCommentTree(tree);
    assert.equal(walked.length, 6);

    assert.equal(walked[0].number, '1');
    assert.equal(walked[0].depth, 0);
    assert.equal(walked[0].isReply, false);
    assert.equal(walked[0].parent, null);
    assert.equal(walked[0].comment.id, 'c1');

    assert.equal(walked[1].number, '1.1');
    assert.equal(walked[1].depth, 1);
    assert.equal(walked[1].isReply, true);
    assert.equal(walked[1].parent, tree[0]);
    assert.equal(walked[1].comment.id, 'c1_1');

    assert.equal(walked[2].number, '1.2');
    assert.equal(walked[2].depth, 1);
    assert.equal(walked[2].isReply, true);
    assert.equal(walked[2].parent, tree[0]);
    assert.equal(walked[2].comment.id, 'c1_2');

    assert.equal(walked[3].number, '2');
    assert.equal(walked[3].depth, 0);
    assert.equal(walked[3].isReply, false);
    assert.equal(walked[3].parent, null);
    assert.equal(walked[3].comment.id, 'c2');

    assert.equal(walked[4].number, '2.1');
    assert.equal(walked[4].depth, 1);
    assert.equal(walked[4].isReply, true);
    assert.equal(walked[4].parent, tree[1]);
    assert.equal(walked[4].comment.id, 'c2_1');

    assert.equal(walked[5].number, '3');
    assert.equal(walked[5].depth, 0);
    assert.equal(walked[5].isReply, false);
    assert.equal(walked[5].parent, null);
    assert.equal(walked[5].comment.id, 'c3');
  });

  it('invokes visitor callback for each node when provided', () => {
    const tree = [
      {
        id: 'c1',
        subs: [{ id: 'c1_1', subs: [] }],
      },
    ];
    const visited = [];
    walkCommentTree(tree, (c, item) => {
      visited.push(`${item.number}:${c.id}`);
    });
    assert.deepEqual(visited, ['1:c1', '1.1:c1_1']);
  });
});
