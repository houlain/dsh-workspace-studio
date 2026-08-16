import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertHunk } from '../src/core/hunkRevert.ts';

const split = (s: string) => (s === '' ? [] : s.split('\n'));

test('revertHunk: 纯插入撤回', () => {
  const before = 'a\nb\nc';
  const after = 'a\nb\nX\nY\nc';
  const current = split(after);
  const r = revertHunk(current, before, after, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, before);
});

test('revertHunk: 纯删除撤回', () => {
  const before = 'a\nX\nY\nb\nc';
  const after = 'a\nb\nc';
  const r = revertHunk(split(after), before, after, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, before);
});

test('revertHunk: 混合替换撤回', () => {
  const before = '1\n2\nold\n3\n4';
  const after = '1\n2\nnew\n3\n4';
  const r = revertHunk(split(after), before, after, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, before);
});

test('revertHunk: 撤回后行号已偏移（后续操作在别处插入）仍可撤回', () => {
  const before = 'a\nb\nc';
  const after = 'a\nb\nX\nc';
  // 后续操作：在文件尾部又插了一行
  const current = split('a\nb\nX\nc\nTAIL');
  const r = revertHunk(current, before, after, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, 'a\nb\nc\nTAIL');
});

test('revertHunk: 同一操作多个 hunk 依次撤回', () => {
  const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10';
  const after = '1\nA\n3\n4\n5\nB\n7\n8\n9\nC';
  const current = split(after);
  const r2 = revertHunk(current, before, after, 2);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  const r1 = revertHunk(split(r2.content), before, after, 1);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  const r0 = revertHunk(split(r1.content), before, after, 0);
  assert.equal(r0.ok, true);
  if (r0.ok) assert.equal(r0.content, before);
});

test('revertHunk: 冲突检测——新增行已被后续修改，拒绝撤回', () => {
  const before = 'a\nb\nc';
  const after = 'a\nb\nX\nc';
  // 后续操作把 X 改成了 Y
  const current = split('a\nb\nY\nc');
  const r = revertHunk(current, before, after, 0);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /覆盖/);
});

test('revertHunk: 冲突检测——删除位置被后续插入填充，拒绝撤回', () => {
  const before = 'a\nX\nb';
  const after = 'a\nb';
  // 后续操作在删除点插入了 Z
  const current = split('a\nZ\nb');
  const r = revertHunk(current, before, after, 0);
  assert.equal(r.ok, false);
});

test('revertHunk: 越界 hunk 索引返回明确错误', () => {
  const before = 'a\nb';
  const after = 'a\nX\nb';
  const r = revertHunk(split(after), before, after, 5);
  assert.equal(r.ok, false);
});

test('revertHunk: 文件头部纯插入撤回', () => {
  const before = 'a\nb';
  const after = 'X\na\nb';
  const r = revertHunk(split(after), before, after, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, before);
});

test('revertHunk: 文件尾部纯插入撤回', () => {
  const before = 'a\nb';
  const after = 'a\nb\nX';
  const r = revertHunk(split(after), before, after, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, before);
});

test('revertHunk: 纯插入且相邻行重复时仍能定位正确位置', () => {
  // 文件中存在两处相同的 "dup" 行，插入发生在第二处之后
  const before = 'dup\ndup\nend';
  const after = 'dup\ndup\nX\nend';
  const r = revertHunk(split(after), before, after, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, before);
});
