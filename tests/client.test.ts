import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetState } from 'react';
import { apply } from '../src/client/index.ts';
import { buildDiffRows, FileTree, DiffPanel, CodeViewer } from '../src/client/view.ts';
import { apiRevert, apiTree } from '../src/client/api.ts';
import type { Hunk } from '../src/shared/types.ts';

// ── fetch 桩：记录调用，返回 canned JSON ─────────────────────────────
const calls: Array<{ url: string; init?: RequestInit }> = [];
const canned = new Map<string, unknown>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  canned.clear();
  resetState();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const value = canned.get(url) ?? { ok: true, files: [] };
    return { json: async () => value } as Response;
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = originalFetch;
});

// ── 插件入口：槽位注册 ────────────────────────────────────────────────
test('client.apply: 注册 conversation.view 槽位（Studio 标签）', () => {
  const registrations: unknown[] = [];
  const effects: unknown[] = [];
  const ctx = {
    effect: (fn: unknown) => {
      effects.push(fn);
      return undefined;
    },
    slots: {
      inject: (name: string, fn: () => unknown) => {
        if (name === 'conversation.view') registrations.push(fn());
        return undefined;
      },
      register: (desc: unknown, render?: unknown) => ({ desc, render }),
    },
  };
  apply(ctx as never);
  assert.equal(registrations.length, 1);
  const reg = registrations[0] as { desc: { id: string; order: number; label: () => unknown } };
  assert.equal(reg.desc.id, 'studio');
  assert.equal(reg.desc.order, 6);
  assert.ok(effects.length >= 1);
});

// ── API 层：URL 与请求体 ─────────────────────────────────────────────
test('client.api: tree/file/revert 请求正确', async () => {
  canned.set('/ws-studio/tree?root=%2Fwork', [{ name: 'a.cpp', path: '/work/a.cpp', isDir: false }]);
  const tree = await apiTree('/work');
  assert.equal(tree[0].name, 'a.cpp');

  const revert = await apiRevert('s1', '/work/a.cpp', 0, 1);
  assert.deepEqual(revert, { ok: true, files: [] });
  const revertCall = calls.find((c) => c.url.includes('/ws-studio/revert'));
  assert.ok(revertCall);
  assert.equal(revertCall!.init!.method, 'POST');
  assert.equal(revertCall!.init!.body, JSON.stringify({ path: '/work/a.cpp', op: 0, hunk: 1 }));

  await apiRevert('s1', '/work/a.cpp');
  const fileCall = calls.find((c) => c.url.includes('/ws-studio/revert') && c.init!.body === JSON.stringify({ path: '/work/a.cpp', op: null, hunk: null }));
  assert.ok(fileCall, '不带 op/hunk 时应整文件撤回');
});

// ── buildDiffRows：纯函数 ────────────────────────────────────────────
test('client.buildDiffRows: 混合 hunk 展开为 ctx/-/+ 行', () => {
  const hunk: Hunk = {
    oldStart: 2,
    newStart: 2,
    ctxBefore: ['b'],
    ctxAfter: ['d'],
    removed: ['old'],
    added: ['new'],
  };
  const rows = buildDiffRows(hunk);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.oldNo, r.newNo]),
    [
      ['ctx', 2, 2],
      ['del', 3, null],
      ['add', null, 3],
      ['ctx', 4, 4],
    ],
  );
});

test('client.buildDiffRows: 纯删除 hunk', () => {
  const hunk: Hunk = {
    oldStart: 1,
    newStart: 1,
    ctxBefore: ['a'],
    ctxAfter: ['c'],
    removed: ['b'],
    added: [],
  };
  const rows = buildDiffRows(hunk);
  assert.deepEqual(rows.map((r) => r.kind), ['ctx', 'del', 'ctx']);
  assert.equal(rows[1].oldNo, 2);
  assert.equal(rows[1].newNo, null);
});

// ── FileTree 渲染结构 ────────────────────────────────────────────────
test('client.FileTree: 目录可折叠（默认展开第一层），文件可点、选中高亮', () => {
  const tree = [
    {
      name: 'src',
      path: '/work/src',
      isDir: true,
      children: [
        { name: 'main.cpp', path: '/work/src/main.cpp', isDir: false },
        { name: 'deep', path: '/work/src/deep', isDir: true, children: [{ name: 'x.h', path: '/work/src/deep/x.h', isDir: false }] },
      ],
    },
    { name: 'README.md', path: '/work/README.md', isDir: false },
  ];
  const selected: string[] = [];
  const el = FileTree({ tree, selected: '/work/README.md', onSelect: (p) => selected.push(p) }) as {
    props: { children: unknown[] };
  };
  const buttons = collect(el, (n) => n.type === 'button');
  // 第一层目录 src 展开（可见 main.cpp 与 deep 目录头）；deep 默认折叠（x.h 不可见）
  const fileBtns = buttons.filter((b) => b.props.className.includes('wss-tree-file'));
  assert.equal(fileBtns.length, 2); // README.md + main.cpp（deep 折叠，x.h 不渲染）
  const readme = buttons.find((b) => b.props.title === '/work/README.md');
  assert.ok(readme);
  assert.match(readme.props.className, /wss-selected/);
  readme.props.onClick();
  assert.deepEqual(selected, ['/work/README.md']);
  // 目录头可点击折叠/展开
  const srcDir = buttons.find((b) => b.props.title === '/work/src');
  assert.ok(srcDir);
  assert.match(srcDir.props.className, /wss-tree-dir-head/);
  srcDir.props.onClick(); // 切换（桩不重渲染，仅验证回调存在）
  const deepDir = buttons.find((b) => b.props.title === '/work/src/deep');
  assert.ok(deepDir);
});

test('client.FileTree: 已修改文件 ● 标记 + 祖先目录自动展开 + 目录数量角标', () => {
  const tree = [
    {
      name: 'src',
      path: '/work/src',
      isDir: true,
      children: [
        { name: 'main.cpp', path: '/work/src/main.cpp', isDir: false },
        { name: 'deep', path: '/work/src/deep', isDir: true, children: [{ name: 'x.h', path: '/work/src/deep/x.h', isDir: false }] },
      ],
    },
    { name: 'README.md', path: '/work/README.md', isDir: false },
  ];
  const el = FileTree({ tree, selected: null, changedPaths: ['/work/src/deep/x.h'], onSelect: () => undefined });
  const buttons = collect(el, (n) => n.type === 'button');
  // deep 目录因包含已修改文件而自动展开 → x.h 可见且有 ●
  const xh = buttons.find((b) => b.props.title === '/work/src/deep/x.h');
  assert.ok(xh, '包含已修改文件的目录应自动展开');
  assert.match(xh.props.className, /wss-modified/);
  // src 与 deep 目录头显示数量角标
  const badges = collect(el, (n) => String(n.props.className ?? '').includes('wss-dir-badge'));
  assert.equal(badges.length, 2);
  assert.match(collectText(badges[0] as never), /1/);
});

// ── DiffPanel 渲染结构 ───────────────────────────────────────────────
test('client.DiffPanel: 待处理 hunk 有撤回+认可按钮；已撤回/已认可的不再显示差异行', () => {
  const ops = {
    files: [
      {
        path: '/work/a.cpp',
        latestAt: 1,
        pending: true,
        ops: [
          {
            index: 0,
            at: 1,
            turn: 1,
            revertible: true,
            pending: true,
            revertedHunks: [1],
            acceptedHunks: [2],
            added: 3,
            removed: 3,
            hunks: [
              { oldStart: 1, newStart: 1, ctxBefore: [], ctxAfter: [], removed: ['a'], added: ['x'] },
              { oldStart: 2, newStart: 2, ctxBefore: [], ctxAfter: [], removed: ['b'], added: ['y'] },
              { oldStart: 3, newStart: 3, ctxBefore: [], ctxAfter: [], removed: ['c'], added: ['z'] },
            ],
          },
        ],
      },
    ],
  };
  const clicked: Array<[number, number]> = [];
  const accepted: Array<[number, number]> = [];
  const el = DiffPanel({
    ops: ops as never,
    busy: false,
    onRevertHunk: (o, hi) => clicked.push([o, hi]),
    onAcceptHunk: (o, hi) => accepted.push([o, hi]),
    onRevertFile: () => undefined,
  });
  const buttons = collect(el, (n) => n.type === 'button');
  const firstChild = (b: El) => (Array.isArray(b.props.children) ? b.props.children[0] : undefined);
  // hunk0 待处理：有「撤回此块」和「认可」；hunk1 已撤回、hunk2 已认可：均无按钮
  const revertBtns = buttons.filter((b) => firstChild(b) === '撤回此块');
  assert.equal(revertBtns.length, 1);
  const acceptBtns = buttons.filter((b) => firstChild(b) === '认可');
  assert.equal(acceptBtns.length, 1);
  revertBtns[0].props.onClick();
  assert.deepEqual(clicked, [[0, 0]]);
  acceptBtns[0].props.onClick();
  assert.deepEqual(accepted, [[0, 0]]);
  const allBtn = buttons.find((b) => firstChild(b) === '撤回全部修改');
  assert.ok(allBtn);
  // 已处理的块不再渲染差异行（wss-row 只出现在待处理 hunk 里）
  const rows = collect(el, (n) => String(n.props.className ?? '').includes('wss-row'));
  assert.equal(rows.length, 2); // 只有 hunk0 的 del+add 两行
  const text = collectText(el);
  assert.ok(text.includes('已撤回'));
  assert.ok(text.includes('已认可'));
});

// ── CodeViewer ───────────────────────────────────────────────────────
test('client.CodeViewer: 行号 + 截断提示 / 错误提示', () => {
  const ok = CodeViewer({ path: '/work/a.cpp', content: 'a\nb', truncated: true, error: null }) as {
    props: { children: unknown[] };
  };
  const text = collectText(ok);
  assert.ok(text.includes('a'));
  assert.ok(text.includes('（内容过长已截断）'));
  const err = CodeViewer({ path: '/x', content: '', truncated: false, error: '文件过大' });
  assert.ok(collectText(err as { props: { children: unknown[] } }).includes('文件过大'));
});

// ── 辅助：遍历元素树 ─────────────────────────────────────────────────
type El = { type: unknown; props: Record<string, unknown> & { children?: unknown[] } };

function collect(el: unknown, pred: (n: El) => boolean, out: El[] = []): El[] {
  if (el == null || typeof el !== 'object') return out;
  const node = el as El;
  if (typeof node.type === 'string' && pred(node)) out.push(node);
  const kids = node.props?.children;
  if (Array.isArray(kids)) for (const k of kids) collect(k, pred, out);
  else if (kids != null) collect(kids, pred, out);
  return out;
}

function collectText(el: unknown, out: string[] = []): string {
  if (el == null) return out.join(' ');
  if (typeof el === 'string') {
    out.push(el);
    return out.join(' ');
  }
  if (typeof el !== 'object') return out.join(' ');
  const node = el as El;
  for (const v of Object.values(node.props ?? {})) {
    if (typeof v === 'string') out.push(v);
  }
  const kids = node.props?.children;
  if (Array.isArray(kids)) for (const k of kids) collectText(k, out);
  else if (kids != null) collectText(kids, out);
  return out.join(' ');
}
