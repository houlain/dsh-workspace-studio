import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// react 的测试桩（tests/react-stub/shim.mjs）：它把渲染做成独立的一遍，
// 因此能表达错误边界语义；`renderTree` 用来把元素树展开成纯宿主元素。
import * as React from 'react';
import { apply } from '../src/client/index.ts';
import { buildDiffRows, FileTree, DiffPanel, CodeViewer, StudioView, isOpsPayload, createSeqGuard } from '../src/client/view.ts';
import { TRUST_HEADER, apiAccept, apiAcceptAll, apiClear, apiFile, apiRevert, apiTree } from '../src/client/api.ts';
import type { Hunk } from '../src/shared/types.ts';

type StubReact = {
  renderTree?: (el: unknown) => unknown;
  getRenderStats?: () => { boundaryCatches: number };
  resetRenderState?: () => void;
};
const stub = React as unknown as StubReact;

beforeEach(() => {
  stub.resetRenderState?.();
});

// ── fetch 桩：记录调用，返回 canned JSON ─────────────────────────────
interface Canned {
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
}
const calls: Array<{ url: string; init?: RequestInit }> = [];
const canned = new Map<string, Canned>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  canned.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const entry = canned.get(url) ?? { status: 200, body: { ok: true, files: [] } };
    const status = entry.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (entry.jsonThrows) throw new SyntaxError('Unexpected token < in JSON');
        return entry.body ?? { ok: true, files: [] };
      },
    } as unknown as Response;
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = originalFetch;
});

/** 取某个请求带的头（fetch 桩里 init.headers 是普通对象）。 */
function headersOf(call: { init?: RequestInit }): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

// ── 插件入口：槽位注册（契约 §9） ─────────────────────────────────────
function harnessApply(): { desc: Record<string, unknown>; render: (props: { sessionId?: string }) => unknown; effects: unknown[] } {
  let registered: { desc: Record<string, unknown>; render: (props: { sessionId?: string }) => unknown } | undefined;
  const effects: unknown[] = [];
  const ctx = {
    effect: (fn: unknown) => {
      effects.push(fn);
      return undefined;
    },
    slots: {
      inject: (name: string, fn: () => unknown) => {
        if (name === 'conversation.view') fn();
        return undefined;
      },
      register: (desc: Record<string, unknown>, render: (props: { sessionId?: string }) => unknown) => {
        registered = { desc, render };
        return registered;
      },
    },
  };
  apply(ctx as never);
  assert.ok(registered, '必须注册 conversation.view 槽位');
  return { desc: registered!.desc, render: registered!.render, effects };
}

test('client.apply: 注册 conversation.view 槽位（Studio 标签），label() 返回**字符串**', () => {
  const { desc, effects } = harnessApply();
  assert.equal(desc.id, 'studio');
  assert.equal(desc.name, 'conversation.view');
  assert.equal(desc.order, 6);
  // 契约 §9：label 必须返回字符串。返回 React 元素会把宿主整条标签栏渲染成空白。
  const label = desc.label as () => unknown;
  assert.equal(typeof label, 'function');
  assert.equal(typeof label(), 'string');
  assert.equal(label(), 'Studio');
  assert.ok(effects.length >= 1);
});

test('client.apply: register 的 render 被错误边界（类组件）包裹', () => {
  const { render } = harnessApply();
  const wrapped = render({ sessionId: 's1' }) as { type: unknown; props: Record<string, unknown> };
  // 桩是惰性的：这里拿到的是**边界组件元素**，不是 StudioView 本身
  assert.equal(typeof wrapped.type, 'function');
  const proto = (wrapped.type as { prototype?: { isReactComponent?: unknown } }).prototype;
  assert.ok(proto?.isReactComponent, '外层必须是类组件（错误边界），才能接住子组件抛错');
  // 正常路径：边界内渲染出 Studio 视图
  const rendered = renderEl(wrapped);
  assert.match(text(rendered), /Studio/);
});

test('client.react-stub: 子组件渲染抛错 → getDerivedStateFromError → 渲染降级文案', () => {
  const { render } = harnessApply();
  const wrapped = render({ sessionId: 's1' }) as { type: unknown };
  const Boundary = wrapped.type as new (props: unknown) => unknown;
  let derivedCalls = 0;

  class Broken extends React.Component<Record<string, never>, Record<string, never>> {
    static getDerivedStateFromError(): Record<string, never> {
      derivedCalls += 1;
      return {};
    }
    render(): unknown {
      throw new Error('boom');
    }
  }
  class Throwing extends React.Component<Record<string, never>, Record<string, never>> {
    render(): unknown {
      throw new Error('子组件炸了');
    }
  }

  // 用插件真实的边界组件包一个会抛错的子组件：边界应接住并渲染降级文案
  const rendered = renderEl(React.createElement(Boundary, null, React.createElement(Throwing)));
  assert.match(text(rendered), /Studio 渲染失败/, '边界应渲染降级文案');
  assert.equal(stub.getRenderStats?.().boundaryCatches, 1, 'getDerivedStateFromError 必须被调用一次');
  // Broken 只是对照：未挂到边界上时，抛错应向外冒泡
  assert.throws(() => renderEl(React.createElement(Broken)), /boom/);
  assert.equal(derivedCalls, 0);
});

// ── API 层：信任头、错误校验、opId（契约 §2/§3/§8） ─────────────────
test('client.api: 所有请求（读也带）都带信任头 x-dsh-workspace-studio: 1', async () => {
  canned.set('/api/dsh-workspace-studio/tree?root=%2Fwork', { body: [] });
  await apiTree('/work');
  canned.set('/api/dsh-workspace-studio/file?path=%2Fwork%2Fa.cpp', {
    body: { ok: true, content: 'x', truncated: false },
  });
  await apiFile('/work/a.cpp');
  const readCalls = calls.filter((c) => c.init?.method !== 'POST');
  assert.ok(readCalls.length >= 2);
  for (const c of readCalls) {
    assert.equal(headersOf(c)[TRUST_HEADER], '1', `读请求也必须带信任头：${c.url}`);
  }
  // 不带信任头的 GET 也会被宿主拒绝，所以不允许有漏网的读请求
  assert.ok(calls.every((c) => headersOf(c)[TRUST_HEADER] === '1'));
});

test('client.api: tree/file 请求 URL 与请求体正确', async () => {
  canned.set('/api/dsh-workspace-studio/tree?root=%2Fwork', {
    body: [{ name: 'a.cpp', path: '/work/a.cpp', isDir: false }],
  });
  const tree = await apiTree('/work');
  assert.equal(tree[0].name, 'a.cpp');

  const revert = await apiRevert('s1', '/work/a.cpp');
  assert.deepEqual(revert, { ok: true, files: [] });
  const fileCall = calls.find((c) => c.url.includes('/api/dsh-workspace-studio/revert'));
  assert.ok(fileCall);
  assert.equal(fileCall!.init!.method, 'POST');
  // 不带 hunk 的撤回 = 整文件撤回，body 里不带 op/opId
  assert.equal(fileCall!.init!.body, JSON.stringify({ path: '/work/a.cpp' }));
});

test('client.api: 撤回/认可按 opId 定位', async () => {
  canned.set('/api/dsh-workspace-studio/revert?session=s1', { body: { ok: true, message: '已撤回变更块 2' } });
  const reverted = await apiRevert('s1', '/work/a.cpp', 'op-1', 1);
  assert.deepEqual(reverted, { ok: true, message: '已撤回变更块 2' });
  const revertCall = calls.find((c) => c.url.includes('/revert'));
  assert.equal(revertCall!.init!.body, JSON.stringify({ path: '/work/a.cpp', opId: 'op-1', hunk: 1 }));

  canned.set('/api/dsh-workspace-studio/accept?session=s1', { body: { ok: true, message: '已认可变更块 1' } });
  await apiAccept('s1', '/work/a.cpp', 'op-2', 0);
  const acceptCall = calls.find((c) => c.url.includes('/accept?'));
  assert.equal(acceptCall!.init!.body, JSON.stringify({ path: '/work/a.cpp', opId: 'op-2', hunk: 0 }));
});

test('client.api: 块级撤回/认可缺少 opId → 本地拒绝且不发请求', async () => {
  await assert.rejects(() => apiRevert('s1', '/work/a.cpp', null, 0), /opId/);
  await assert.rejects(() => apiAccept('s1', '/work/a.cpp', '', 0), /opId/);
  assert.equal(calls.length, 0, '没有 opId 时不能把请求发出去');
});

test('client.api: HTTP 非 2xx 抛错（不再把错误页当数据）', async () => {
  canned.set('/api/dsh-workspace-studio/tree?root=%2Fwork', {
    status: 403,
    body: { ok: false, error: '该路径不在已注册的工作区内' },
  });
  await assert.rejects(() => apiTree('/work'), /403.*该路径不在已注册的工作区内/);
});

test('client.api: 200 但载荷 ok=false 也抛错', async () => {
  canned.set('/api/dsh-workspace-studio/revert?session=s1', {
    status: 200,
    body: { ok: false, error: '该操作已过期或被清理，请刷新' },
  });
  await assert.rejects(() => apiRevert('s1', '/work/a.cpp', 'gone', 0), /该操作已过期或被清理/);
});

test('client.api: 200 但响应不是 JSON → 抛错', async () => {
  canned.set('/api/dsh-workspace-studio/tree?root=%2Fwork', { status: 200, jsonThrows: true });
  await assert.rejects(() => apiTree('/work'), /不是有效的 JSON/);
});

test('client.api: 一键同意/清空的请求体', async () => {
  canned.set('/api/dsh-workspace-studio/accept-all?session=s1', { body: { ok: true, message: '已认可 2 个变更块' } });
  await apiAcceptAll('s1', '/work/a.cpp');
  const acceptAllCall = calls.find((c) => c.url.includes('/accept-all'));
  assert.equal(acceptAllCall!.init!.body, JSON.stringify({ path: '/work/a.cpp' }));

  canned.set('/api/dsh-workspace-studio/clear?session=s1', { body: { ok: true } });
  await apiClear('s1');
  const clearCall = calls.find((c) => c.url.includes('/clear'));
  assert.equal(clearCall!.init!.body, '{}');
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
  const el = renderEl(FileTree({ tree, selected: '/work/README.md', onSelect: (p) => selected.push(p) }));
  const buttons = collect(el, (n) => n.type === 'button');
  // 第一层目录 src 展开（可见 main.cpp 与 deep 目录头）；deep 默认折叠（x.h 不可见）
  const fileBtns = buttons.filter((b) => String(b.props.className).includes('wss-tree-file'));
  assert.equal(fileBtns.length, 2, 'README.md + main.cpp（deep 折叠，x.h 不渲染）');
  const readme = buttons.find((b) => b.props.title === '/work/README.md');
  assert.ok(readme);
  assert.match(String(readme.props.className), /wss-selected/);
  (readme.props.onClick as () => void)();
  assert.deepEqual(selected, ['/work/README.md']);
  // 目录头可点击折叠/展开
  const srcDir = buttons.find((b) => b.props.title === '/work/src');
  assert.ok(srcDir);
  assert.match(String(srcDir.props.className), /wss-tree-dir-head/);
  (srcDir.props.onClick as () => void)(); // 切换（桩不重渲染，仅验证回调存在）
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
  const el = renderEl(FileTree({ tree, selected: null, changedPaths: ['/work/src/deep/x.h'], onSelect: () => undefined }));
  const buttons = collect(el, (n) => n.type === 'button');
  // deep 目录因包含已修改文件而自动展开 → x.h 可见且有 ●
  const xh = buttons.find((b) => b.props.title === '/work/src/deep/x.h');
  assert.ok(xh, '包含已修改文件的目录应自动展开');
  assert.match(String(xh.props.className), /wss-modified/);
  // src 与 deep 目录头显示数量角标
  const badges = collect(el, (n) => String(n.props.className ?? '').includes('wss-dir-badge'));
  assert.equal(badges.length, 2);
  assert.match(text(badges[0]), /1/);
});

test('client.FileTree: 树数据形状异常不崩溃，给出可读文案（契约 §8）', () => {
  // 宿主出错时可能回 {ok:false,error}；直接 .filter 会把整页渲染成空白
  const bad = FileTree({ tree: { ok: false, error: 'boom' } as never, selected: null, onSelect: () => undefined });
  assert.doesNotThrow(() => renderEl(bad));
  assert.match(text(renderEl(bad)), /文件树数据格式异常/);

  const nullTree = FileTree({ tree: null as never, selected: null, onSelect: () => undefined });
  assert.match(text(renderEl(nullTree)), /文件树数据格式异常/);

  const empty = renderEl(FileTree({ tree: [], selected: null, onSelect: () => undefined }));
  assert.match(text(empty), /没有可显示的文件/);
});

// ── DiffPanel 渲染结构 ───────────────────────────────────────────────
function opsFixture(): unknown {
  return {
    files: [
      {
        path: '/work/a.cpp',
        latestAt: 1,
        pending: true,
        ops: [
          {
            id: 'op-a',
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
}

test('client.DiffPanel: 待处理 hunk 有撤回+认可按钮；已撤回/已认可的不再显示差异行', () => {
  const clicked: Array<[{ opId: string | null; opIndex: number }, number]> = [];
  const accepted: Array<[{ opId: string | null; opIndex: number }, number]> = [];
  const el = renderEl(
    DiffPanel({
      ops: opsFixture() as never,
      busy: false,
      onRevertHunk: (target, hi) => clicked.push([target, hi]),
      onAcceptHunk: (target, hi) => accepted.push([target, hi]),
      onRevertFile: () => undefined,
      onAcceptAll: () => undefined,
    }),
  );
  const buttons = collect(el, (n) => n.type === 'button');
  const firstChild = (b: El) => (Array.isArray(b.props.children) ? (b.props.children as unknown[])[0] : undefined);
  // hunk0 待处理：有「撤回此块」和「认可」；hunk1 已撤回、hunk2 已认可：均无按钮
  const revertBtns = buttons.filter((b) => firstChild(b) === '撤回此块');
  assert.equal(revertBtns.length, 1);
  const acceptBtns = buttons.filter((b) => firstChild(b) === '认可');
  assert.equal(acceptBtns.length, 1);
  (revertBtns[0].props.onClick as () => void)();
  assert.deepEqual(clicked, [[{ opId: 'op-a', opIndex: 0 }, 0]]);
  (acceptBtns[0].props.onClick as () => void)();
  assert.deepEqual(accepted, [[{ opId: 'op-a', opIndex: 0 }, 0]]);
  const allBtn = buttons.find((b) => firstChild(b) === '撤回全部修改');
  assert.ok(allBtn);
  // 已处理的块不再渲染差异行（wss-row 只出现在待处理 hunk 里）
  const rows = collect(el, (n) => String(n.props.className ?? '').includes('wss-row'));
  assert.equal(rows.length, 2, '只有 hunk0 的 del+add 两行');
  const t = text(el);
  assert.ok(t.includes('已撤回'));
  assert.ok(t.includes('已认可'));
});

test('client.DiffPanel: 服务端没下发 id 时 opId 为 null（交给上层拒绝，不退回下标）', () => {
  const fixture = opsFixture() as { files: Array<{ ops: Array<Record<string, unknown>> }> };
  delete fixture.files[0].ops[0].id;
  let got: { opId: string | null } | undefined;
  const el = renderEl(
    DiffPanel({
      ops: fixture as never,
      busy: false,
      onRevertHunk: (target) => {
        got = target;
      },
      onAcceptHunk: () => undefined,
      onRevertFile: () => undefined,
      onAcceptAll: () => undefined,
    }),
  );
  const revertBtn = collect(el, (n) => n.type === 'button').find(
    (b) => (b.props.children as unknown[])[0] === '撤回此块',
  );
  assert.ok(revertBtn);
  (revertBtn!.props.onClick as () => void)();
  assert.equal(got!.opId, null);
});

test('client.DiffPanel: ops 形状异常不崩溃，走空态（契约 §8）', () => {
  // 宿主错误包
  const bad = renderEl(
    DiffPanel({
      ops: { ok: false, error: 'boom' } as never,
      busy: false,
      onRevertHunk: () => undefined,
      onAcceptHunk: () => undefined,
      onRevertFile: () => undefined,
      onAcceptAll: () => undefined,
    }),
  );
  assert.match(text(bad), /暂无改动记录/);
  // files 不是数组
  const bad2 = renderEl(
    DiffPanel({
      ops: { files: 'nope' } as never,
      busy: false,
      onRevertHunk: () => undefined,
      onAcceptHunk: () => undefined,
      onRevertFile: () => undefined,
      onAcceptAll: () => undefined,
    }),
  );
  assert.match(text(bad2), /暂无改动记录/);
  assert.equal(isOpsPayload({ files: [] }), true);
  assert.equal(isOpsPayload({ ok: true }), false);
});

// ── CodeViewer ───────────────────────────────────────────────────────
test('client.CodeViewer: 行号 + 截断提示 / 错误提示', () => {
  const ok = renderEl(CodeViewer({ path: '/work/a.cpp', content: 'a\nb', truncated: true, error: null }));
  const t = text(ok);
  assert.ok(t.includes('a'));
  assert.ok(t.includes('（内容过长已截断）'));
  const err = renderEl(CodeViewer({ path: '/x', content: '', truncated: false, error: '文件过大' }));
  assert.ok(text(err).includes('文件过大'));
});

// ── StudioView：初始空态必须有可读文案（契约 §8） ───────────────────
test('client.StudioView: 无会话/未选文件时渲染可读空态，不抛错', () => {
  const el = renderEl(React.createElement(StudioView, {}));
  const t = text(el);
  assert.ok(t.includes('Studio'));
  assert.ok(t.includes('点击左侧文件查看内容'));
  assert.ok(t.includes('加载中…') || t.includes('工作目录'));
  assert.ok(!t.includes('undefined'));
});

// ── 过期响应守卫（契约 §8：loadSelected 用自增序号丢弃过期响应） ─────
test('client.createSeqGuard: 自增序号让旧响应失效，invalidate 让全部作废', () => {
  const ref = { current: 0 };
  const guard = createSeqGuard(ref);
  const first = guard.next();
  assert.equal(guard.isCurrent(first), true);
  // 第二次请求（切文件）一发起，第一次的响应就过期
  const second = guard.next();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
  // 只刷新不抢序号
  assert.equal(guard.current(), second);
  // 切会话：所有在途响应作废
  guard.invalidate();
  assert.equal(guard.isCurrent(second), false);
  assert.equal(guard.current(), second + 1);
});

test('client.DiffPanel: 快照过大（truncated）的操作显式提示不可撤回（契约 §7）', () => {
  const ops = {
    files: [
      {
        path: '/work/big.bin',
        latestAt: 2,
        pending: false,
        ops: [
          {
            id: 'op-big',
            index: 0,
            at: 2,
            turn: 1,
            truncated: true,
            revertible: false,
            pending: false,
            revertedHunks: [],
            acceptedHunks: [],
            added: 0,
            removed: 0,
            hunks: [],
          },
        ],
      },
    ],
  };
  const el = renderEl(
    DiffPanel({
      ops: ops as never,
      busy: false,
      onRevertHunk: () => undefined,
      onAcceptHunk: () => undefined,
      onRevertFile: () => undefined,
      onAcceptAll: () => undefined,
    }),
  );
  assert.match(text(el), /快照过大，不可撤回/);
});

// ── 辅助：把元素树渲染成宿主元素树后遍历 ─────────────────────────────
type El = { type: unknown; props: Record<string, unknown> & { children?: unknown[] } };

/** 展开惰性元素树（桩提供 renderTree；缺失时按函数组件手工展开作兜底）。 */
function renderEl(el: unknown): unknown {
  if (stub.renderTree) return stub.renderTree(el);
  return fallbackResolve(el);
}

function fallbackResolve(el: unknown): unknown {
  if (el === null || el === undefined || typeof el === 'boolean') return null;
  if (Array.isArray(el)) return el.map(fallbackResolve).filter((x) => x !== null);
  if (typeof el !== 'object') return el;
  const node = el as El;
  if (typeof node.type === 'function') {
    const isClass = !!(node.type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent;
    if (!isClass) return fallbackResolve((node.type as (p: unknown) => unknown)(node.props));
  }
  const kids = node.props?.children;
  return {
    ...node,
    props: { ...node.props, children: Array.isArray(kids) ? kids.map(fallbackResolve).filter((x) => x !== null) : [] },
  };
}

function collect(el: unknown, pred: (n: El) => boolean, out: El[] = []): El[] {
  if (el == null || typeof el !== 'object') return out;
  if (Array.isArray(el)) {
    for (const k of el) collect(k, pred, out);
    return out;
  }
  const node = el as El;
  if (typeof node.type === 'string' && pred(node)) out.push(node);
  const kids = node.props?.children;
  if (Array.isArray(kids)) for (const k of kids) collect(k, pred, out);
  else if (kids != null) collect(kids, pred, out);
  return out;
}

function text(el: unknown, out: string[] = []): string {
  if (el == null) return out.join(' ');
  if (typeof el === 'string' || typeof el === 'number') {
    out.push(String(el));
    return out.join(' ');
  }
  if (Array.isArray(el)) {
    for (const k of el) text(k, out);
    return out.join(' ');
  }
  if (typeof el !== 'object') return out.join(' ');
  const node = el as El;
  for (const v of Object.values(node.props ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
  }
  const kids = node.props?.children;
  if (Array.isArray(kids)) for (const k of kids) text(k, out);
  else if (kids != null) text(kids, out);
  return out.join(' ');
}
