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
var PREFIX = "/api/dsh-workspace-studio";
var TRUST_HEADER = "x-dsh-workspace-studio";
var ApiError = class extends Error {
  status;
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
};
function payloadError(payload) {
  if (payload !== null && typeof payload === "object") {
    const e = payload.error;
    if (typeof e === "string" && e.trim() !== "") return e;
  }
  return "";
}
async function apiJson(url, init) {
  const headers = { [TRUST_HEADER]: "1" };
  const given = init?.headers;
  if (given) for (const [k, v] of Object.entries(given)) headers[k] = v;
  const res = await fetch(url, { ...init, headers });
  let payload;
  let parsed = true;
  try {
    payload = await res.json();
  } catch {
    parsed = false;
    payload = void 0;
  }
  if (!res.ok) {
    const detail = payloadError(payload);
    throw new ApiError(`HTTP ${res.status}${detail ? `\uFF1A${detail}` : ""}`, res.status);
  }
  if (!parsed) throw new ApiError("\u5BBF\u4E3B\u8FD4\u56DE\u7684\u4E0D\u662F\u6709\u6548\u7684 JSON", res.status);
  if (payload !== null && typeof payload === "object" && payload.ok === false) {
    throw new ApiError(payloadError(payload) || "\u8BF7\u6C42\u88AB\u5BBF\u4E3B\u62D2\u7EDD", res.status);
  }
  return payload;
}
function postJson(path, body) {
  return apiJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
function apiTree(root) {
  return apiJson(`${PREFIX}/tree?root=${encodeURIComponent(root)}`);
}
function apiFile(path) {
  return apiJson(`${PREFIX}/file?path=${encodeURIComponent(path)}`);
}
function apiContext(session) {
  return apiJson(`${PREFIX}/context?session=${encodeURIComponent(session)}`);
}
function apiOps(session, file) {
  const fileQ = file ? `&file=${encodeURIComponent(file)}` : "";
  return apiJson(`${PREFIX}/ops?session=${encodeURIComponent(session)}${fileQ}`);
}
function apiRevert(session, path, opId, hunk) {
  const body = { path };
  if (hunk != null) {
    if (!opId) {
      return Promise.reject(new ApiError("\u8BE5\u64CD\u4F5C\u8BB0\u5F55\u7F3A\u5C11 opId\uFF08\u670D\u52A1\u7AEF\u672A\u4E0B\u53D1\uFF09\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5"));
    }
    body.opId = opId;
    body.hunk = hunk;
  }
  return postJson(`${PREFIX}/revert?session=${encodeURIComponent(session)}`, body);
}
function apiAccept(session, path, opId, hunk) {
  if (!opId) {
    return Promise.reject(new ApiError("\u8BE5\u64CD\u4F5C\u8BB0\u5F55\u7F3A\u5C11 opId\uFF08\u670D\u52A1\u7AEF\u672A\u4E0B\u53D1\uFF09\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5"));
  }
  return postJson(`${PREFIX}/accept?session=${encodeURIComponent(session)}`, { path, opId, hunk });
}
function apiAcceptAll(session, path) {
  return postJson(`${PREFIX}/accept-all?session=${encodeURIComponent(session)}`, { path });
}
function apiClear(session) {
  return postJson(`${PREFIX}/clear?session=${encodeURIComponent(session)}`, {});
}
var EVENTS_URL = `${PREFIX}/events`;

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
function isFileEntryArray(value) {
  if (!Array.isArray(value)) return false;
  return value.every((n) => {
    if (n === null || typeof n !== "object") return false;
    const e = n;
    return typeof e.path === "string" && typeof e.name === "string";
  });
}
function isOpsPayload(value) {
  if (value === null || typeof value !== "object") return false;
  const files = value.files;
  if (!Array.isArray(files)) return false;
  return files.every((f) => {
    if (f === null || typeof f !== "object") return false;
    const file = f;
    return typeof file.path === "string" && Array.isArray(file.ops);
  });
}
function opIdOf(op) {
  const id = op?.id;
  return typeof id === "string" && id !== "" ? id : null;
}
function createSeqGuard(ref) {
  return {
    next: () => ref.current += 1,
    current: () => ref.current,
    isCurrent: (seq) => seq === ref.current,
    invalidate: () => {
      ref.current += 1;
    }
  };
}
function hunkListOf(op) {
  return Array.isArray(op.hunks) ? op.hunks : [];
}
function resolvedHunksOf(op, key) {
  const v = op[key];
  return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
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
  if (!isFileEntryArray(props.tree)) {
    return h("div", { className: "wss-empty" }, "\u6587\u4EF6\u6811\u6570\u636E\u683C\u5F0F\u5F02\u5E38\uFF0C\u70B9 \u21BB \u91CD\u8BD5");
  }
  if (props.tree.length === 0) {
    return h("div", { className: "wss-empty" }, "\u5DE5\u4F5C\u533A\u91CC\u6CA1\u6709\u53EF\u663E\u793A\u7684\u6587\u4EF6");
  }
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
  if (!props.ops || !isOpsPayload(props.ops) || props.ops.files.length === 0) {
    return h("div", { className: "wss-empty" }, "\u6682\u65E0\u6539\u52A8\u8BB0\u5F55\uFF08\u672C\u4F1A\u8BDD\u5185 write/edit \u8FC7\u7684\u6587\u4EF6\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\uFF09");
  }
  const file = props.ops.files[0];
  const pendingHunks = file.ops.reduce((n, op) => {
    const reverted = resolvedHunksOf(op, "revertedHunks");
    const accepted = resolvedHunksOf(op, "acceptedHunks");
    return n + hunkListOf(op).filter((_, hi) => !reverted.includes(hi) && !accepted.includes(hi)).length;
  }, 0);
  const sections = [
    h(
      "div",
      { className: "wss-diff-head" },
      h("span", { className: "wss-path", title: file.path }, file.path),
      h(
        "button",
        {
          type: "button",
          className: "wss-btn wss-btn-accept",
          disabled: props.busy || pendingHunks === 0,
          onClick: props.onAcceptAll,
          title: "\u8BA4\u53EF\u8BE5\u6587\u4EF6\u7684\u5168\u90E8\u5F85\u5904\u7406\u53D8\u66F4\u5757"
        },
        pendingHunks > 0 ? `\u4E00\u952E\u540C\u610F\uFF08${pendingHunks} \u5757\uFF09` : "\u4E00\u952E\u540C\u610F"
      ),
      h(
        "button",
        { type: "button", className: "wss-btn wss-btn-danger", disabled: props.busy, onClick: props.onRevertFile },
        "\u64A4\u56DE\u5168\u90E8\u4FEE\u6539"
      )
    )
  ];
  for (const op of file.ops) {
    const hunks = hunkListOf(op);
    const revertedHunks = resolvedHunksOf(op, "revertedHunks");
    const acceptedHunks = resolvedHunksOf(op, "acceptedHunks");
    const target = { opId: opIdOf(op), opIndex: typeof op.index === "number" ? op.index : 0 };
    const opParts = [
      h(
        "div",
        { className: "wss-op-head" },
        h("span", { className: "wss-op-title" }, `\u64CD\u4F5C ${target.opIndex + 1}`),
        h("span", { className: "wss-op-meta" }, op.turn != null ? `\u8F6E\u6B21 ${op.turn} \xB7 ` : "", `+${op.added ?? 0} \u2212${op.removed ?? 0}`),
        // 契约 §7：占位记录（快照过大被截断）要显式说明，别让用户以为是空文件
        op.truncated ? h("span", { className: "wss-hint" }, "\u5FEB\u7167\u8FC7\u5927\uFF0C\u4E0D\u53EF\u64A4\u56DE") : null
      )
    ];
    hunks.forEach((hunk, hi) => {
      const reverted = revertedHunks.includes(hi);
      const accepted = acceptedHunks.includes(hi);
      const resolved = reverted || accepted;
      const head = h(
        "div",
        { className: "wss-hunk-head" },
        h("span", { className: "wss-hunk-title" }, `\u53D8\u66F4\u5757 ${hi + 1}/${hunks.length}`),
        reverted ? h("span", { className: "wss-hunk-done" }, "\u5DF2\u64A4\u56DE") : accepted ? h("span", { className: "wss-hunk-accepted" }, "\u5DF2\u8BA4\u53EF") : null,
        h("span", { className: "wss-spacer" }),
        reverted || accepted ? null : h(
          "button",
          {
            type: "button",
            className: "wss-btn wss-btn-accept",
            disabled: props.busy || !op.revertible,
            onClick: () => props.onAcceptHunk(target, hi)
          },
          "\u8BA4\u53EF"
        ),
        reverted || accepted ? null : h(
          "button",
          {
            type: "button",
            className: "wss-btn",
            disabled: props.busy || !op.revertible,
            onClick: () => props.onRevertHunk(target, hi)
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
    sections.push(h("div", { key: target.opIndex, className: "wss-op" }, ...opParts));
  }
  return h("div", { className: "wss-diff" }, ...sections);
}
function confirmDialog(msg) {
  return typeof window !== "undefined" ? window.confirm(msg) : true;
}
function errorText(e) {
  const msg = e?.message;
  return String(msg ?? e);
}
function StudioView(props) {
  const sessionId = props.sessionId ?? "";
  const [root, setRoot] = React.useState(null);
  const [tree, setTree] = React.useState(null);
  const [treeError, setTreeError] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [content, setContent] = React.useState(null);
  const [fileError, setFileError] = React.useState(null);
  const [ops, setOps] = React.useState(null);
  const [opsError, setOpsError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [changedPaths, setChangedPathsLocal] = React.useState(() => [...changeStore.paths]);
  React.useEffect(() => subscribeChanges(() => setChangedPathsLocal([...changeStore.paths])), []);
  const treeGuard = createSeqGuard(React.useRef(0));
  const selGuard = createSeqGuard(React.useRef(0));
  const loadTree = (r) => {
    const seq = treeGuard.next();
    apiTree(r).then((t) => {
      if (!treeGuard.isCurrent(seq)) return;
      if (!isFileEntryArray(t)) {
        setTree(null);
        setTreeError("\u6587\u4EF6\u6811\u6570\u636E\u683C\u5F0F\u5F02\u5E38");
        return;
      }
      setTree(t);
      setTreeError(null);
    }).catch((e) => {
      if (!treeGuard.isCurrent(seq)) return;
      setTree(null);
      setTreeError(errorText(e));
    });
  };
  const loadSelected = (p) => {
    const seq = selGuard.next();
    setContent(null);
    setFileError(null);
    setOps(null);
    setOpsError(null);
    apiFile(p).then((r) => {
      if (!selGuard.isCurrent(seq)) return;
      setContent(r);
    }).catch((e) => {
      if (!selGuard.isCurrent(seq)) return;
      setContent(null);
      setFileError(errorText(e));
    });
    if (!sessionId) return;
    apiOps(sessionId, p).then((r) => {
      if (!selGuard.isCurrent(seq)) return;
      if (!isOpsPayload(r)) {
        setOps(null);
        setOpsError("\u6539\u52A8\u8BB0\u5F55\u6570\u636E\u683C\u5F0F\u5F02\u5E38");
        return;
      }
      setOps(r);
      setOpsError(null);
    }).catch((e) => {
      if (!selGuard.isCurrent(seq)) return;
      setOps(null);
      setOpsError(errorText(e));
    });
  };
  const refreshOps = () => {
    if (!sessionId || !selected) return;
    const seq = selGuard.current();
    apiOps(sessionId, selected).then((r) => {
      if (!selGuard.isCurrent(seq)) return;
      if (!isOpsPayload(r)) {
        setOps(null);
        setOpsError("\u6539\u52A8\u8BB0\u5F55\u6570\u636E\u683C\u5F0F\u5F02\u5E38");
        return;
      }
      setOps(r);
      setOpsError(null);
    }).catch((e) => {
      if (!selGuard.isCurrent(seq)) return;
      setOps(null);
      setOpsError(errorText(e));
    });
  };
  const refreshChanged = () => {
    if (!sessionId) return;
    apiOps(sessionId).then((p) => setChangedPaths(isOpsPayload(p) ? p.files.map((f) => f.path) : [])).catch(() => {
    });
  };
  const loadContext = () => {
    if (!sessionId) return;
    const seq = treeGuard.next();
    apiContext(sessionId).then((c) => {
      if (!treeGuard.isCurrent(seq)) return;
      const cwd = typeof c?.cwd === "string" && c.cwd !== "" ? c.cwd : null;
      if (cwd) {
        setRoot(cwd);
        loadTree(cwd);
      } else {
        setRoot(null);
        setTree(null);
        setTreeError("\u672A\u53D6\u5230\u8BE5\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u5DE5\u4F5C\u533A");
      }
    }).catch((e) => {
      if (!treeGuard.isCurrent(seq)) return;
      setTreeError(`\u4F1A\u8BDD\u4E0A\u4E0B\u6587\u8BFB\u53D6\u5931\u8D25\uFF1A${errorText(e)}`);
    });
  };
  const refreshRef = React.useRef(() => {
  });
  refreshRef.current = () => {
    refreshOps();
    refreshChanged();
  };
  React.useEffect(() => {
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
    if (!sessionId) return void 0;
    loadContext();
    refreshChanged();
    return void 0;
  }, [sessionId]);
  React.useEffect(() => {
    if (!sessionId) return void 0;
    if (typeof EventSource === "undefined") return void 0;
    const es = new EventSource(EVENTS_URL);
    es.onmessage = () => {
      refreshRef.current();
    };
    return () => es.close();
  }, [sessionId]);
  const selectFile = (p) => {
    setSelected(p);
    setNotice(null);
    setError(null);
    loadSelected(p);
  };
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
  const doAction = (msg, run, after) => {
    if (!confirmDialog(msg)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let pending;
    try {
      pending = run();
    } catch (e) {
      setBusy(false);
      setError(`\u64CD\u4F5C\u5931\u8D25\uFF1A${errorText(e)}`);
      return;
    }
    pending.then((v) => {
      if (v && v.ok) {
        setNotice(v.message);
        after();
      } else {
        setError(`\u64CD\u4F5C\u5931\u8D25\uFF1A${v?.error ?? "\u672A\u77E5\u9519\u8BEF"}`);
      }
    }).catch((e) => setError(`\u64CD\u4F5C\u5931\u8D25\uFF1A${errorText(e)}`)).finally(() => setBusy(false));
  };
  const revertHunk = (target, hunkIndex) => {
    if (!sessionId || !selected) return;
    const path = selected;
    doAction(
      "\u786E\u5B9A\u64A4\u56DE\u8FD9\u4E2A\u53D8\u66F4\u5757\uFF1F\u6B64\u64CD\u4F5C\u4F1A\u76F4\u63A5\u6539\u5199\u78C1\u76D8\u4E0A\u7684\u6587\u4EF6\u3002",
      () => apiRevert(sessionId, path, target.opId, hunkIndex),
      () => {
        loadSelected(path);
        refreshChanged();
      }
    );
  };
  const acceptHunk = (target, hunkIndex) => {
    if (!sessionId || !selected) return;
    const path = selected;
    const opId = target.opId;
    if (!opId) {
      setError("\u8BE5\u64CD\u4F5C\u8BB0\u5F55\u7F3A\u5C11 opId\uFF08\u670D\u52A1\u7AEF\u672A\u4E0B\u53D1\uFF09\uFF0C\u8BF7\u70B9 \u21BB \u5237\u65B0\u540E\u91CD\u8BD5");
      return;
    }
    doAction(
      "\u786E\u5B9A\u8BA4\u53EF\u8FD9\u4E2A\u53D8\u66F4\u5757\uFF1F\u8BA4\u53EF\u540E\u4E0D\u518D\u6807\u8BB0\u3001\u4E0D\u518D\u663E\u793A\u5DEE\u5F02\u3002",
      () => apiAccept(sessionId, path, opId, hunkIndex),
      () => {
        loadSelected(path);
        refreshChanged();
      }
    );
  };
  const revertFile = () => {
    if (!sessionId || !selected) return;
    const path = selected;
    doAction(
      "\u786E\u5B9A\u64A4\u56DE\u8BE5\u6587\u4EF6\u7684\u5168\u90E8\u4FEE\u6539\uFF1F\u6B64\u64CD\u4F5C\u4F1A\u76F4\u63A5\u6539\u5199\u78C1\u76D8\u4E0A\u7684\u6587\u4EF6\u3002",
      () => apiRevert(sessionId, path),
      () => {
        loadSelected(path);
        refreshChanged();
      }
    );
  };
  const acceptAll = () => {
    if (!sessionId || !selected) return;
    const path = selected;
    doAction(
      "\u786E\u5B9A\u8BA4\u53EF\u8BE5\u6587\u4EF6\u7684\u5168\u90E8\u5F85\u5904\u7406\u53D8\u66F4\u5757\uFF1F\u8BA4\u53EF\u540E\u4E0D\u518D\u6807\u8BB0\u3001\u4E0D\u518D\u663E\u793A\u5DEE\u5F02\u3002",
      () => apiAcceptAll(sessionId, path),
      () => {
        loadSelected(path);
        refreshChanged();
      }
    );
  };
  const clearAll = () => {
    if (!sessionId || !confirmDialog("\u6E05\u7A7A\u672C\u4F1A\u8BDD\u7684\u6539\u52A8\u8BB0\u5F55\uFF1F")) return;
    apiClear(sessionId).then(() => {
      setOps(null);
      setOpsError(null);
      setNotice("\u5DF2\u6E05\u7A7A\u672C\u4F1A\u8BDD\u7684\u6539\u52A8\u8BB0\u5F55");
      refreshChanged();
    }).catch((e) => setError(`\u6E05\u7A7A\u5931\u8D25\uFF1A${errorText(e)}`));
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
      h("button", { type: "button", className: "wss-btn", title: "\u5237\u65B0", onClick: reload }, "\u21BB"),
      h("button", { type: "button", className: "wss-btn", title: "\u6E05\u7A7A\u8BB0\u5F55", onClick: clearAll }, "\u6E05\u7A7A")
    ),
    h(
      "div",
      { className: "wss-body" },
      h(
        "div",
        { className: "wss-pane wss-pane-tree" },
        treeError ? h("div", { className: "wss-empty" }, `\u6587\u4EF6\u6811\u52A0\u8F7D\u5931\u8D25\uFF1A${treeError}\uFF08\u70B9 \u21BB \u91CD\u8BD5\uFF09`) : tree ? h(FileTree, { tree, selected, changedPaths, onSelect: selectFile }) : h("div", { className: "wss-empty" }, "\u52A0\u8F7D\u4E2D\u2026")
      ),
      h(
        "div",
        { className: "wss-pane wss-pane-main" },
        content ? h(CodeViewer, {
          path: selected ?? "",
          content: content.ok ? content.content : "",
          truncated: content.ok ? content.truncated : false,
          error: content.ok ? null : content.error
        }) : fileError ? h("div", { className: "wss-empty" }, `\u6587\u4EF6\u52A0\u8F7D\u5931\u8D25\uFF1A${fileError}`) : h("div", { className: "wss-empty" }, "\u70B9\u51FB\u5DE6\u4FA7\u6587\u4EF6\u67E5\u770B\u5185\u5BB9"),
        opsError ? h("div", { className: "wss-empty" }, `\u6539\u52A8\u8BB0\u5F55\u52A0\u8F7D\u5931\u8D25\uFF1A${opsError}\uFF08\u70B9 \u21BB \u91CD\u8BD5\uFF09`) : h(DiffPanel, { ops, busy, onRevertHunk: revertHunk, onAcceptHunk: acceptHunk, onRevertFile: revertFile, onAcceptAll: acceptAll })
      )
    )
  );
}

// src/client/index.ts
var inject = ["slots"];
var SlotBoundary = class extends React2.Component {
  static getDerivedStateFromError() {
    return { failed: true };
  }
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  render() {
    if (this.state.failed) {
      return React2.createElement(
        "div",
        { className: "wss-empty" },
        "Studio \u6E32\u67D3\u5931\u8D25\uFF08\u63D2\u4EF6\u5DF2\u9694\u79BB\uFF0C\u4E0D\u5F71\u54CD\u5176\u5B83\u6807\u7B7E\uFF09\u3002\u8BF7\u628A\u65E5\u5FD7\u53CD\u9988\u7ED9\u63D2\u4EF6\u4F5C\u8005\u3002"
      );
    }
    return this.props.children;
  }
};
function withSlotBoundary(Inner) {
  const Wrapped = (props) => React2.createElement(SlotBoundary, null, React2.createElement(Inner, props));
  Wrapped.displayName = "WorkspaceStudioBoundary";
  return Wrapped;
}
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
      {
        name: "conversation.view",
        id: "studio",
        order: 6,
        // label 必须是**字符串**：返回 React 元素会让宿主标签栏渲染失败（实测会把整条
        // 标签栏渲染成空白，其它标签一起消失）。对照 crossfire 的可用实现也是返回字符串。
        label: () => "Studio"
      },
      withSlotBoundary((props) => React2.createElement(StudioView, props))
    )
  );
}
		return module.exports;
	}
});
