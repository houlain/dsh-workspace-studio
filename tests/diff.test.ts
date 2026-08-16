import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffHunks } from '../src/core/diff.ts';

const split = (s: string) => (s === '' ? [] : s.split('\n'));

test('diffLines: 无变化返回空', () => {
  assert.deepEqual(diffLines(split('a\nb\nc'), split('a\nb\nc')), []);
});

test('diffLines: 两侧全空返回空', () => {
  assert.deepEqual(diffLines([], []), []);
});

test('diffLines: 纯插入（中部）', () => {
  const blocks = diffLines(split('a\nb\nc'), split('a\nx\ny\nb\nc'));
  assert.equal(blocks.length, 1);
  const [b] = blocks;
  assert.equal(b.removed.length, 0);
  assert.deepEqual(b.added, ['x', 'y']);
  assert.equal(b.oldStart, 2); // 插入点在 b 的第 2 行之后
  assert.equal(b.oldEnd, 1);
  assert.equal(b.newStart, 2);
  assert.equal(b.newEnd, 3);
});

test('diffLines: 纯删除', () => {
  const blocks = diffLines(split('a\nx\ny\nb'), split('a\nb'));
  assert.equal(blocks.length, 1);
  const [b] = blocks;
  assert.equal(b.added.length, 0);
  assert.deepEqual(b.removed, ['x', 'y']);
});

test('diffLines: 替换（混合）', () => {
  const blocks = diffLines(split('a\nold\nb'), split('a\nnew\nb'));
  assert.equal(blocks.length, 1);
  const [b] = blocks;
  assert.deepEqual(b.removed, ['old']);
  assert.deepEqual(b.added, ['new']);
  assert.equal(b.oldStart, 2);
  assert.equal(b.newStart, 2);
});

test('diffLines: 多处不相邻变更', () => {
  const blocks = diffLines(split('1\n2\n3\n4\n5\n6\n7\n8'), split('1\nX\n3\n4\nY\n6\n7\nZ'));
  assert.equal(blocks.length, 3);
});

test('diffLines: 尾部插入', () => {
  const blocks = diffLines(split('a\nb'), split('a\nb\nc\nd'));
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].added, ['c', 'd']);
  assert.equal(blocks[0].oldStart, 3);
  assert.equal(blocks[0].newStart, 3);
});

test('diffLines: 头部插入', () => {
  const blocks = diffLines(split('a\nb'), split('x\na\nb'));
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].added, ['x']);
  assert.equal(blocks[0].oldStart, 1);
  assert.equal(blocks[0].oldEnd, 0);
});

test('diffHunks: 上下文边界与内容（替换按 LCS 呈现为插入）', () => {
  const before = split('1\n2\n3\n4\n5\n6\n7\n8\n9');
  const after = split('1\n2\n3\n4\n5\nX\n6\n7\n8\n9');
  const hunks = diffHunks(before, after);
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  // LCS 的最优解是"在 5 之后插入 X"（编辑距离 1），而非"删 5 插 X"
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.added, ['X']);
  assert.deepEqual(h.ctxBefore, ['3', '4', '5']);
  assert.deepEqual(h.ctxAfter, ['6', '7', '8']);
  assert.equal(h.oldStart, 3);
  assert.equal(h.newStart, 3);
});

test('diffHunks: 文件头部变更时上下文被裁剪', () => {
  const before = split('a\nb\nc\nd\ne');
  const after = split('X\nb\nc\nd\ne');
  const hunks = diffHunks(before, after);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].ctxBefore, []);
  assert.equal(hunks[0].oldStart, 1);
});

test('diffLines: 完全不同的文件退化为一个大块', () => {
  const blocks = diffLines(split('a\nb'), split('x\ny\nz'));
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].removed, ['a', 'b']);
  assert.deepEqual(blocks[0].added, ['x', 'y', 'z']);
});
