window.__ModuleLoader__.load({
	id: "dsh-workspace-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		"use strict";
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var React2 = __toESM(require("react"), 1);

// src/client/view.ts
var React = __toESM(require("react"), 1);

// src/client/api.ts
async function apiJson(url, init) {
  const res = await fetch(url, init);
  return await res.json();
}
function apiTree(root) {
  return apiJson(`/ws-studio/tree?root=${encodeURIComponent(root)}`);
}
function apiFile(path) {
  return apiJson(`/ws-studio/file?path=${encodeURIComponent(path)}`);
}
function apiContext(session) {
  return apiJson(`/ws-studio/context?session=${encodeURIComponent(session)}`);
}
function apiOps(session, file) {
  const fileQ = file ? `&file=${encodeURIComponent(file)}` : "";
  return apiJson(`/ws-studio/ops?session=${encodeURIComponent(session)}${fileQ}`);
}
function apiRevert(session, path, op, hunk) {
  return apiJson(`/ws-studio/revert?session=${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, op: op ?? null, hunk: hunk ?? null })
  });
}
function apiAccept(session, path, op, hunk) {
  return apiJson(`/ws-studio/accept?session=${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, op, hunk })
  });
}
function apiClear(session) {
  return apiJson(`/ws-studio/clear?session=${encodeURIComponent(session)}`, { method: "POST" });
}

// src/client/view.ts
var h = React.createElement;
var changeStore = { paths: [] };
var changeListeners = /* @__PURE__ */ new Set();
function setChangedPaths(paths) {
  changeStore.paths = paths;
  for (const fn of [...changeListeners]) {
    try {
      fn();
    } catch {
    }
  }
}
function subscribeChanges(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function StudioTabLabel() {
  const [count, setCount] = React.useState(changeStore.paths.length);
  React.useEffect(() => subscribeChanges(() => setCount(changeStore.paths.length)), []);
  return h(
    "span",
    { className: "wss-tab-label" },
    "Studio",
    count > 0 ? h("span", { className: "wss-tab-badge" }, String(count)) : null
  );
}
function buildDiffRows(hunk) {
  const rows = [];
  const before = hunk.ctxBefore.length;
  const after = hunk.ctxAfter.length;
  const o = hunk.oldStart;
  const n = hunk.newStart;
  for (let i = 0; i < before; i++) {
    rows.push({ kind: "ctx", oldNo: o + i, newNo: n + i, text: hunk.ctxBefore[i] });
  }
  for (let i = 0; i < hunk.removed.length; i++) {
    rows.push({ kind: "del", oldNo: o + before + i, newNo: null, text: hunk.removed[i] });
  }
  for (let i = 0; i < hunk.added.length; i++) {
    rows.push({ kind: "add", oldNo: null, newNo: n + before + i, text: hunk.added[i] });
  }
  for (let i = 0; i < after; i++) {
    rows.push({
      kind: "ctx",
      oldNo: o + before + hunk.removed.length + i,
      newNo: n + before + hunk.added.length + i,
      text: hunk.ctxAfter[i]
    });
  }
  return rows;
}
function TreeNode(props) {
  const pad = { paddingLeft: `${8 + props.depth * 14}px` };
  if (props.node.isDir) {
    const open = props.expanded.has(props.node.path);
    const changedCount = countChangedDescendants(props.node.children ?? [], props.changedPaths);
    return h(
      "div",
      { className: "wss-tree-dir" },
      h(
        "button",
        {
          type: "button",
          className: "wss-tree-dir-head",
          style: pad,
          onClick: () => props.onToggle(props.node.path),
          title: props.node.path
        },
        h("span", { className: "wss-chevron" }, open ? "\u25BE" : "\u25B8"),
        props.node.name,
        changedCount > 0 ? h("span", { className: "wss-dir-badge" }, String(changedCount)) : null
      ),
      open ? (props.node.children ?? []).map(
        (c) => h(TreeNode, {
          key: c.path,
          node: c,
          depth: props.depth + 1,
          selected: props.selected,
          changedPaths: props.changedPaths,
          expanded: props.expanded,
          onToggle: props.onToggle,
          onSelect: props.onSelect
        })
      ) : null
    );
  }
  return h(
    "button",
    {
      type: "button",
      className: "wss-tree-file" + (props.node.path === props.selected ? " wss-selected" : "") + (props.changedPaths.has(props.node.path) ? " wss-modified" : ""),
      style: pad,
      title: props.node.path,
      onClick: () => props.onSelect(props.node.path)
    },
    props.node.name,
    props.changedPaths.has(props.node.path) ? h("span", { className: "wss-dot" }, "\u25CF") : null
  );
}
function countChangedDescendants(nodes, changed) {
  let count = 0;
  for (const n of nodes) {
    if (n.isDir) count += countChangedDescendants(n.children ?? [], changed);
    else if (changed.has(n.path)) count++;
  }
  return count;
}
function addAncestorDirs(nodes, parents, changed, out) {
  for (const n of nodes) {
    if (n.isDir) {
      addAncestorDirs(n.children ?? [], [...parents, n.path], changed, out);
    } else if (changed.has(n.path)) {
      for (const p of parents) out.add(p);
    }
  }
}
function FileTree(props) {
  const changed = new Set((props.changedPaths ?? []).map((p) => p.replace(/\\/g, "/")));
  const [expanded, setExpanded] = React.useState(() => {
    const base = new Set(props.tree.filter((n) => n.isDir).map((n) => n.path));
    addAncestorDirs(props.tree, [], changed, base);
    return base;
  });
  React.useEffect(() => {
    const toAdd = /* @__PURE__ */ new Set();
    addAncestorDirs(props.tree, [], changed, toAdd);
    if (toAdd.size > 0) setExpanded((prev) => /* @__PURE__ */ new Set([...prev, ...toAdd]));
  }, [props.tree, props.changedPaths]);
  const toggle = (path) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };
  return h(
    "div",
    { className: "wss-tree" },
    props.tree.map(
      (n) => h(TreeNode, {
        key: n.path,
        node: n,
        depth: 0,
        selected: props.selected,
        changedPaths: changed,
        expanded,
        onToggle: toggle,
        onSelect: props.onSelect
      })
    )
  );
}
function CodeViewer(props) {
  if (props.error) return h("div", { className: "wss-empty" }, props.error);
  const lines = props.content.split("\n");
  return h(
    "div",
    { className: "wss-viewer" },
    h(
      "div",
      { className: "wss-viewer-head" },
      h("span", { className: "wss-path", title: props.path }, props.path),
      props.truncated ? h("span", { className: "wss-hint" }, "\uFF08\u5185\u5BB9\u8FC7\u957F\u5DF2\u622A\u65AD\uFF09") : null
    ),
    h(
      "div",
      { className: "wss-viewer-body" },
      lines.map(
        (line, i) => h(
          "div",
          { key: i, className: "wss-code-line" },
          h("span", { className: "wss-gutter" }, String(i + 1)),
          h("span", { className: "wss-text" }, line)
        )
      )
    )
  );
}
function DiffPanel(props) {
  if (!props.ops || props.ops.files.length === 0) {
    return h("div", { className: "wss-empty" }, "\u6682\u65E0\u6539\u52A8\u8BB0\u5F55\uFF08\u672C\u4F1A\u8BDD\u5185 write/edit \u8FC7\u7684\u6587\u4EF6\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\uFF09");
  }
  const file = props.ops.files[0];
  const sections = [
    h(
      "div",
      { className: "wss-diff-head" },
      h("span", { className: "wss-path", title: file.path }, file.path),
      h(
        "button",
        { type: "button", className: "wss-btn wss-btn-danger", disabled: props.busy, onClick: props.onRevertFile },
        "\u64A4\u56DE\u5168\u90E8\u4FEE\u6539"
      )
    )
  ];
  for (const op of file.ops) {
    const opParts = [
      h(
        "div",
        { className: "wss-op-head" },
        h("span", { className: "wss-op-title" }, `\u64CD\u4F5C ${op.index + 1}`),
        h("span", { className: "wss-op-meta" }, op.turn != null ? `\u8F6E\u6B21 ${op.turn} \xB7 ` : "", `+${op.added} \u2212${op.removed}`)
      )
    ];
    op.hunks.forEach((hunk, hi) => {
      const reverted = op.revertedHunks.includes(hi);
      const accepted = op.acceptedHunks.includes(hi);
      const resolved = reverted || accepted;
      const head = h(
        "div",
        { className: "wss-hunk-head" },
        h("span", { className: "wss-hunk-title" }, `\u53D8\u66F4\u5757 ${hi + 1}/${op.hunks.length}`),
        reverted ? h("span", { className: "wss-hunk-done" }, "\u5DF2\u64A4\u56DE") : accepted ? h("span", { className: "wss-hunk-accepted" }, "\u5DF2\u8BA4\u53EF") : null,
        h("span", { className: "wss-spacer" }),
        reverted || accepted ? null : h(
          "button",
          {
            type: "button",
            className: "wss-btn wss-btn-accept",
            disabled: props.busy || !op.revertible,
            onClick: () => props.onAcceptHunk(op.index, hi)
          },
          "\u8BA4\u53EF"
        ),
        reverted || accepted ? null : h(
          "button",
          {
            type: "button",
            className: "wss-btn",
            disabled: props.busy || !op.revertible,
            onClick: () => props.onRevertHunk(op.index, hi)
          },
          "\u64A4\u56DE\u6B64\u5757"
        )
      );
      opParts.push(
        h(
          "div",
          { key: hi, className: "wss-hunk" + (resolved ? " wss-hunk-resolved" : "") },
          head,
          ...resolved ? [] : buildDiffRows(hunk).map((r, ri) => h(
            "div",
            { key: ri, className: `wss-row wss-${r.kind}` },
            h("span", { className: "wss-gutter" }, r.oldNo != null ? String(r.oldNo) : ""),
            h("span", { className: "wss-gutter wss-sign" }, r.kind === "add" ? "+" : r.kind === "del" ? "\u2212" : " "),
            h("span", { className: "wss-gutter" }, r.newNo != null ? String(r.newNo) : ""),
            h("span", { className: "wss-text" }, r.text)
          ))
        )
      );
    });
    sections.push(h("div", { key: op.index, className: "wss-op" }, ...opParts));
  }
  return h("div", { className: "wss-diff" }, ...sections);
}
function confirmDialog(msg) {
  return typeof window !== "undefined" ? window.confirm(msg) : true;
}
function alertDialog(msg) {
  if (typeof window !== "undefined") window.alert(msg);
}
function StudioView(props) {
  const sessionId = props.sessionId ?? "";
  const [root, setRoot] = React.useState(null);
  const [tree, setTree] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [content, setContent] = React.useState(null);
  const [ops, setOps] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [changedPaths, setChangedPathsLocal] = React.useState(() => [...changeStore.paths]);
  React.useEffect(() => subscribeChanges(() => setChangedPathsLocal([...changeStore.paths])), []);
  const loadTree = (r) => {
    apiTree(r).then(setTree).catch((e) => setError(String(e?.message ?? e)));
  };
  const loadSelected = (p) => {
    apiFile(p).then(setContent).catch(() => setContent(null));
    if (sessionId) apiOps(sessionId, p).then(setOps).catch(() => setOps(null));
  };
  const refreshOps = () => {
    if (sessionId && selected) apiOps(sessionId, selected).then(setOps).catch(() => setOps(null));
  };
  const refreshChanged = () => {
    if (!sessionId) return;
    apiOps(sessionId).then((p) => setChangedPaths(p.files.map((f) => f.path))).catch(() => {
    });
  };
  React.useEffect(() => {
    let alive = true;
    if (sessionId) {
      apiContext(sessionId).then((c) => {
        if (alive && c.cwd) {
          setRoot(c.cwd);
          loadTree(c.cwd);
        }
      }).catch(() => {
      });
      refreshChanged();
    }
    return () => {
      alive = false;
    };
  }, [sessionId]);
  React.useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource("/ws-studio/events");
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(String(e.data));
        if (d && d.session === sessionId) {
          refreshOps();
          refreshChanged();
        }
      } catch {
      }
    };
    return () => es.close();
  }, [sessionId, selected]);
  const selectFile = (p) => {
    setSelected(p);
    setContent(null);
    setOps(null);
    loadSelected(p);
  };
  const doRevert = (msg, call, after) => {
    if (!confirmDialog(msg)) return;
    setBusy(true);
    call.then((v) => {
      if (v.ok) {
        setNotice(v.message);
        after();
      } else {
        alertDialog(`\u64A4\u56DE\u5931\u8D25\uFF1A${v.error}`);
      }
    }).catch((e) => alertDialog(`\u64A4\u56DE\u5931\u8D25\uFF1A${String(e?.message ?? e)}`)).finally(() => setBusy(false));
  };
  const revertHunk = (opIndex, hunkIndex) => {
    if (!sessionId || !selected) return;
    doRevert("\u786E\u5B9A\u64A4\u56DE\u8FD9\u4E2A\u53D8\u66F4\u5757\uFF1F\u6B64\u64CD\u4F5C\u4F1A\u76F4\u63A5\u6539\u5199\u78C1\u76D8\u4E0A\u7684\u6587\u4EF6\u3002", apiRevert(sessionId, selected, opIndex, hunkIndex), () => {
      if (selected) loadSelected(selected);
      refreshChanged();
    });
  };
  const acceptHunk = (opIndex, hunkIndex) => {
    if (!sessionId || !selected) return;
    doRevert(`\u786E\u5B9A\u8BA4\u53EF\u8FD9\u4E2A\u53D8\u66F4\u5757\uFF1F\u8BA4\u53EF\u540E\u4E0D\u518D\u6807\u8BB0\u3001\u4E0D\u518D\u663E\u793A\u5DEE\u5F02\u3002`, apiAccept(sessionId, selected, opIndex, hunkIndex), () => {
      if (selected) loadSelected(selected);
      refreshChanged();
    });
  };
  const revertFile = () => {
    if (!sessionId || !selected) return;
    doRevert("\u786E\u5B9A\u64A4\u56DE\u8BE5\u6587\u4EF6\u7684\u5168\u90E8\u4FEE\u6539\uFF1F\u6B64\u64CD\u4F5C\u4F1A\u76F4\u63A5\u6539\u5199\u78C1\u76D8\u4E0A\u7684\u6587\u4EF6\u3002", apiRevert(sessionId, selected), () => {
      if (selected) loadSelected(selected);
      refreshChanged();
    });
  };
  const clearAll = () => {
    if (!sessionId || !confirmDialog("\u6E05\u7A7A\u672C\u4F1A\u8BDD\u7684\u6539\u52A8\u8BB0\u5F55\uFF1F")) return;
    apiClear(sessionId).then(() => setOps(null)).catch(() => {
    });
  };
  return h(
    "div",
    { className: "wss-view" },
    h(
      "div",
      { className: "wss-head" },
      h("span", { className: "wss-title" }, "Studio"),
      root ? h("span", { className: "wss-root", title: root }, root) : null,
      h("span", { className: "wss-spacer" }),
      notice ? h("span", { className: "wss-notice" }, notice) : null,
      error ? h("span", { className: "wss-error" }, error) : null,
      h("button", { type: "button", className: "wss-btn", title: "\u5237\u65B0", onClick: () => root && loadTree(root) }, "\u21BB"),
      h("button", { type: "button", className: "wss-btn", title: "\u6E05\u7A7A\u8BB0\u5F55", onClick: clearAll }, "\u6E05\u7A7A")
    ),
    h(
      "div",
      { className: "wss-body" },
      h(
        "div",
        { className: "wss-pane wss-pane-tree" },
        tree ? h(FileTree, {
          tree,
          selected,
          changedPaths,
          onSelect: selectFile
        }) : h("div", { className: "wss-empty" }, "\u52A0\u8F7D\u4E2D\u2026")
      ),
      h(
        "div",
        { className: "wss-pane wss-pane-main" },
        content ? h(CodeViewer, {
          path: selected ?? "",
          content: content.ok ? content.content : "",
          truncated: content.ok ? content.truncated : false,
          error: content.ok ? null : content.error
        }) : h("div", { className: "wss-empty" }, "\u70B9\u51FB\u5DE6\u4FA7\u6587\u4EF6\u67E5\u770B\u5185\u5BB9"),
        h(DiffPanel, { ops, busy, onRevertHunk: revertHunk, onAcceptHunk: acceptHunk, onRevertFile: revertFile })
      )
    )
  );
}

// src/client/index.ts
var inject = ["slots"];
var CSS = `
.wss-view { flex:1 1 0; min-height:0; overflow:hidden; display:flex; flex-direction:column; padding:10px 12px; box-sizing:border-box; font-size:13px; }
.wss-head { display:flex; align-items:center; gap:8px; padding:2px 0 8px; border-bottom:1px solid rgba(128,128,128,0.3); }
.wss-title { font-weight:600; }
.wss-root { opacity:0.6; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:40%; }
.wss-spacer { flex:1; }
.wss-btn { border:none; background:rgba(128,128,128,0.12); color:inherit; cursor:pointer; border-radius:6px; padding:3px 8px; font-size:12px; }
.wss-btn:hover { background:rgba(128,128,128,0.25); }
.wss-btn:disabled { opacity:0.45; cursor:default; }
.wss-btn-danger { color:#cf222e; }
.wss-notice { font-size:12px; color:#1a7f37; background:rgba(46,160,67,0.15); border-radius:6px; padding:2px 8px; }
.wss-error { font-size:12px; color:#cf222e; background:rgba(207,34,46,0.12); border-radius:6px; padding:2px 8px; }
.wss-body { flex:1; display:flex; min-height:0; margin-top:8px; gap:8px; }
.wss-pane { border:1px solid rgba(128,128,128,0.3); border-radius:8px; overflow:hidden; min-height:0; }
.wss-pane-tree { width:230px; flex-shrink:0; overflow:auto; padding:4px 0; }
.wss-pane-main { flex:1; display:flex; flex-direction:column; min-width:0; }
.wss-tree-dir { font-weight:600; padding:3px 8px; opacity:0.85; font-size:12px; }
.wss-tree-file { display:block; width:100%; text-align:left; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:12.5px; padding:3px 8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wss-tree-file:hover { background:rgba(128,128,128,0.12); }
.wss-tree-file.wss-selected { background:rgba(80,120,255,0.2); }
.wss-modified { color:#ff7fae; font-weight:600; }
.wss-dot { margin-left:6px; font-size:9px; color:#ff5c8a; }
.wss-tab-label { display:inline-flex; align-items:center; gap:6px; }
.wss-tab-badge { display:inline-block; border-radius:8px; padding:0 5px; font-size:10px; line-height:14px; font-weight:600; min-width:16px; text-align:center; background:rgba(255,92,138,0.25); color:#ff5c8a; }
.wss-tree-dir { font-weight:600; font-size:12px; }
.wss-tree-dir-head { display:flex; align-items:center; gap:4px; width:100%; text-align:left; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:12.5px; padding:3px 8px; }
.wss-tree-dir-head:hover { background:rgba(128,128,128,0.12); }
.wss-chevron { width:12px; flex-shrink:0; opacity:0.7; font-size:10px; }
.wss-dir-badge { margin-left:6px; font-size:10px; line-height:14px; padding:0 5px; border-radius:8px; background:rgba(255,92,138,0.22); color:#ff5c8a; font-weight:600; }
.wss-empty { padding:18px; text-align:center; opacity:0.6; font-size:12px; }
.wss-viewer { flex:0 0 45%; min-height:0; display:flex; flex-direction:column; border-bottom:1px solid rgba(128,128,128,0.3); }
.wss-viewer-head { display:flex; gap:8px; align-items:center; padding:6px 10px; border-bottom:1px solid rgba(128,128,128,0.2); }
.wss-path { font-size:11.5px; opacity:0.8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wss-hint { font-size:11px; opacity:0.6; }
.wss-viewer-body { flex:1; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
.wss-code-line { display:flex; line-height:1.55; white-space:pre; }
.wss-code-line:hover { background:rgba(128,128,128,0.08); }
.wss-gutter { flex:0 0 40px; text-align:right; padding:0 6px; user-select:none; opacity:0.8; }
.wss-text { flex:1; padding:0 6px; }
.wss-diff { flex:1; min-height:0; overflow:auto; padding:8px 10px; }
.wss-diff-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.wss-op { margin-bottom:10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px; overflow:hidden; }
.wss-op-head { display:flex; gap:8px; align-items:center; padding:5px 10px; background:rgba(128,128,128,0.1); font-weight:600; }
.wss-op-meta { font-weight:400; opacity:0.7; font-size:11px; }
.wss-hunk { border-top:1px solid rgba(128,128,128,0.2); }
.wss-hunk-head { display:flex; gap:8px; align-items:center; padding:4px 10px; font-size:11px; opacity:0.85; }
.wss-hunk-done { color:#1a7f37; }
.wss-hunk-accepted { color:#0969da; }
.wss-btn-accept { color:#0969da; }
.wss-hunk-resolved { opacity:0.75; }
.wss-hunk-resolved .wss-hunk-head { background:rgba(128,128,128,0.06); }
.wss-row { display:flex; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.55; white-space:pre-wrap; word-break:break-all; }
.wss-add { background:rgba(46,160,67,0.18); }
.wss-del { background:rgba(207,34,46,0.16); }
.wss-ctx { background:transparent; }
.wss-sign { flex-basis:18px; text-align:center; }
`;
function apply(ctx) {
  ctx.effect(() => {
    if (typeof document === "undefined") return;
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.appendChild(el);
    return () => el.remove();
  }, "ws-studio: styles");
  ctx.slots.inject(
    "conversation.view",
    () => ctx.slots.register(
      { name: "conversation.view", id: "studio", order: 6, label: () => React2.createElement(StudioTabLabel, null) },
      (props) => React2.createElement(StudioView, props)
    )
  );
}
		return module.exports;
	}
});
