// 浏览器半侧视图：Studio 标签页（文件树 → 代码查看 → 改动 diff → hunk 级撤回）。
// 使用 createElement 风格，零 JSX 依赖；组件均为纯函数，便于结构测试。

import * as React from 'react';
import type { FileEntry, Hunk, OpsPayload, ReadResult, RevertResult, SessionContext } from '../shared/types.ts';
import { apiAccept, apiClear, apiContext, apiFile, apiOps, apiRevert, apiTree } from './api.ts';

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
  onRevertHunk: (opIndex: number, hunkIndex: number) => void;
  onAcceptHunk: (opIndex: number, hunkIndex: number) => void;
  onRevertFile: () => void;
}): unknown {
  if (!props.ops || props.ops.files.length === 0) {
    return h('div', { className: 'wss-empty' }, '暂无改动记录（本会话内 write/edit 过的文件会出现在这里）');
  }
  const file = props.ops.files[0];
  const sections: unknown[] = [
    h(
      'div',
      { className: 'wss-diff-head' },
      h('span', { className: 'wss-path', title: file.path }, file.path),
      h(
        'button',
        { type: 'button', className: 'wss-btn wss-btn-danger', disabled: props.busy, onClick: props.onRevertFile },
        '撤回全部修改',
      ),
    ),
  ];
  for (const op of file.ops) {
    const opParts: unknown[] = [
      h(
        'div',
        { className: 'wss-op-head' },
        h('span', { className: 'wss-op-title' }, `操作 ${op.index + 1}`),
        h('span', { className: 'wss-op-meta' }, op.turn != null ? `轮次 ${op.turn} · ` : '', `+${op.added} −${op.removed}`),
      ),
    ];
    op.hunks.forEach((hunk, hi) => {
      const reverted = op.revertedHunks.includes(hi);
      const accepted = op.acceptedHunks.includes(hi);
      const resolved = reverted || accepted;
      const head = h(
        'div',
        { className: 'wss-hunk-head' },
        h('span', { className: 'wss-hunk-title' }, `变更块 ${hi + 1}/${op.hunks.length}`),
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
            onClick: () => props.onAcceptHunk(op.index, hi),
          },
          '认可',
        ),
        reverted || accepted ? null : h(
          'button',
          {
            type: 'button',
            className: 'wss-btn',
            disabled: props.busy || !op.revertible,
            onClick: () => props.onRevertHunk(op.index, hi),
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
    sections.push(h('div', { key: op.index, className: 'wss-op' }, ...opParts));
  }
  return h('div', { className: 'wss-diff' }, ...sections);
}

function confirmDialog(msg: string): boolean {
  return typeof window !== 'undefined' ? window.confirm(msg) : true;
}

function alertDialog(msg: string): void {
  if (typeof window !== 'undefined') window.alert(msg);
}

/** Studio 主视图：文件树 + 查看器 + 改动面板。 */
export function StudioView(props: { sessionId?: string }): unknown {
  const sessionId = props.sessionId ?? '';
  const [root, setRoot] = React.useState<string | null>(null);
  const [tree, setTree] = React.useState<FileEntry[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [content, setContent] = React.useState<ReadResult | null>(null);
  const [ops, setOps] = React.useState<OpsPayload | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // 本会话已修改文件列表（订阅模块级 store，驱动文件树标记与自动展开）
  const [changedPaths, setChangedPathsLocal] = React.useState<string[]>(() => [...changeStore.paths]);

  React.useEffect(() => subscribeChanges(() => setChangedPathsLocal([...changeStore.paths])), []);

  const loadTree = (r: string) => {
    apiTree(r)
      .then(setTree)
      .catch((e: unknown) => setError(String((e as Error)?.message ?? e)));
  };
  const loadSelected = (p: string) => {
    apiFile(p).then(setContent).catch(() => setContent(null));
    if (sessionId) apiOps(sessionId, p).then(setOps).catch(() => setOps(null));
  };
  const refreshOps = () => {
    if (sessionId && selected) apiOps(sessionId, selected).then(setOps).catch(() => setOps(null));
  };
  const refreshChanged = () => {
    if (!sessionId) return;
    apiOps(sessionId)
      .then((p) => setChangedPaths(p.files.map((f) => f.path)))
      .catch(() => {});
  };

  React.useEffect(() => {
    let alive = true;
    if (sessionId) {
      apiContext(sessionId)
        .then((c: SessionContext) => {
          if (alive && c.cwd) {
            setRoot(c.cwd);
            loadTree(c.cwd);
          }
        })
        .catch(() => {});
      refreshChanged();
    }
    return () => {
      alive = false;
    };
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource('/ws-studio/events');
    es.onmessage = (e: MessageEvent) => {
      try {
        const d = JSON.parse(String(e.data)) as { session?: string };
        if (d && d.session === sessionId) {
          refreshOps();
          refreshChanged();
        }
      } catch {
        // 忽略非 JSON 帧
      }
    };
    return () => es.close();
  }, [sessionId, selected]);

  const selectFile = (p: string) => {
    setSelected(p);
    setContent(null);
    setOps(null);
    loadSelected(p);
  };

  const doRevert = (msg: string, call: Promise<RevertResult>, after: () => void) => {
    if (!confirmDialog(msg)) return;
    setBusy(true);
    call
      .then((v) => {
        if (v.ok) {
          setNotice(v.message);
          after();
        } else {
          alertDialog(`撤回失败：${v.error}`);
        }
      })
      .catch((e: unknown) => alertDialog(`撤回失败：${String((e as Error)?.message ?? e)}`))
      .finally(() => setBusy(false));
  };

  const revertHunk = (opIndex: number, hunkIndex: number) => {
    if (!sessionId || !selected) return;
    doRevert('确定撤回这个变更块？此操作会直接改写磁盘上的文件。', apiRevert(sessionId, selected, opIndex, hunkIndex), () => {
      if (selected) loadSelected(selected);
      refreshChanged();
    });
  };

  const acceptHunk = (opIndex: number, hunkIndex: number) => {
    if (!sessionId || !selected) return;
    doRevert(`确定认可这个变更块？认可后不再标记、不再显示差异。`, apiAccept(sessionId, selected, opIndex, hunkIndex), () => {
      if (selected) loadSelected(selected);
      refreshChanged();
    });
  };

  const revertFile = () => {
    if (!sessionId || !selected) return;
    doRevert('确定撤回该文件的全部修改？此操作会直接改写磁盘上的文件。', apiRevert(sessionId, selected), () => {
      if (selected) loadSelected(selected);
      refreshChanged();
    });
  };

  const clearAll = () => {
    if (!sessionId || !confirmDialog('清空本会话的改动记录？')) return;
    apiClear(sessionId)
      .then(() => setOps(null))
      .catch(() => {});
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
      h('button', { type: 'button', className: 'wss-btn', title: '刷新', onClick: () => root && loadTree(root) }, '↻'),
      h('button', { type: 'button', className: 'wss-btn', title: '清空记录', onClick: clearAll }, '清空'),
    ),
    h(
      'div',
      { className: 'wss-body' },
      h(
        'div',
        { className: 'wss-pane wss-pane-tree' },
        tree
          ? h(FileTree, {
              tree,
              selected,
              changedPaths,
              onSelect: selectFile,
            })
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
          : h('div', { className: 'wss-empty' }, '点击左侧文件查看内容'),
        h(DiffPanel, { ops, busy, onRevertHunk: revertHunk, onAcceptHunk: acceptHunk, onRevertFile: revertFile }),
      ),
    ),
  );
}
