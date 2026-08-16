// src/host/index.ts
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";

// src/core/ledger.ts
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var DEFAULT_LEDGER_OPTIONS = {
  maxOpsPerFile: 100,
  maxOpBytes: 120 * 1024
};
var ChangeLedger = class {
  ops = [];
  options;
  constructor(options = DEFAULT_LEDGER_OPTIONS) {
    this.options = options;
  }
  add(op) {
    const beforeLen = typeof op.before === "string" ? op.before.length : 0;
    if (beforeLen > this.options.maxOpBytes || op.after.length > this.options.maxOpBytes) {
      const record2 = { ...op, id: randomUUID(), ts: Date.now(), before: "", after: "" };
      this.ops.push(record2);
      return record2;
    }
    const record = { ...op, id: randomUUID(), ts: Date.now() };
    this.ops.push(record);
    this.pruneFile(op.filePath);
    return record;
  }
  /** 标记某操作的一个 hunk 已撤回；返回是否成功标记。 */
  markHunkReverted(opId, hunkIndex) {
    const op = this.ops.find((o) => o.id === opId);
    if (!op) return false;
    if (!op.revertedHunks) op.revertedHunks = [];
    if (!op.revertedHunks.includes(hunkIndex)) op.revertedHunks.push(hunkIndex);
    return true;
  }
  /** 标记某操作的一个 hunk 已认可（确认保留）；返回是否成功标记。 */
  markHunkAccepted(opId, hunkIndex) {
    const op = this.ops.find((o) => o.id === opId);
    if (!op) return false;
    if (!op.acceptedHunks) op.acceptedHunks = [];
    if (!op.acceptedHunks.includes(hunkIndex)) op.acceptedHunks.push(hunkIndex);
    return true;
  }
  /** 移除某文件在某会话下的全部操作记录（整文件撤回后调用）。 */
  removeOpsForFileInSession(sessionId, filePath) {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => !(o.sessionId === sessionId && o.filePath === filePath));
    return before - this.ops.length;
  }
  /** 每个文件最多保留 maxOpsPerFile 条，超出丢最旧。 */
  pruneFile(filePath) {
    const max = this.options.maxOpsPerFile;
    const idxs = [];
    for (let i = 0; i < this.ops.length; i++) if (this.ops[i].filePath === filePath) idxs.push(i);
    while (idxs.length > max) {
      const victim = idxs.shift();
      this.ops.splice(victim, 1);
      for (let k = 0; k < idxs.length; k++) if (idxs[k] > victim) idxs[k]--;
    }
  }
  all() {
    return this.ops;
  }
  opsForFile(filePath) {
    return this.ops.filter((o) => o.filePath === filePath);
  }
  opsForSession(sessionId) {
    return this.ops.filter((o) => o.sessionId === sessionId);
  }
  filesForSession(sessionId) {
    return [...new Set(this.opsForSession(sessionId).map((o) => o.filePath))];
  }
  clearSession(sessionId) {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => o.sessionId !== sessionId);
    return before - this.ops.length;
  }
  clear() {
    this.ops = [];
  }
  load(path) {
    try {
      const raw = readFileSync(path, "utf8");
      const state = JSON.parse(raw);
      this.ops = Array.isArray(state.ops) ? state.ops : [];
    } catch {
      this.ops = [];
    }
  }
  save(path) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ops: this.ops }), "utf8");
    renameSync(tmp, path);
  }
};

// src/core/diff.ts
var DEFAULT_CONTEXT = 3;
function diffLines(before, after) {
  if (before.length === 0) {
    return after.length === 0 ? [] : [{ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: after.length, removed: [], added: [...after] }];
  }
  if (after.length === 0) {
    return [{ oldStart: 1, oldEnd: before.length, newStart: 1, newEnd: 0, removed: [...before], added: [] }];
  }
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) {
    s++;
  }
  const midB = before.slice(p, before.length - s);
  const midA = after.slice(p, after.length - s);
  const blocks = lcs(midB, midA);
  for (const b of blocks) {
    b.oldStart += p;
    b.oldEnd += p;
    b.newStart += p;
    b.newEnd += p;
  }
  return blocks;
}
function lcs(b, a) {
  if (b.length === 0) {
    return a.length === 0 ? [] : [{ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: a.length, removed: [], added: [...a] }];
  }
  if (a.length === 0) {
    return [{ oldStart: 1, oldEnd: b.length, newStart: 1, newEnd: 0, removed: [...b], added: [] }];
  }
  const n = b.length;
  const m = a.length;
  const row = m + 1;
  const dp = new Int32Array((n + 1) * row);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      dp[i2 * row + j2] = b[i2] === a[j2] ? dp[(i2 + 1) * row + j2 + 1] + 1 : Math.max(dp[(i2 + 1) * row + j2], dp[i2 * row + j2 + 1]);
    }
  }
  const blocks = [];
  let removed = [];
  let added = [];
  let oldStart = 0;
  let newStart = 0;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (removed.length > 0 || added.length > 0) {
      blocks.push({
        oldStart,
        oldEnd: oldStart + removed.length - 1,
        newStart,
        newEnd: newStart + added.length - 1,
        removed,
        added
      });
      removed = [];
      added = [];
    }
  };
  while (i < n && j < m) {
    if (b[i] === a[j]) {
      flush();
      i++;
      j++;
    } else if (dp[(i + 1) * row + j] >= dp[i * row + j + 1]) {
      if (removed.length === 0 && added.length === 0) {
        oldStart = i + 1;
        newStart = j + 1;
      }
      removed.push(b[i]);
      i++;
    } else {
      if (removed.length === 0 && added.length === 0) {
        oldStart = i + 1;
        newStart = j + 1;
      }
      added.push(a[j]);
      j++;
    }
  }
  while (i < n) {
    if (removed.length === 0 && added.length === 0) {
      oldStart = i + 1;
      newStart = j + 1;
    }
    removed.push(b[i]);
    i++;
  }
  while (j < m) {
    if (removed.length === 0 && added.length === 0) {
      oldStart = i + 1;
      newStart = j + 1;
    }
    added.push(a[j]);
    j++;
  }
  flush();
  return blocks;
}
function diffHunks(before, after, context = DEFAULT_CONTEXT) {
  const blocks = diffLines(before, after);
  const hunks = [];
  for (const blk of blocks) {
    const afterStartIdx = blk.oldEnd >= blk.oldStart ? blk.oldEnd : blk.oldStart - 1;
    const ctxBefore = before.slice(Math.max(0, blk.oldStart - 1 - context), blk.oldStart - 1);
    const ctxAfter = before.slice(afterStartIdx, Math.min(before.length, afterStartIdx + context));
    hunks.push({
      oldStart: Math.max(1, blk.oldStart - context),
      newStart: Math.max(1, blk.newStart - context),
      ctxBefore,
      ctxAfter,
      removed: [...blk.removed],
      added: [...blk.added]
    });
  }
  return hunks;
}

// src/core/hunkRevert.ts
var DEFAULT_REVERT_OPTIONS = { window: 1e3, context: 3 };
function revertHunk(currentLines, before, after, hunkIndex, options = DEFAULT_REVERT_OPTIONS) {
  const hunks = diffHunks(before.split("\n"), after.split("\n"), options.context);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    return { ok: false, reason: `\u53D8\u66F4\u5757 ${hunkIndex} \u4E0D\u5B58\u5728\uFF08\u8BE5\u64CD\u4F5C\u5171\u6709 ${hunks.length} \u4E2A\u53D8\u66F4\u5757\uFF09` };
  }
  const applied = applyHunk(currentLines, hunk, options);
  if (!applied.ok) return applied;
  return { ok: true, content: applied.lines.join("\n"), revertedHunk: hunkIndex };
}
function applyHunk(current, hunk, options) {
  if (hunk.added.length > 0) {
    const idx2 = indexOfBlock(current, hunk.added, hunk.newStart - 1, options.window);
    if (idx2 < 0) return { ok: false, reason: "\u8BE5\u53D8\u66F4\u5757\u7684\u4EE3\u7801\u5DF2\u88AB\u540E\u7EED\u4FEE\u6539\u8986\u76D6\uFF0C\u65E0\u6CD5\u64A4\u56DE" };
    const lines2 = [...current.slice(0, idx2), ...hunk.removed, ...current.slice(idx2 + hunk.added.length)];
    return { ok: true, lines: lines2 };
  }
  const marker = [...hunk.ctxBefore, ...hunk.ctxAfter];
  const idx = indexOfBlock(current, marker, Math.max(0, hunk.newStart - 1 - hunk.ctxBefore.length), options.window);
  if (idx < 0) return { ok: false, reason: "\u8BE5\u5220\u9664\u4F4D\u7F6E\u7684\u4E0A\u4E0B\u6587\u5DF2\u88AB\u540E\u7EED\u4FEE\u6539\u8986\u76D6\uFF0C\u65E0\u6CD5\u64A4\u56DE" };
  const insAt = idx + hunk.ctxBefore.length;
  const lines = [...current.slice(0, insAt), ...hunk.removed, ...current.slice(insAt)];
  return { ok: true, lines };
}
function indexOfBlock(lines, block, expected, window) {
  if (block.length === 0) return -1;
  const start = Math.max(0, expected - window);
  const end = Math.min(lines.length - block.length, expected + window);
  for (let i = start; i <= end; i++) {
    if (lines[i] === block[0] && eqBlock(lines, i, block)) return i;
  }
  for (let i = 0; i <= lines.length - block.length; i++) {
    if (lines[i] === block[0] && eqBlock(lines, i, block)) return i;
  }
  return -1;
}
function eqBlock(lines, at, block) {
  for (let k = 0; k < block.length; k++) {
    if (lines[at + k] !== block[k]) return false;
  }
  return true;
}

// src/core/fileTree.ts
var DEFAULT_TREE_OPTIONS = {
  maxDepth: 12,
  maxEntries: 2e3,
  ignore: [
    ".git",
    ".hg",
    ".svn",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".DS_Store",
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    "bin",
    "obj",
    ".venv",
    "venv",
    "__pycache__",
    ".dsh",
    ".idea",
    ".vscode",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "coverage",
    ".next",
    ".nuxt",
    ".parcel-cache"
  ]
};
async function buildFileTree(root, reader, options = DEFAULT_TREE_OPTIONS) {
  const normRoot = root.replace(/\\/g, "/");
  return walk(normRoot, reader, options, 0, { count: 0 });
}
async function walk(dir, reader, options, depth, budget) {
  if (depth > options.maxDepth) return [];
  let entries;
  try {
    entries = await reader.listDir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (options.ignore.includes(e.name)) continue;
    if (budget.count >= options.maxEntries) break;
    budget.count++;
    const full = `${dir.replace(/[\\/]+$/, "")}/${e.name}`;
    if (e.isDir) {
      const children = await walk(full, reader, options, depth + 1, budget);
      out.push({ name: e.name, path: full, isDir: true, children });
    } else {
      out.push({ name: e.name, path: full, isDir: false });
    }
  }
  return out;
}

// src/host/service.ts
var DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
var normPath = (p) => p.replace(/\\/g, "/");
var CtxFsReader = class {
  fs;
  constructor(fs) {
    this.fs = fs;
  }
  async listDir(path) {
    const target = await this.fs.resolve(path);
    const entries = await this.fs.listDir(target);
    return entries.map((e) => ({ name: e.name, isDir: e.type === "directory" }));
  }
};
var NodeFsReader = class {
  async listDir(path) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
};
var WsStudioService = class {
  listeners = /* @__PURE__ */ new Set();
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  /** 会话上下文（浏览器侧默认文件树根目录） */
  sessionContext(sessionId) {
    return { cwd: this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : void 0 };
  }
  /** 会话级沙箱策略：撤回写入按会话工作区根放行（workspace-write），避免命中部署默认根。 */
  sandboxPolicyFor(sessionId) {
    const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : void 0;
    return cwd ? { mode: "workspace-write", workspaceRoot: cwd } : void 0;
  }
  /** 变更订阅（SSE 广播用）；返回取消函数。 */
  onChanged(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  notifyChanged(sessionId) {
    for (const cb of [...this.listeners]) {
      try {
        cb(sessionId);
      } catch {
      }
    }
  }
  resolveRoot(agentId) {
    return this.deps.resolveRoot ? this.deps.resolveRoot(agentId) : agentId;
  }
  currentTurn(rootId) {
    return this.deps.currentTurn ? this.deps.currentTurn(rootId) : null;
  }
  reader() {
    if (this.deps.fs) return new CtxFsReader(this.deps.fs);
    return new NodeFsReader();
  }
  /** ① 工作区文件树 */
  async tree(root) {
    return buildFileTree(root, this.reader(), this.deps.treeOptions);
  }
  /** ② 读取文件内容（带大小上限） */
  async readFileText(path) {
    const max = this.deps.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    try {
      let content;
      if (this.deps.fs) {
        const target = await this.deps.fs.resolve(path);
        const info = await this.deps.fs.stat(target);
        if (!info) return { ok: false, error: `\u6587\u4EF6\u4E0D\u5B58\u5728: ${path}` };
        if (info.type !== "file") return { ok: false, error: `\u4E0D\u662F\u666E\u901A\u6587\u4EF6: ${path}` };
        if (typeof info.size === "number" && info.size > max) {
          return { ok: false, error: `\u6587\u4EF6\u8FC7\u5927\uFF08${info.size} \u5B57\u8282\uFF0C\u4E0A\u9650 ${max}\uFF09` };
        }
        content = await this.deps.fs.readText(target);
      } else if (this.deps.nodeRead) {
        content = await this.deps.nodeRead(path);
      } else {
        const { readFile } = await import("node:fs/promises");
        const buf = await readFile(path);
        if (buf.byteLength > max) return { ok: false, error: `\u6587\u4EF6\u8FC7\u5927\uFF08${buf.byteLength} \u5B57\u8282\uFF0C\u4E0A\u9650 ${max}\uFF09` };
        content = buf.toString("utf8");
      }
      const truncated = content.length > max;
      return { ok: true, content: truncated ? content.slice(0, max) : content, truncated };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  }
  /** ③ 某会话（可选限定文件）的变更列表：每个操作的 hunks */
  opsFor(sessionId, filePath) {
    const paths = filePath ? [filePath] : this.deps.ledger.filesForSession(sessionId);
    const files = [];
    for (const p of paths) {
      const np = normPath(p);
      const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
      if (ops.length === 0) continue;
      const views = ops.map((op, index) => this.viewOf(op, index));
      const pending = views.some((v) => v.pending);
      if (!filePath && !pending) continue;
      files.push({
        path: np,
        latestAt: Math.max(...ops.map((o) => o.ts), 0),
        ops: views,
        pending
      });
    }
    files.sort((x, y) => y.latestAt - x.latestAt);
    return { files };
  }
  viewOf(op, index) {
    const revertible = op.before !== void 0 && op.before !== "" && op.after !== "";
    let hunks = [];
    if (op.before !== void 0 && op.before !== null && op.before !== "" && op.after !== "") {
      hunks = diffHunks(op.before.split("\n"), op.after.split("\n"));
    }
    const revertedHunks = op.revertedHunks ? [...op.revertedHunks] : [];
    const acceptedHunks = op.acceptedHunks ? [...op.acceptedHunks] : [];
    const resolved = /* @__PURE__ */ new Set([...revertedHunks, ...acceptedHunks]);
    const pending = hunks.length > 0 && hunks.some((_, i) => !resolved.has(i));
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      added += h.added.length;
      removed += h.removed.length;
    }
    return {
      index,
      at: op.ts,
      turn: op.turn,
      hunks,
      revertedHunks,
      acceptedHunks,
      revertible,
      pending,
      added,
      removed
    };
  }
  /** ④c 认可一个变更块（确认保留，不再标记、不再显示差异） */
  async acceptHunk(sessionId, filePath, opIndex, hunkIndex) {
    const np = normPath(filePath);
    const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
    const op = ops[opIndex];
    if (!op) return { ok: false, error: `\u64CD\u4F5C\u7D22\u5F15\u65E0\u6548\uFF08\u5171 ${ops.length} \u6761\u8BB0\u5F55\uFF09` };
    const hunkCount = this.viewOf(op, opIndex).hunks.length;
    if (hunkIndex < 0 || hunkIndex >= hunkCount) {
      return { ok: false, error: `\u53D8\u66F4\u5757\u7D22\u5F15\u65E0\u6548\uFF08\u8BE5\u64CD\u4F5C\u5171\u6709 ${hunkCount} \u4E2A\u53D8\u66F4\u5757\uFF09` };
    }
    const reverted = op.revertedHunks ?? [];
    const accepted = op.acceptedHunks ?? [];
    if (reverted.includes(hunkIndex)) return { ok: false, error: "\u8BE5\u53D8\u66F4\u5757\u5DF2\u64A4\u56DE\uFF0C\u65E0\u9700\u8BA4\u53EF" };
    if (accepted.includes(hunkIndex)) return { ok: false, error: "\u8BE5\u53D8\u66F4\u5757\u5DF2\u8BA4\u53EF" };
    this.deps.ledger.markHunkAccepted(op.id, hunkIndex);
    this.notifyChanged(sessionId);
    return { ok: true, message: `\u5DF2\u8BA4\u53EF\u53D8\u66F4\u5757 ${hunkIndex + 1}` };
  }
  /** ④a hunk 级部分撤回 */
  async revertHunk(sessionId, filePath, opIndex, hunkIndex) {
    const np = normPath(filePath);
    const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
    const op = ops[opIndex];
    if (!op) return { ok: false, error: `\u64CD\u4F5C\u7D22\u5F15\u65E0\u6548\uFF08\u5171 ${ops.length} \u6761\u8BB0\u5F55\uFF09` };
    if (op.before === void 0 || op.before === null || op.before === "" || op.after === "") {
      return { ok: false, error: "\u8BE5\u64CD\u4F5C\u6CA1\u6709\u5B8C\u6574\u5185\u5BB9\u5FEB\u7167\uFF0C\u65E0\u6CD5\u64A4\u56DE" };
    }
    const read = await this.readFileText(filePath);
    if (!read.ok) return { ok: false, error: read.error };
    const r = revertHunk(read.content.split("\n"), op.before, op.after, hunkIndex);
    if (!r.ok) return { ok: false, error: r.reason };
    const written = await this.writeFileText(filePath, r.content, this.sandboxPolicyFor(sessionId));
    if (!written.ok) return written;
    this.deps.ledger.markHunkReverted(op.id, hunkIndex);
    this.notifyChanged(sessionId);
    return { ok: true, message: `\u5DF2\u64A4\u56DE\u53D8\u66F4\u5757 ${hunkIndex + 1}` };
  }
  /** ④b 整文件撤回（恢复到该文件在本次会话的首次操作前；新建文件则删除） */
  async revertFile(sessionId, filePath) {
    const np = normPath(filePath);
    const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
    const first = ops[0];
    if (!first) return { ok: false, error: "\u8BE5\u6587\u4EF6\u6CA1\u6709\u53EF\u64A4\u56DE\u7684\u4FEE\u6539" };
    if (first.before === void 0 || first.before === "") {
      return { ok: false, error: "\u9996\u6B21\u4FEE\u6539\u6CA1\u6709\u5185\u5BB9\u5FEB\u7167\uFF0C\u65E0\u6CD5\u64A4\u56DE" };
    }
    try {
      if (first.before === null) {
        await this.deleteFile(filePath);
      } else {
        const w = await this.writeFileText(filePath, first.before, this.sandboxPolicyFor(sessionId));
        if (!w.ok) return w;
      }
      this.deps.ledger.removeOpsForFileInSession(sessionId, first.filePath);
      this.notifyChanged(sessionId);
      return {
        ok: true,
        message: first.before === null ? "\u5DF2\u5220\u9664\u672C\u6B21\u4F1A\u8BDD\u4E2D\u65B0\u5EFA\u7684\u6587\u4EF6" : "\u5DF2\u64A4\u56DE\u8BE5\u6587\u4EF6\u7684\u5168\u90E8\u4FEE\u6539"
      };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  }
  clearSession(sessionId) {
    this.deps.ledger.clearSession(sessionId);
    this.notifyChanged(sessionId);
  }
  async writeFileText(path, content, sandboxPolicy) {
    try {
      if (this.deps.fs) {
        const target = await this.deps.fs.resolve(path);
        await this.deps.fs.writeText(target, content, void 0, void 0, sandboxPolicy);
      } else if (this.deps.nodeWrite) {
        await this.deps.nodeWrite(path, content);
      } else {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, content, "utf8");
      }
      return { ok: true, message: "" };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  }
  async deleteFile(path) {
    if (this.deps.fs && this.deps.fs.unlink) {
      const target = await this.deps.fs.resolve(path);
      await this.deps.fs.unlink(target);
      return;
    }
    if (this.deps.nodeUnlink) {
      await this.deps.nodeUnlink(path);
      return;
    }
    const { unlink } = await import("node:fs/promises");
    await unlink(path);
  }
};

// src/host/routes.ts
function sendJson(res, status, body) {
  res.statusCode = status;
  if (res.setHeader) res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function queryParam(req, key) {
  return new URL(req.url, "http://localhost").searchParams.get(key) ?? "";
}
function errorMessage(e) {
  return String(e.message ?? e);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (!req.on) return resolve({});
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      if (tooBig) return;
      data += String(chunk);
      if (data.length > 1e6) {
        tooBig = true;
        reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("\u8BF7\u6C42\u4F53\u4E0D\u662F\u6709\u6548\u7684 JSON"));
      }
    });
    req.on("error", reject);
  });
}
function registerRoutes(service, webServer) {
  const clients = /* @__PURE__ */ new Set();
  service.onChanged((sessionId) => {
    const payload = `data: ${JSON.stringify({ session: sessionId })}

`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/events",
    handler: (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write("retry: 3000\n\n");
      clients.add(res);
      req.on?.("close", () => clients.delete(res));
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/tree",
    handler: async (req, res) => {
      try {
        const root = queryParam(req, "root");
        if (!root) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 root \u53C2\u6570" });
        sendJson(res, 200, await service.tree(root));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/file",
    handler: async (req, res) => {
      const path = queryParam(req, "path");
      if (!path) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 path \u53C2\u6570" });
      const r = await service.readFileText(path);
      sendJson(res, r.ok ? 200 : 400, r);
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/context",
    handler: (req, res) => {
      const sessionId = queryParam(req, "session");
      if (!sessionId) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u53C2\u6570" });
      sendJson(res, 200, service.sessionContext(sessionId));
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/ops",
    handler: (req, res) => {
      const sessionId = queryParam(req, "session");
      const file = queryParam(req, "file") || void 0;
      sendJson(res, 200, service.opsFor(sessionId, file));
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/revert",
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const sessionId = queryParam(req, "session");
        const filePath = typeof body.path === "string" ? body.path : "";
        if (!sessionId || !filePath) {
          return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u6216 path \u53C2\u6570" });
        }
        const op = body.op;
        const hunk = body.hunk;
        let result;
        if (typeof op === "number" && typeof hunk === "number") {
          result = await service.revertHunk(sessionId, filePath, op, hunk);
        } else {
          result = await service.revertFile(sessionId, filePath);
        }
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/accept",
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const sessionId = queryParam(req, "session");
        const filePath = typeof body.path === "string" ? body.path : "";
        const op = body.op;
        const hunk = body.hunk;
        if (!sessionId || !filePath || typeof op !== "number" || typeof hunk !== "number") {
          return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session/path/op/hunk \u53C2\u6570" });
        }
        const result = await service.acceptHunk(sessionId, filePath, op, hunk);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/ws-studio/clear",
    handler: (req, res) => {
      const sessionId = queryParam(req, "session");
      if (!sessionId) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u53C2\u6570" });
      service.clearSession(sessionId);
      sendJson(res, 200, { ok: true });
    }
  });
}

// src/host/agents.ts
function newTurnCursor() {
  return { turn: null, scanSeq: 0 };
}
function resolveRootId(agents, agentId) {
  const store = agents?.store;
  if (!store) return agentId;
  let current = store.get(agentId);
  if (!current) return agentId;
  const seen = /* @__PURE__ */ new Set();
  while (current.owner && current.owner.id && !seen.has(current.owner.id)) {
    seen.add(current.owner.id);
    const next = store.get(current.owner.id);
    if (!next) break;
    current = next;
  }
  return current.agent && current.agent.id ? current.agent.id : agentId;
}
function currentTurnOf(agents, rootId, cursor) {
  try {
    const entry = agents?.store?.get(rootId);
    const events = entry?.agent?.session?.events;
    if (events && Array.isArray(events) && events.length > cursor.scanSeq) {
      const from = cursor.scanSeq;
      cursor.scanSeq = events.length;
      for (let i = events.length - 1; i >= from; i--) {
        const e = events[i];
        if (e.type === "turn/start") {
          cursor.turn = e.data && typeof e.data.turn === "number" ? e.data.turn : null;
          break;
        }
        if (e.type === "turn/end") {
          cursor.turn = null;
          break;
        }
      }
    }
  } catch {
  }
  return cursor.turn;
}

// src/host/index.ts
var name = "ws-studio";
var inject = ["webServer", "agents", "fs"];
var STATE_FILE_NAME = "ws-studio-state.json";
var SAVE_DEBOUNCE_MS = 800;
function stateFilePath(ctx) {
  try {
    if (ctx.baseUrl) return fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl));
  } catch {
  }
  return join(homedir(), ".dsh", STATE_FILE_NAME);
}
function apply(ctx) {
  const ledger = new ChangeLedger();
  const stateFile = stateFilePath(ctx);
  ledger.load(stateFile);
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        ledger.save(stateFile);
      } catch {
      }
    }, SAVE_DEBOUNCE_MS);
  };
  ctx.effect(
    () => () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        ledger.save(stateFile);
      } catch {
      }
    },
    "ws-studio: persist flush"
  );
  const turnCursors = /* @__PURE__ */ new Map();
  const cursorFor = (rootId) => {
    let c = turnCursors.get(rootId);
    if (!c) {
      c = newTurnCursor();
      turnCursors.set(rootId, c);
    }
    return c;
  };
  const service = new WsStudioService({
    ledger,
    fs: ctx.fs,
    resolveRoot: (agentId) => resolveRootId(ctx.agents, agentId),
    currentTurn: (rootId) => currentTurnOf(ctx.agents, rootId, cursorFor(rootId)),
    sessionCwd: (sessionId) => {
      const entry = ctx.agents.store.get(sessionId);
      return entry?.agent?.session?.header?.cwd;
    }
  });
  ctx.on("tools/result", (exec, result) => {
    try {
      const e = exec;
      if (!e) return;
      const toolName = e.tool || e.name;
      if (toolName !== "write" && toolName !== "edit") return;
      const input = e.input || e.arguments || e.args;
      if (!input || typeof input !== "object") return;
      const file = input.file_path || input.file || input.path;
      if (typeof file !== "string" || !file) return;
      const agentId = e.agent?.id;
      if (typeof agentId !== "string" || !agentId) return;
      const r = result;
      if (r && (r.isError || r.error || r.ok === false || r.failed)) return;
      const value = r && !r.isError && r.value && typeof r.value === "object" ? r.value : null;
      const hasBefore = value !== null && "before" in value;
      const hasAfter = value !== null && "after" in value;
      if (!hasAfter) return;
      const beforeRaw = hasBefore ? value.before : void 0;
      const before = beforeRaw === null || beforeRaw === void 0 ? beforeRaw : String(beforeRaw);
      const after = String(value.after);
      const rootId = service.resolveRoot(agentId);
      ledger.add({
        sessionId: rootId,
        filePath: file,
        before,
        after,
        turn: service.currentTurn(rootId)
      });
      service.notifyChanged(rootId);
      scheduleSave();
    } catch (err) {
      console.error("ws-studio track failed", err);
    }
  });
  registerRoutes(service, ctx.webServer);
}
export {
  apply,
  inject,
  name
};
