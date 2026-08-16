import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileTree, type FsEntry, type FsReader, DEFAULT_TREE_OPTIONS } from '../src/core/fileTree.ts';

class FakeReader implements FsReader {
  private readonly tree: Record<string, FsEntry[]>;
  constructor(tree: Record<string, FsEntry[]>) {
    this.tree = tree;
  }
  async listDir(path: string): Promise<FsEntry[]> {
    const found = this.tree[path];
    if (!found) throw new Error(`ENOENT: ${path}`);
    return found;
  }
}

const tree: Record<string, FsEntry[]> = {
  '/work': [
    { name: 'src', isDir: true },
    { name: 'README.md', isDir: false },
    { name: 'node_modules', isDir: true },
    { name: '.git', isDir: true },
    { name: 'main.cpp', isDir: false },
  ],
  '/work/src': [
    { name: 'index.ts', isDir: false },
    { name: 'util', isDir: true },
  ],
  '/work/src/util': [{ name: 'str.ts', isDir: false }],
};

test('fileTree: 忽略 .git 与 node_modules', async () => {
  const entries = await buildFileTree('/work', new FakeReader(tree));
  const names = entries.map((e) => e.name);
  assert.deepEqual(names.sort(), ['README.md', 'main.cpp', 'src']);
});

test('fileTree: 递归子目录', async () => {
  const entries = await buildFileTree('/work', new FakeReader(tree));
  const src = entries.find((e) => e.name === 'src')!;
  assert.equal(src.isDir, true);
  assert.deepEqual(src.children!.map((e) => e.name), ['index.ts', 'util']);
  assert.deepEqual(src.children![1].children!.map((e) => e.name), ['str.ts']);
});

test('fileTree: maxEntries 上限生效', async () => {
  const entries = await buildFileTree('/work', new FakeReader(tree), {
    ...DEFAULT_TREE_OPTIONS,
    maxEntries: 1,
  });
  assert.ok(entries.length <= 1);
});

test('fileTree: maxDepth 上限生效（到上限列目录但不继续递归）', async () => {
  const entries = await buildFileTree('/work', new FakeReader(tree), {
    ...DEFAULT_TREE_OPTIONS,
    maxDepth: 1,
  });
  const src = entries.find((e) => e.name === 'src')!;
  // 深度 1 的目录仍列出直接子项，但不再递归
  assert.equal(src.children!.length, 2);
  const util = src.children!.find((e) => e.name === 'util')!;
  assert.deepEqual(util.children, []);
});

test('fileTree: 读取失败目录返回空而非抛错', async () => {
  const reader = new FakeReader({ '/work': [{ name: 'secret', isDir: true }] });
  const entries = await buildFileTree('/work', reader);
  const secret = entries.find((e) => e.name === 'secret')!;
  assert.deepEqual(secret.children, []);
});

test('fileTree: Windows 反斜杠根路径 → 树节点路径归一化为正斜杠', async () => {
  const winTree: Record<string, FsEntry[]> = {
    'E:/work': [
      { name: 'src', isDir: true },
      { name: 'main.cpp', isDir: false },
    ],
    'E:/work/src': [{ name: 'util.h', isDir: false }],
  };
  const reader = new FakeReader(winTree);
  const entries = await buildFileTree('E:\\work', reader);
  const main = entries.find((e) => e.name === 'main.cpp')!;
  assert.equal(main.path, 'E:/work/main.cpp');
  const src = entries.find((e) => e.name === 'src')!;
  assert.equal(src.path, 'E:/work/src');
  assert.equal(src.children![0].path, 'E:/work/src/util.h');
});
