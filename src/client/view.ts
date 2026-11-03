// 浏览器半侧视图：Studio 标签页（文件树 → 代码查看 → 改动 diff → hunk 级撤回）。
// 使用 createElement 风格，零 JSX 依赖；组件均为纯函数，便于结构测试。

import * as React from 'react';
import type { FileEntry, FileOpsView, Hunk, OpView, OpsPayload, ReadResult, RevertResult, SessionContext } from '../shared/types.ts';
import { EVENTS_URL, apiAccept, apiAcceptAll, apiClear, apiContext, apiFile, apiOps, apiRevert, apiTree } from './api.ts';

const h = React.createElement;

// ── 本会话已修改文件集合（模块级轻量 store，供树标记与标签角标订阅） ──
const changeStore = { paths: [] as string[] };
const changeListeners = new Set<() => void>();

export function setChangedPaths(paths: string[]): void {
  changeStore.paths = paths;
  for (const fn of [...changeListeners]) {
    try {
      fn();
    } catch {
      // 单个监听器异常不影响其他
    }
  }
}

function subscribeChanges(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** Studio 标签角标：显示本会话已修改文件数。 */
export function StudioTabLabel(): unknown {
  const [count, setCount] = React.useState(changeStore.paths.length);
  React.useEffect(() => subscribeChanges(() => setCount(changeStore.paths.length)), []);
  return h(
    'span',
    { className: 'wss-tab-label' },
    'Studio',
    count > 0 ? h('span', { className: 'wss-tab-badge' }, String(count)) : null,
  );
}

// ── 载荷形状校验（契约 §8）：错误包/半截数据不许把视图打崩 ──────────────

/** 文件树必须是 `FileEntry[]`（宿主异常时可能回 `{ok:false,error}` 之类的对象）。 */
export function isFileEntryArray(value: unknown): value is FileEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every((n) => {
    if (n === null || typeof n !== 'object') return false;
    const e = n as Partial<FileEntry>;
    return typeof e.path === 'string' && typeof e.name === 'string';
  });
}

/** 改动列表必须是 `{files: FileOpsView[]}`。 */
export function isOpsPayload(value: unknown): value is OpsPayload {
  if (value === null || typeof value !== 'object') return false;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return false;
  return files.every((f) => {
    if (f === null || typeof f !== 'object') return false;
    const file = f as Partial<FileOpsView>;
    return typeof file.path === 'string' && Array.isArray(file.ops);
  });
}

/**
 * 操作身份（契约 §3）：撤回/认可按服务端下发的稳定 `id` 定位。
 * 老服务端还没有 `id` 时返回 null——调用方必须据此报错，不能偷偷退回下标。
 */
export function opIdOf(op: { id?: string | null }): string | null {
  const id = op?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** hunk 级动作的目标：`opId` 为空表示服务端没给稳定 id（不能安全撤回）。 */
export interface HunkTarget {
  opId: string | null;
  /** 台账下标，仅供展示/排错，不参与请求体 */
  opIndex: number;
}

/**
 * 过期响应守卫（契约 §8）：每次发起请求取一个自增序号，响应回来时序号不是最新就丢弃；
 * 切文件/切会话时 `invalidate()` 让所有在途响应作废。
 * 抽成纯对象是为了能单测（组件里的 effect 在测试桩下不执行）。
 */
export interface SeqGuard {
  /** 取一个新的序号（同时让此前所有序号失效） */
  next(): number;
  /** 当前序号（用于"只刷新不抢序号"的场景） */
  current(): number;
  /** 当前是否仍是最新序号 */
  isCurrent(seq: number): boolean;
  /** 让所有在途请求作废（切会话） */
  invalidate(): void;
}

export function createSeqGuard(ref: { current: number }): SeqGuard {
  return {
    next: () => (ref.current += 1),
    current: () => ref.current,
    isCurrent: (seq: number) => seq === ref.current,
    invalidate: () => {
      ref.current += 1;
    },
  };
}

function hunkListOf(op: OpView): Hunk[] {
  return Array.isArray(op.hunks) ? op.hunks : [];
}

function resolvedHunksOf(op: OpView, key: 'revertedHunks' | 'acceptedHunks'): number[] {
  const v = op[key];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
}

export interface DiffRow {
  kind: 'ctx' | 'del' | 'add';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/** 把 hunk 展开成带行号标记的展示行（ctx/-/+）。 */
export function buildDiffRows(hunk: Hunk): DiffRow[] {
  const rows: DiffRow[] = [];
  const before = hunk.ctxBefore.length;
  const after = hunk.ctxAfter.length;
  const o = hunk.oldStart;
  const n = hunk.newStart;
  for (let i = 0; i < before; i++) {
    rows.push({ kind: 'ctx', oldNo: o + i, newNo: n + i, text: hunk.ctxBefore[i] });
  }
  for (let i = 0; i < hunk.removed.length; i++) {
    rows.push({ kind: 'del', oldNo: o + before + i, newNo: null, text: hunk.removed[i] });
  }
  for (let i = 0; i < hunk.added.length; i++) {
    rows.push({ kind: 'add', oldNo: null, newNo: n + before + i, text: hunk.added[i] });
  }
  for (let i = 0; i < after; i++) {
    rows.push({
      kind: 'ctx',
      oldNo: o + before + hunk.removed.length + i,
      newNo: n + before + hunk.added.length + i,
      text: hunk.ctxAfter[i],
    });
  }
  return rows;
}

function TreeNode(props: {
  node: FileEntry;
  depth: number;
  selected: string | null;
  changedPaths: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): unknown {
  const pad = { paddingLeft: `${8 + props.depth * 14}px` };
  if (props.node.isDir) {
    const open = props.expanded.has(props.node.path);
    const changedCount = countChangedDescendants(props.node.children ?? [], props.changedPaths);
    return h(
      'div',
      { className: 'wss-tree-dir' },
      h(
        'button',
        {
          type: 'button',
          className: 'wss-tree-dir-head',
          style: pad,
          onClick: () => props.onToggle(props.node.path),
          title: props.node.path,
        },
        h('span', { className: 'wss-chevron' }, open ? '▾' : '▸'),
        props.node.name,
        changedCount > 0 ? h('span', { className: 'wss-dir-badge' }, String(changedCount)) : null,
      ),
      open
        ? (props.node.children ?? []).map((c) =>
            h(TreeNode, {
              key: c.path,
              node: c,
              depth: props.depth + 1,
              selected: props.selected,
              changedPaths: props.changedPaths,
              expanded: props.expanded,
              onToggle: props.onToggle,
              onSelect: props.onSelect,
            }),
          )
        : null,
    );
  }
  return h(
    'button',
    {
      type: 'button',
      className:
        'wss-tree-file' +
        (props.node.path === props.selected ? ' wss-selected' : '') +
        (props.changedPaths.has(props.node.path) ? ' wss-modified' : ''),
      style: pad,
      title: props.node.path,
      onClick: () => props.onSelect(props.node.path),
    },
    props.node.name,
    props.changedPaths.has(props.node.path) ? h('span', { className: 'wss-dot' }, '●') : null,
  );
}

/** 统计目录下已修改文件数（递归）。 */
function countChangedDescendants(nodes: FileEntry[], changed: ReadonlySet<string>): number {
  let count = 0;
  for (const n of nodes) {
    if (n.isDir) count += countChangedDescendants(n.children ?? [], changed);
    else if (changed.has(n.path)) count++;
  }
  return count;
}

/** 收集包含已修改文件的祖先目录路径。 */
function addAncestorDirs(
  nodes: FileEntry[],
  parents: string[],
  changed: ReadonlySet<string>,
  out: Set<string>,
): void {
  for (const n of nodes) {
    if (n.isDir) {
      addAncestorDirs(n.children ?? [], [...parents, n.path], changed, out);
    } else if (changed.has(n.path)) {
      for (const p of parents) out.add(p);
    }
  }
}

/** ① 文件树（目录可折叠；默认只展开第一层；含已修改文件的目录自动展开并显示数量角标） */
export function FileTree(props: {
  tree: FileEntry[];
  selected: string | null;
  changedPaths?: string[];
  onSelect: (path: string) => void;
}): unknown {
  // 契约 §8：先校验形状。宿主回错误包时 `props.tree` 不是数组，
  // 直接 `.filter` 会把整个标签页渲染成空白。
  if (!isFileEntryArray(props.tree)) {
    return h('div', { className: 'wss-empty' }, '文件树数据格式异常，点 ↻ 重试');
  }
  if (props.tree.length === 0) {
    return h('div', { className: 'wss-empty' }, '工作区里没有可显示的文件');
  }
  // 防御性归一化：与树节点路径（服务端已归一化为正斜杠）保持一致
  const changed = new Set((props.changedPaths ?? []).map((p) => p.replace(/\\/g, '/')));
  // 初始展开：第一层目录 + 包含已修改文件的祖先目录
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => {
    const base = new Set(props.tree.filter((n) => n.isDir).map((n) => n.path));
    addAncestorDirs(props.tree, [], changed, base);
    return base;
  });
  // 运行期：新增修改文件时自动展开其祖先目录
  React.useEffect(() => {
    const toAdd = new Set<string>();
    addAncestorDirs(props.tree, [], changed, toAdd);
    if (toAdd.size > 0) setExpanded((prev) => new Set([...prev, ...toAdd]));
  }, [props.tree, props.changedPaths]);
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };
  return h(
    'div',
    { className: 'wss-tree' },
    props.tree.map((n) =>
      h(TreeNode, {
        key: n.path,
        node: n,
        depth: 0,
        selected: props.selected,
        changedPaths: changed,
        expanded,
        onToggle: toggle,
        onSelect: props.onSelect,
      }),
    ),
  );
}

/** ② 代码查看器（行号 + 等宽字体） */
export function CodeViewer(props: {
  path: string;
  content: string;
  truncated: boolean;
  error: string | null;
}): unknown {
  if (props.error) return h('div', { className: 'wss-empty' }, props.error);
  const lines = props.content.split('\n');
  return h(
    'div',
    { className: 'wss-viewer' },
    h(
      'div',
      { className: 'wss-viewer-head' },
      h('span', { className: 'wss-path', title: props.path }, props.path),
      props.truncated ? h('span', { className: 'wss-hint' }, '（内容过长已截断）') : null,
    ),
    h(
      'div',
      { className: 'wss-viewer-body' },
      lines.map((line, i) =>
        h(
          'div',
          { key: i, className: 'wss-code-line' },
          h('span', { className: 'wss-gutter' }, String(i + 1)),
          h('span', { className: 'wss-text' }, line),
        ),
      ),
    ),
  );
}

/** ③+④ 改动面板：每个 hunk 独立「撤回此块」/「认可」；已处理的块只显示状态，不再显示差异。 */
export function DiffPanel(props: {
  ops: OpsPayload | null;
  busy: boolean;
  /** 块级动作按 `opId` 定位（契约 §3）；`opId` 为 null 时仍回调，由上层拒绝并报错 */
  onRevertHunk: (target: HunkTarget, hunkIndex: number) => void;
  onAcceptHunk: (target: HunkTarget, hunkIndex: number) => void;
  onRevertFile: () => void;
  /** 一键同意：认可该文件全部待处理变更块 */
  onAcceptAll: () => void;
}): unknown {
  // 契约 §8：形状校验——`ops?.files?.length` 不成立时走空态，不让错误包打崩面板
  if (!props.ops || !isOpsPayload(props.ops) || props.ops.files.length === 0) {
    return h('div', { className: 'wss-empty' }, '暂无改动记录（本会话内 write/edit 过的文件会出现在这里）');
  }
  const file = props.ops.files[0];
  const pendingHunks = file.ops.reduce((n, op) => {
    const reverted = resolvedHunksOf(op, 'revertedHunks');
    const accepted = resolvedHunksOf(op, 'acceptedHunks');
    return n + hunkListOf(op).filter((_, hi) => !reverted.includes(hi) && !accepted.includes(hi)).length;
  }, 0);
  const sections: unknown[] = [
    h(
      'div',
      { className: 'wss-diff-head' },
      h('span', { className: 'wss-path', title: file.path }, file.path),
      h(
        'button',
        {
          type: 'button',
          className: 'wss-btn wss-btn-accept',
          disabled: props.busy || pendingHunks === 0,
          onClick: props.onAcceptAll,
          title: '认可该文件的全部待处理变更块',
        },
        pendingHunks > 0 ? `一键同意（${pendingHunks} 块）` : '一键同意',
      ),
      h(
        'button',
        { type: 'button', className: 'wss-btn wss-btn-danger', disabled: props.busy, onClick: props.onRevertFile },
        '撤回全部修改',
      ),
    ),
  ];
  for (const op of file.ops) {
    const hunks = hunkListOf(op);
    const revertedHunks = resolvedHunksOf(op, 'revertedHunks');
    const acceptedHunks = resolvedHunksOf(op, 'acceptedHunks');
    const target: HunkTarget = { opId: opIdOf(op), opIndex: typeof op.index === 'number' ? op.index : 0 };
    const opParts: unknown[] = [
      h(
        'div',
        { className: 'wss-op-head' },
        h('span', { className: 'wss-op-title' }, `操作 ${target.opIndex + 1}`),
        h('span', { className: 'wss-op-meta' }, op.turn != null ? `轮次 ${op.turn} · ` : '', `+${op.added ?? 0} −${op.removed ?? 0}`),
        // 契约 §7：占位记录（快照过大被截断）要显式说明，别让用户以为是空文件
        op.truncated ? h('span', { className: 'wss-hint' }, '快照过大，不可撤回') : null,
      ),
    ];
    hunks.forEach((hunk, hi) => {
      const reverted = revertedHunks.includes(hi);
      const accepted = acceptedHunks.includes(hi);
      const resolved = reverted || accepted;
      const head = h(
        'div',
        { className: 'wss-hunk-head' },
        h('span', { className: 'wss-hunk-title' }, `变更块 ${hi + 1}/${hunks.length}`),
        reverted
          ? h('span', { className: 'wss-hunk-done' }, '已撤回')
          : accepted
            ? h('span', { className: 'wss-hunk-accepted' }, '已认可')
            : null,
        h('span', { className: 'wss-spacer' }),
        reverted || accepted ? null : h(
          'button',
          {
            type: 'button',
            className: 'wss-btn wss-btn-accept',
            disabled: props.busy || !op.revertible,
            onClick: () => props.onAcceptHunk(target, hi),
          },
          '认可',
        ),
        reverted || accepted ? null : h(
          'button',
          {
            type: 'button',
            className: 'wss-btn',
            disabled: props.busy || !op.revertible,
            onClick: () => props.onRevertHunk(target, hi),
          },
          '撤回此块',
        ),
      );
      opParts.push(
        h(
          'div',
          { key: hi, className: 'wss-hunk' + (resolved ? ' wss-hunk-resolved' : '') },
          head,
          // 已处理（撤回/认可）的块不再展示差异行
          ...(resolved ? [] : buildDiffRows(hunk).map((r, ri) => h(
            'div',
            { key: ri, className: `wss-row wss-${r.kind}` },
            h('span', { className: 'wss-gutter' }, r.oldNo != null ? String(r.oldNo) : ''),
            h('span', { className: 'wss-gutter wss-sign' }, r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '),
            h('span', { className: 'wss-gutter' }, r.newNo != null ? String(r.newNo) : ''),
            h('span', { className: 'wss-text' }, r.text),
          ))),
        ),
      );
    });
    sections.push(h('div', { key: target.opIndex, className: 'wss-op' }, ...opParts));
  }
  return h('div', { className: 'wss-diff' }, ...sections);
}

function confirmDialog(msg: string): boolean {
  return typeof window !== 'undefined' ? window.confirm(msg) : true;
}

/** 统一取错误文案：ApiError / Error / 其它。 */
function errorText(e: unknown): string {
  const msg = (e as Error)?.message;
  return String(msg ?? e);
}

/** Studio 主视图：文件树 + 查看器 + 改动面板。 */
export function StudioView(props: { sessionId?: string }): unknown {
  const sessionId = props.sessionId ?? '';
  const [root, setRoot] = React.useState<string | null>(null);
  const [tree, setTree] = React.useState<FileEntry[] | null>(null);
  const [treeError, setTreeError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [content, setContent] = React.useState<ReadResult | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [ops, setOps] = React.useState<OpsPayload | null>(null);
  const [opsError, setOpsError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // 本会话已修改文件列表（订阅模块级 store，驱动文件树标记与自动展开）
  const [changedPaths, setChangedPathsLocal] = React.useState<string[]>(() => [...changeStore.paths]);

  React.useEffect(() => subscribeChanges(() => setChangedPathsLocal([...changeStore.paths])), []);

  // 过期响应丢弃（契约 §8）：
  // - `treeGuard` / `selGuard` 是各自请求链的自增序号，回来的响应序号不是最新就丢掉；
  // - 切会话时两者一起 `invalidate()`，上一个会话的迟到响应一律作废。
  const treeGuard = createSeqGuard(React.useRef(0));
  const selGuard = createSeqGuard(React.useRef(0));

  const loadTree = (r: string) => {
    const seq = treeGuard.next();
    apiTree(r)
      .then((t) => {
        if (!treeGuard.isCurrent(seq)) return;
        if (!isFileEntryArray(t)) {
          setTree(null);
          setTreeError('文件树数据格式异常');
          return;
        }
        setTree(t);
        setTreeError(null);
      })
      .catch((e: unknown) => {
        if (!treeGuard.isCurrent(seq)) return;
        setTree(null);
        setTreeError(errorText(e));
      });
  };

  const loadSelected = (p: string) => {
    const seq = selGuard.next();
    setContent(null);
    setFileError(null);
    setOps(null);
    setOpsError(null);
    apiFile(p)
      .then((r) => {
        if (!selGuard.isCurrent(seq)) return;
        setContent(r);
      })
      .catch((e: unknown) => {
        if (!selGuard.isCurrent(seq)) return;
        setContent(null);
        setFileError(errorText(e));
      });
    if (!sessionId) return;
    apiOps(sessionId, p)
      .then((r) => {
        if (!selGuard.isCurrent(seq)) return;
        if (!isOpsPayload(r)) {
          setOps(null);
          setOpsError('改动记录数据格式异常');
          return;
        }
        setOps(r);
        setOpsError(null);
      })
      .catch((e: unknown) => {
        if (!selGuard.isCurrent(seq)) return;
        setOps(null);
        setOpsError(errorText(e));
      });
  };

  /** 只刷新改动的 ops：沿用当前选择序号（不 next），避免把在途的内容加载挤掉。 */
  const refreshOps = () => {
    if (!sessionId || !selected) return;
    const seq = selGuard.current();
    apiOps(sessionId, selected)
      .then((r) => {
        if (!selGuard.isCurrent(seq)) return;
        if (!isOpsPayload(r)) {
          setOps(null);
          setOpsError('改动记录数据格式异常');
          return;
        }
        setOps(r);
        setOpsError(null);
      })
      .catch((e: unknown) => {
        if (!selGuard.isCurrent(seq)) return;
        setOps(null);
        setOpsError(errorText(e));
      });
  };

  const refreshChanged = () => {
    if (!sessionId) return;
    apiOps(sessionId)
      .then((p) => setChangedPaths(isOpsPayload(p) ? p.files.map((f) => f.path) : []))
      .catch(() => {
        // 角标/树标记是辅助信息：取不到就保持现状，不打断主流程
      });
  };

  /** 会话上下文 → 默认文件树根。与树加载共用序号：后发起的加载作废先前的。 */
  const loadContext = () => {
    if (!sessionId) return;
    const seq = treeGuard.next();
    apiContext(sessionId)
      .then((c: SessionContext) => {
        if (!treeGuard.isCurrent(seq)) return;
        const cwd = typeof c?.cwd === 'string' && c.cwd !== '' ? c.cwd : null;
        if (cwd) {
          setRoot(cwd);
          loadTree(cwd);
        } else {
          setRoot(null);
          setTree(null);
          setTreeError('未取到该会话的工作目录，请先打开一个工作区');
        }
      })
      .catch((e: unknown) => {
        if (!treeGuard.isCurrent(seq)) return;
        setTreeError(`会话上下文读取失败：${errorText(e)}`);
      });
  };

  // SSE 订阅只随 sessionId 建立一次；刷新函数通过 ref 取最新版，
  // 避免"点一个文件就重连一次 EventSource"（服务端 clients 集合会来回抖动）。
  const refreshRef = React.useRef<() => void>(() => {});
  refreshRef.current = () => {
    refreshOps();
    refreshChanged();
  };

  // 切会话（契约 §8）：先把上一个会话的状态**全部**清掉，再加载新的会话。
  // 否则切换瞬间会看到别的会话的文件树、diff、提示和错误。
  React.useEffect(() => {
    // 作废上一个会话所有在途请求
    treeGuard.invalidate();
    selGuard.invalidate();
    setRoot(null);
    setTree(null);
    setTreeError(null);
    setSelected(null);
    setContent(null);
    setFileError(null);
    setOps(null);
    setOpsError(null);
    setBusy(false);
    setNotice(null);
    setError(null);
    setChangedPaths([]);
    setChangedPathsLocal([]);
    if (!sessionId) return undefined;

    // 用序号守卫代替 alive：切会话时守卫已 invalidate，上一个会话的响应自然被丢弃
    loadContext();
    refreshChanged();
    return undefined;
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId) return undefined;
    // 无 EventSource（SSR/老浏览器）时安静降级，不让整个视图渲染失败
    if (typeof EventSource === 'undefined') return undefined;
    const es = new EventSource(EVENTS_URL);
    // 契约 §8：载荷只表示"有变化"（不再带 session），客户端据此刷新当前会话
    es.onmessage = () => {
      refreshRef.current();
    };
    return () => es.close();
  }, [sessionId]);

  const selectFile = (p: string) => {
    setSelected(p);
    setNotice(null);
    setError(null);
    loadSelected(p);
  };

  /** 手动刷新：树 + 当前文件 + 改动角标（错误态下的重试入口）。 */
  const reload = () => {
    setError(null);
    setNotice(null);
    setTreeError(null);
    setFileError(null);
    setOpsError(null);
    if (sessionId) {
      if (root) loadTree(root);
      else loadContext();
    }
    if (selected) loadSelected(selected);
    refreshChanged();
  };

  /** 写操作统一包装：先确认，再发请求（不确认就不发），失败写 error 状态。 */
  const doAction = (msg: string, run: () => Promise<RevertResult>, after: () => void) => {
    if (!confirmDialog(msg)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let pending: Promise<RevertResult>;
    try {
      pending = run();
    } catch (e) {
      setBusy(false);
      setError(`操作失败：${errorText(e)}`);
      return;
    }
    pending
      .then((v) => {
        if (v && v.ok) {
          setNotice(v.message);
          after();
        } else {
          setError(`操作失败：${(v as { error?: string })?.error ?? '未知错误'}`);
        }
      })
      .catch((e: unknown) => setError(`操作失败：${errorText(e)}`))
      .finally(() => setBusy(false));
  };

  const revertHunk = (target: HunkTarget, hunkIndex: number) => {
    if (!sessionId || !selected) return;
    const path = selected;
    doAction(
      '确定撤回这个变更块？此操作会直接改写磁盘上的文件。',
      () => apiRevert(sessionId, path, target.opId, hunkIndex),
      () => {
        loadSelected(path);
        refreshChanged();
      },
    );
  };

  const acceptHunk = (target: HunkTarget, hunkIndex: number) => {
    if (!sessionId || !selected) return;
    const path = selected;
    const opId = target.opId;
    if (!opId) {
      setError('该操作记录缺少 opId（服务端未下发），请点 ↻ 刷新后重试');
      return;
    }
    doAction(
      '确定认可这个变更块？认可后不再标记、不再显示差异。',
      () => apiAccept(sessionId, path, opId, hunkIndex),
      () => {
        loadSelected(path);
        refreshChanged();
      },
    );
  };

  const revertFile = () => {
    if (!sessionId || !selected) return;
    const path = selected;
    doAction(
      '确定撤回该文件的全部修改？此操作会直接改写磁盘上的文件。',
      () => apiRevert(sessionId, path),
      () => {
        loadSelected(path);
        refreshChanged();
      },
    );
  };

  /** 一键同意：把该文件所有待处理变更块标记为认可（不写盘）。 */
  const acceptAll = () => {
    if (!sessionId || !selected) return;
    const path = selected;
    doAction(
      '确定认可该文件的全部待处理变更块？认可后不再标记、不再显示差异。',
      () => apiAcceptAll(sessionId, path),
      () => {
        loadSelected(path);
        refreshChanged();
      },
    );
  };

  const clearAll = () => {
    if (!sessionId || !confirmDialog('清空本会话的改动记录？')) return;
    apiClear(sessionId)
      .then(() => {
        setOps(null);
        setOpsError(null);
        setNotice('已清空本会话的改动记录');
        refreshChanged();
      })
      .catch((e: unknown) => setError(`清空失败：${errorText(e)}`));
  };

  return h(
    'div',
    { className: 'wss-view' },
    h(
      'div',
      { className: 'wss-head' },
      h('span', { className: 'wss-title' }, 'Studio'),
      root ? h('span', { className: 'wss-root', title: root }, root) : null,
      h('span', { className: 'wss-spacer' }),
      notice ? h('span', { className: 'wss-notice' }, notice) : null,
      error ? h('span', { className: 'wss-error' }, error) : null,
      h('button', { type: 'button', className: 'wss-btn', title: '刷新', onClick: reload }, '↻'),
      h('button', { type: 'button', className: 'wss-btn', title: '清空记录', onClick: clearAll }, '清空'),
    ),
    h(
      'div',
      { className: 'wss-body' },
      h(
        'div',
        { className: 'wss-pane wss-pane-tree' },
        treeError
          ? h('div', { className: 'wss-empty' }, `文件树加载失败：${treeError}（点 ↻ 重试）`)
          : tree
            ? h(FileTree, { tree, selected, changedPaths, onSelect: selectFile })
            : h('div', { className: 'wss-empty' }, '加载中…'),
      ),
      h(
        'div',
        { className: 'wss-pane wss-pane-main' },
        content
          ? h(CodeViewer, {
              path: selected ?? '',
              content: content.ok ? content.content : '',
              truncated: content.ok ? content.truncated : false,
              error: content.ok ? null : content.error,
            })
          : fileError
            ? h('div', { className: 'wss-empty' }, `文件加载失败：${fileError}`)
            : h('div', { className: 'wss-empty' }, '点击左侧文件查看内容'),
        opsError
          ? h('div', { className: 'wss-empty' }, `改动记录加载失败：${opsError}（点 ↻ 重试）`)
          : h(DiffPanel, { ops, busy, onRevertHunk: revertHunk, onAcceptHunk: acceptHunk, onRevertFile: revertFile, onAcceptAll: acceptAll }),
      ),
    ),
  );
}
