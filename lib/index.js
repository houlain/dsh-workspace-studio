// src/host/index.ts
import { join } from "node:path";
import { homedir as homedir2 } from "node:os";

// src/core/ledger.ts
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";

// src/host/security.ts
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
var TRUST_HEADER = "x-dsh-workspace-studio";
function headerOf(req, name2) {
  const value = req.headers?.[name2];
  return Array.isArray(value) ? value[0] : value;
}
function isLoopbackLiteral(value) {
  if (!value) return false;
  const addr = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (addr === "::1") return true;
  const v4 = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
  if (octets.some((o) => !Number.isFinite(o) || o < 0 || o > 255)) return false;
  return octets[0] === 127;
}
function isLoopbackHostname(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "localhost.") return true;
  return isLoopbackLiteral(h);
}
function isTrustedRequest(req) {
  if (headerOf(req, TRUST_HEADER) !== "1") return false;
  if (!isLoopbackLiteral(req.socket?.remoteAddress)) return false;
  const site = headerOf(req, "sec-fetch-site");
  if (site !== void 0 && site !== "same-origin") return false;
  const host = headerOf(req, "host");
  if (host === void 0 || host === "") return false;
  const origin = headerOf(req, "origin");
  if (origin === void 0 || origin === "") {
    try {
      return isLoopbackHostname(new URL(`http://${host}`).hostname);
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.host === host && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}
function canonicalPath(target) {
  if (typeof target !== "string") return void 0;
  const trimmed = target.trim();
  if (trimmed === "") return void 0;
  const isWin = process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  const impl = isWin ? win32 : posix;
  if (!impl.isAbsolute(trimmed)) return void 0;
  const normalized = impl.normalize(trimmed).replace(/[\\/]+$/, "");
  return isWin ? normalized.replace(/\\/g, "/").toLowerCase() : normalized;
}
function isPathInsideWorkspace(target, roots) {
  const t = canonicalPath(target);
  if (t === void 0) return false;
  for (const root of roots) {
    const r = canonicalPath(root);
    if (r === void 0 || r === "") continue;
    if (t === r) return true;
    if (t.startsWith(`${r}/`)) return true;
  }
  return false;
}
var SENSITIVE_SEGMENT_TEST = [
  /^\.secrets$/i,
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.key$/i,
  /\.pem$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
  /^id_ecdsa.*$/i,
  /^credentials.*$/i,
  /^\.netrc$/i
];
function isSensitivePath(target) {
  const canonical = canonicalPath(target);
  if (canonical === void 0) return false;
  const home = canonicalPath(homedir());
  if (home !== void 0 && (canonical === `${home}/.dsh` || canonical.startsWith(`${home}/.dsh/`))) {
    return true;
  }
  for (const segment of canonical.split("/")) {
    if (segment === "") continue;
    if (SENSITIVE_SEGMENT_TEST.some((re) => re.test(segment))) return true;
  }
  return false;
}

// src/core/ledger.ts
var DEFAULT_LEDGER_OPTIONS = {
  maxOpsPerFile: 100,
  maxOpsTotal: 2e3,
  maxOpBytes: 120 * 1024
};
var MAX_STATE_BYTES = 64 * 1024 * 1024;
function isIndexArray(value) {
  return Array.isArray(value) && value.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0);
}
function isValidOp(value) {
  if (value === null || typeof value !== "object") return false;
  const o = value;
  if (typeof o.id !== "string" || o.id === "") return false;
  if (typeof o.sessionId !== "string") return false;
  if (typeof o.filePath !== "string" || o.filePath === "") return false;
  if (typeof o.after !== "string") return false;
  if (!(o.before === void 0 || o.before === null || typeof o.before === "string")) return false;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return false;
  if (!(o.turn === void 0 || o.turn === null || typeof o.turn === "number")) return false;
  if (!(o.created === void 0 || typeof o.created === "boolean")) return false;
  if (!(o.truncated === void 0 || typeof o.truncated === "boolean")) return false;
  if (!(o.revertedHunks === void 0 || isIndexArray(o.revertedHunks))) return false;
  if (!(o.acceptedHunks === void 0 || isIndexArray(o.acceptedHunks))) return false;
  return true;
}
function pathKey(p) {
  const canonical = canonicalPath(p);
  if (canonical !== void 0) return canonical;
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
var ChangeLedger = class {
  ops = [];
  /** 历史被裁剪过的文件（canonical key）：整文件撤回不允许对这类文件走"删除"分支 */
  prunedFiles = /* @__PURE__ */ new Set();
  options;
  /** load 因损坏/超大失败过：本进程内不再覆盖写，避免把历史抹成空表。 */
  storageBroken = false;
  constructor(options = DEFAULT_LEDGER_OPTIONS) {
    this.options = options;
  }
  add(op) {
    const beforeLen = typeof op.before === "string" ? op.before.length : 0;
    const tooBig = beforeLen > this.options.maxOpBytes || op.after.length > this.options.maxOpBytes;
    const record = tooBig ? { ...op, id: randomUUID(), ts: Date.now(), before: "", after: "", truncated: true } : { ...op, id: randomUUID(), ts: Date.now() };
    this.ops.push(record);
    this.pruneFile(op.filePath);
    this.pruneGlobal();
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
  /** 移除某文件在某会话下的全部操作记录（整文件撤回后调用）；路径按 canonical 比较。 */
  removeOpsForFileInSession(sessionId, filePath) {
    const before = this.ops.length;
    const key = pathKey(filePath);
    this.ops = this.ops.filter((o) => !(o.sessionId === sessionId && pathKey(o.filePath) === key));
    return before - this.ops.length;
  }
  /** 每个文件最多保留 maxOpsPerFile 条，超出丢最旧（按 canonical 路径分桶）。 */
  pruneFile(filePath) {
    const max = this.options.maxOpsPerFile;
    const key = pathKey(filePath);
    const idxs = [];
    for (let i = 0; i < this.ops.length; i++) if (pathKey(this.ops[i].filePath) === key) idxs.push(i);
    while (idxs.length > max) {
      const victim = idxs.shift();
      this.notePruned(this.ops[victim]?.filePath);
      this.ops.splice(victim, 1);
      for (let k = 0; k < idxs.length; k++) if (idxs[k] > victim) idxs[k]--;
    }
  }
  /** 全台账上限：超出时丢最旧的记录（不同文件/会话累积也不至于无限增长）。 */
  pruneGlobal() {
    const max = this.options.maxOpsTotal;
    if (this.ops.length <= max) return;
    const dropCount = this.ops.length - max;
    for (let i = 0; i < dropCount; i++) this.notePruned(this.ops[i]?.filePath);
    this.ops = this.ops.slice(this.ops.length - max);
  }
  /**
   * 记录"这个文件的历史被裁剪过"。
   *
   * 为什么必须记：整文件撤回若以一条 `created: true` 记录为基线，会按"文件是会话中新建"
   * 去删除它。但裁剪把更早的记录丢掉之后，一条 create 记录**不代表**文件在会话开始时
   * 不存在——它可能只是"删掉后重建"的中间态。没有这个标记就会误删会话前已存在的文件。
   */
  notePruned(filePath) {
    if (typeof filePath !== "string" || filePath === "") return;
    this.prunedFiles.add(pathKey(filePath));
  }
  /** 该文件的历史是否被容量裁剪过（撤回基线判定必须看它）。 */
  wasPruned(filePath) {
    return this.prunedFiles.has(pathKey(filePath));
  }
  all() {
    return this.ops;
  }
  opsForFile(filePath) {
    const key = pathKey(filePath);
    return this.ops.filter((o) => pathKey(o.filePath) === key);
  }
  opsForSession(sessionId) {
    return this.ops.filter((o) => o.sessionId === sessionId);
  }
  /** 本会话涉及的文件（按 canonical 口径去重，返回首次出现的原串）。 */
  filesForSession(sessionId) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const op of this.opsForSession(sessionId)) {
      const key = pathKey(op.filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(op.filePath);
    }
    return out;
  }
  clearSession(sessionId) {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => o.sessionId !== sessionId);
    return before - this.ops.length;
  }
  clear() {
    this.ops = [];
    this.prunedFiles.clear();
  }
  /** 是否发生过 load 失败（用于避免覆盖写丢历史）。 */
  isStorageBroken() {
    return this.storageBroken;
  }
  load(path) {
    let raw;
    try {
      const size = statSync(path).size;
      if (size > MAX_STATE_BYTES) {
        this.quarantine(path, "oversized");
        this.storageBroken = true;
        return;
      }
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const ops = parsed?.ops;
      const list = Array.isArray(ops) ? ops : [];
      const valid = list.filter(isValidOp);
      this.ops = valid;
      const pruned = parsed?.prunedFiles;
      this.prunedFiles = new Set(
        (Array.isArray(pruned) ? pruned : []).filter((x) => typeof x === "string" && x !== "")
      );
      const dropped = list.length - valid.length;
      if (dropped > 0) {
        console.warn(
          `ws-studio: \u53F0\u8D26\u6709 ${dropped} \u6761\u8BB0\u5F55\u5B57\u6BB5\u975E\u6CD5\uFF0C\u5DF2\u4E22\u5F03\uFF08\u4FDD\u7559 ${valid.length} \u6761\uFF09\uFF1B\u539F\u6587\u4EF6\u53E6\u5B58\u4E3A .dropped \u5907\u4EFD: ${path}`
        );
        this.backup(path, "dropped");
      } else if (ops !== void 0 && !Array.isArray(ops)) {
        console.warn(`ws-studio: \u53F0\u8D26 ops \u5B57\u6BB5\u4E0D\u662F\u6570\u7EC4\uFF0C\u6309\u7A7A\u53F0\u8D26\u5904\u7406\uFF1B\u539F\u6587\u4EF6\u53E6\u5B58\u4E3A .dropped \u5907\u4EFD: ${path}`);
        this.backup(path, "dropped");
      }
    } catch {
      this.quarantine(path, "corrupt");
      this.storageBroken = true;
      console.error(`ws-studio: state \u6587\u4EF6\u89E3\u6790\u5931\u8D25\uFF0C\u5DF2\u9694\u79BB\u4E3A .corrupt \u5907\u4EFD\uFF08\u672C\u6B21\u4E0D\u8986\u76D6\u5199\uFF09: ${path}`);
    }
  }
  /** 把损坏/超大的 state 文件改名隔离，保留人工排查的可能。 */
  quarantine(path, reason) {
    try {
      renameSync(path, `${path}.${reason}-${Date.now()}`);
    } catch {
    }
  }
  /** 另存一份原文件（丢弃非法记录时用：不移动原文件，只是留证）。 */
  backup(path, reason) {
    try {
      copyFileSync(path, `${path}.${reason}-${Date.now()}`);
    } catch {
    }
  }
  save(path) {
    if (this.storageBroken && this.ops.length === 0) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const state = { ops: this.ops, prunedFiles: [...this.prunedFiles] };
    const json = JSON.stringify(state);
    const fd = openSync(tmp, "w", 384);
    try {
      writeSync(fd, json, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
var DEFAULT_REVERT_OPTIONS = { window: 2, context: 3 };
var AMBIGUOUS_REASON = "\u65E0\u6CD5\u552F\u4E00\u786E\u5B9A\u8BE5\u53D8\u66F4\u5757\u7684\u4F4D\u7F6E\uFF08\u6587\u4EF6\u5DF2\u88AB\u5176\u5B83\u4FEE\u6539\u5F71\u54CD\uFF09\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5";
var NOT_FOUND_REASON = `\u8BE5\u53D8\u66F4\u5757\u7684\u4EE3\u7801\u5DF2\u88AB\u540E\u7EED\u4FEE\u6539\u8986\u76D6\uFF0C${AMBIGUOUS_REASON}`;
function revertHunk(currentLines, before, after, hunkIndex, options = DEFAULT_REVERT_OPTIONS) {
  const hunks = diffHunks(before.split("\n"), after.split("\n"), options.context);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    return { ok: false, reason: `\u53D8\u66F4\u5757 ${hunkIndex} \u4E0D\u5B58\u5728\uFF08\u8BE5\u64CD\u4F5C\u5171\u6709 ${hunks.length} \u4E2A\u53D8\u66F4\u5757\uFF09` };
  }
  const located = locate(currentLines, hunk, options);
  if (!located.ok) return located;
  return {
    ok: true,
    content: applyAt(currentLines, hunk, located.anchor).join("\n"),
    revertedHunk: hunkIndex
  };
}
function locate(current, hunk, options) {
  const insertion = hunk.added.length > 0;
  const target = insertion ? hunk.added : [...hunk.ctxBefore, ...hunk.ctxAfter];
  if (target.length === 0) {
    return { ok: false, reason: `\u8BE5\u53D8\u66F4\u5757\u6CA1\u6709\u53EF\u7528\u4E8E\u5B9A\u4F4D\u7684\u5185\u5BB9\uFF0C${AMBIGUOUS_REASON}` };
  }
  const expected = Math.max(0, hunk.newStart - 1 + (insertion ? hunk.ctxBefore.length : 0));
  const near = collectMatches(current, target, hunk, insertion, expected, options.window);
  if (near.length === 1) return { ok: true, anchor: near[0] };
  const all = collectMatches(current, target, hunk, insertion, expected, Number.MAX_SAFE_INTEGER);
  if (all.length === 1) return { ok: true, anchor: all[0] };
  if (all.length === 0) return { ok: false, reason: NOT_FOUND_REASON };
  return { ok: false, reason: AMBIGUOUS_REASON };
}
function collectMatches(lines, target, hunk, insertion, expected, window) {
  const maxAnchor = lines.length - target.length;
  if (maxAnchor < 0) return [];
  const start = Math.max(0, expected - window);
  const end = Math.min(maxAnchor, expected + window);
  const hits = [];
  for (let i = start; i <= end; i++) {
    if (matchesAt(lines, i, target, hunk, insertion)) hits.push(i);
  }
  return hits;
}
function matchesAt(lines, anchor, target, hunk, insertion) {
  if (anchor < 0) return false;
  if (anchor + target.length > lines.length) return false;
  if (insertion) {
    if (anchor - hunk.ctxBefore.length < 0) return false;
    if (anchor + target.length + hunk.ctxAfter.length > lines.length) return false;
  }
  for (let k = 0; k < target.length; k++) {
    if (lines[anchor + k] !== target[k]) return false;
  }
  if (!insertion) return true;
  for (let k = 0; k < hunk.ctxBefore.length; k++) {
    if (lines[anchor - hunk.ctxBefore.length + k] !== hunk.ctxBefore[k]) return false;
  }
  for (let k = 0; k < hunk.ctxAfter.length; k++) {
    if (lines[anchor + target.length + k] !== hunk.ctxAfter[k]) return false;
  }
  return true;
}
function applyAt(lines, hunk, anchor) {
  if (hunk.added.length > 0) {
    return [...lines.slice(0, anchor), ...hunk.removed, ...lines.slice(anchor + hunk.added.length)];
  }
  const insAt = anchor + hunk.ctxBefore.length;
  return [...lines.slice(0, insAt), ...hunk.removed, ...lines.slice(insAt)];
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
var EXPIRED_OP = "\u8BE5\u64CD\u4F5C\u5DF2\u8FC7\u671F\u6216\u88AB\u6E05\u7406\uFF0C\u8BF7\u5237\u65B0";
var DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
var normPath = (p) => p.replace(/\\/g, "/");
var pathKey2 = (p) => canonicalPath(p) ?? normPath(p).replace(/\/+$/, "");
function hasSnapshot(op) {
  if (op.truncated === true) return false;
  if (op.before === null || op.before === void 0) return false;
  if (op.before === "") return false;
  return op.after !== "";
}
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
  /** 会话上下文（浏览器侧默认文件树根目录）；取不到时给 null（契约 §2：不要空对象）。 */
  sessionContext(sessionId) {
    const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : void 0;
    return { cwd: cwd !== void 0 && cwd !== "" ? cwd : null };
  }
  /** 会话级沙箱策略：撤回写入按会话工作区根放行（workspace-write）。
   *  返回 undefined 表示拿不到会话工作区——调用方必须**拒绝写入**（fail closed），
   *  不能让它落回部署默认策略（那可能是 danger-full-access）。 */
  sandboxPolicyFor(sessionId) {
    const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : void 0;
    return cwd ? { mode: "workspace-write", workspaceRoot: cwd } : void 0;
  }
  /** 写路径的统一前置校验：授权 + 沙箱策略都要有，缺一即拒。 */
  writeGuard(sessionId, filePath) {
    const check = this.deps.isWriteAllowed;
    if (!check) return { ok: false, error: "\u63D2\u4EF6\u672A\u914D\u7F6E\u5199\u6388\u6743\uFF0C\u62D2\u7EDD\u6539\u5199\u6587\u4EF6" };
    let allowed = false;
    try {
      allowed = check(filePath, sessionId);
    } catch {
      allowed = false;
    }
    if (!allowed) return { ok: false, error: "\u8BE5\u8DEF\u5F84\u4E0D\u5728\u5DF2\u6CE8\u518C\u7684\u5DE5\u4F5C\u533A\u5185\uFF0C\u62D2\u7EDD\u6539\u5199" };
    const policy = this.sandboxPolicyFor(sessionId);
    if (!policy) return { ok: false, error: "\u53D6\u4E0D\u5230\u4F1A\u8BDD\u5DE5\u4F5C\u533A\uFF0C\u65E0\u6CD5\u5728\u53D7\u9650\u6C99\u7BB1\u5185\u5199\u5165\uFF0C\u5DF2\u62D2\u7EDD" };
    return { ok: true, policy };
  }
  /** 用户动作成功后落盘（契约 §7）；失败不影响已成功的内存状态。 */
  persist() {
    try {
      this.deps.persist?.();
    } catch {
    }
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
  /** 某会话中某文件的全部操作（路径按 canonical 比较，返回台账原序）。 */
  opsOf(sessionId, filePath) {
    const key = pathKey2(filePath);
    return this.deps.ledger.opsForSession(sessionId).filter((o) => pathKey2(o.filePath) === key);
  }
  /** 按 opId 定位（契约 §3）：只在该会话、该文件下找，找不到交给调用方报"已过期"。 */
  opById(sessionId, filePath, opId) {
    if (typeof opId !== "string" || opId === "") return void 0;
    return this.opsOf(sessionId, filePath).find((o) => o.id === opId);
  }
  /** 该操作的 hunk 列表；没有可用快照时为空数组（前端据此显示"不可撤回"）。 */
  hunksOf(op) {
    if (!hasSnapshot(op)) return [];
    return diffHunks(op.before.split("\n"), op.after.split("\n"));
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
    const sessionOps = this.deps.ledger.opsForSession(sessionId);
    const wanted = filePath !== void 0 && filePath !== "" ? filePath : void 0;
    const buckets = /* @__PURE__ */ new Map();
    if (wanted !== void 0) {
      const key = pathKey2(wanted);
      const ops = sessionOps.filter((o) => pathKey2(o.filePath) === key);
      buckets.set(key, { path: normPath(wanted), ops });
    } else {
      for (const op of sessionOps) {
        const key = pathKey2(op.filePath);
        const bucket = buckets.get(key);
        if (bucket) bucket.ops.push(op);
        else buckets.set(key, { path: normPath(op.filePath), ops: [op] });
      }
    }
    const files = [];
    for (const bucket of buckets.values()) {
      const ops = bucket.ops;
      if (ops.length === 0) continue;
      const views = ops.map((op, index) => this.viewOf(op, index));
      const pending = views.some((v) => v.pending);
      if (wanted === void 0 && !pending) continue;
      files.push({
        path: bucket.path,
        latestAt: Math.max(...ops.map((o) => o.ts), 0),
        ops: views,
        pending
      });
    }
    files.sort((x, y) => y.latestAt - x.latestAt);
    return { files };
  }
  viewOf(op, index) {
    const truncated = op.truncated === true;
    const revertible = hasSnapshot(op);
    const hunks = revertible ? this.hunksOf(op) : [];
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
      // id 是撤回/认可的唯一身份（契约 §3）；index 仅保留兼容
      id: op.id,
      index,
      at: op.ts,
      turn: op.turn,
      hunks,
      revertedHunks,
      acceptedHunks,
      revertible,
      truncated,
      pending,
      added,
      removed
    };
  }
  /** ④c 认可一个变更块（确认保留，不再标记、不再显示差异） */
  async acceptHunk(sessionId, filePath, opId, hunkIndex) {
    const op = this.opById(sessionId, filePath, opId);
    if (!op) return { ok: false, error: EXPIRED_OP };
    const hunks = this.hunksOf(op);
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) {
      return { ok: false, error: `\u53D8\u66F4\u5757\u7D22\u5F15\u65E0\u6548\uFF08\u8BE5\u64CD\u4F5C\u5171\u6709 ${hunks.length} \u4E2A\u53D8\u66F4\u5757\uFF09` };
    }
    const reverted = op.revertedHunks ?? [];
    const accepted = op.acceptedHunks ?? [];
    if (reverted.includes(hunkIndex)) return { ok: false, error: "\u8BE5\u53D8\u66F4\u5757\u5DF2\u64A4\u56DE\uFF0C\u65E0\u9700\u8BA4\u53EF" };
    if (accepted.includes(hunkIndex)) return { ok: false, error: "\u8BE5\u53D8\u66F4\u5757\u5DF2\u8BA4\u53EF" };
    this.deps.ledger.markHunkAccepted(op.id, hunkIndex);
    this.persist();
    this.notifyChanged(sessionId);
    return { ok: true, message: `\u5DF2\u8BA4\u53EF\u53D8\u66F4\u5757 ${hunkIndex + 1}` };
  }
  /** ④d 一键同意：认可该文件当前所有待处理的变更块（与「撤回全部修改」对称）。 */
  async acceptAllHunks(sessionId, filePath) {
    const ops = this.opsOf(sessionId, filePath);
    if (ops.length === 0) return { ok: false, error: "\u8BE5\u6587\u4EF6\u6CA1\u6709\u53EF\u8BA4\u53EF\u7684\u4FEE\u6539" };
    let marked = 0;
    let pending = 0;
    for (const op of ops) {
      const hunks = this.hunksOf(op);
      for (let i = 0; i < hunks.length; i += 1) {
        if ((op.revertedHunks ?? []).includes(i)) continue;
        if ((op.acceptedHunks ?? []).includes(i)) continue;
        pending += 1;
        if (this.deps.ledger.markHunkAccepted(op.id, i)) marked += 1;
      }
    }
    if (pending === 0) return { ok: false, error: "\u8BE5\u6587\u4EF6\u6CA1\u6709\u5F85\u5904\u7406\u7684\u53D8\u66F4\u5757" };
    this.persist();
    this.notifyChanged(sessionId);
    return { ok: true, message: `\u5DF2\u8BA4\u53EF ${marked} \u4E2A\u53D8\u66F4\u5757` };
  }
  /** ④a hunk 级部分撤回 */
  async revertHunk(sessionId, filePath, opId, hunkIndex) {
    const op = this.opById(sessionId, filePath, opId);
    if (!op) return { ok: false, error: EXPIRED_OP };
    if (op.truncated === true) return { ok: false, error: "\u8BE5\u64CD\u4F5C\u7684\u5FEB\u7167\u8FC7\u5927\uFF0C\u4E0D\u53EF\u64A4\u56DE" };
    if (!hasSnapshot(op)) return { ok: false, error: "\u8BE5\u64CD\u4F5C\u6CA1\u6709\u5B8C\u6574\u5185\u5BB9\u5FEB\u7167\uFF0C\u65E0\u6CD5\u64A4\u56DE" };
    const hunks = this.hunksOf(op);
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) {
      return { ok: false, error: `\u53D8\u66F4\u5757\u7D22\u5F15\u65E0\u6548\uFF08\u8BE5\u64CD\u4F5C\u5171\u6709 ${hunks.length} \u4E2A\u53D8\u66F4\u5757\uFF09` };
    }
    const reverted = op.revertedHunks ?? [];
    const accepted = op.acceptedHunks ?? [];
    if (reverted.includes(hunkIndex)) return { ok: false, error: "\u8BE5\u53D8\u66F4\u5757\u5DF2\u64A4\u56DE" };
    if (accepted.includes(hunkIndex)) return { ok: false, error: "\u8BE5\u53D8\u66F4\u5757\u5DF2\u8BA4\u53EF\uFF0C\u65E0\u6CD5\u64A4\u56DE" };
    const expected = await this.versionOf(filePath);
    const read = await this.readFileText(filePath);
    if (!read.ok) return { ok: false, error: read.error };
    const r = revertHunk(read.content.split("\n"), op.before, op.after, hunkIndex);
    if (!r.ok) return { ok: false, error: r.reason };
    const written = await this.writeGuarded(sessionId, filePath, r.content, expected);
    if (!written.ok) return written;
    this.deps.ledger.markHunkReverted(op.id, hunkIndex);
    this.persist();
    this.notifyChanged(sessionId);
    return { ok: true, message: `\u5DF2\u64A4\u56DE\u53D8\u66F4\u5757 ${hunkIndex + 1}` };
  }
  /**
   * ④b 整文件撤回（恢复到该文件在本次会话的最早可用基线前；新建文件则删除）。
   * 基线策略见契约 §4：不再假设 ops[0]，而是取最早一条**仍带内容快照**的记录。
   */
  async revertFile(sessionId, filePath) {
    const ops = this.opsOf(sessionId, filePath).slice().sort((a, b) => a.ts - b.ts);
    if (ops.length === 0) return { ok: false, error: "\u8BE5\u6587\u4EF6\u6CA1\u6709\u53EF\u64A4\u56DE\u7684\u4FEE\u6539" };
    let baseline;
    let unsafe = false;
    for (const op of ops) {
      if (op.before === void 0) {
        unsafe = true;
        break;
      }
      if (op.before === null) {
        if (op.created === true) {
          baseline = op;
          break;
        }
        unsafe = true;
        break;
      }
      if (op.before === "") continue;
      baseline = op;
      break;
    }
    if (unsafe) {
      return {
        ok: false,
        error: "\u8BE5\u6587\u4EF6\u7684\u9996\u6761\u4FEE\u6539\u6CA1\u6709\u57FA\u7EBF\u5FEB\u7167\uFF08\u5E76\u975E\u5728\u5F53\u524D\u4F1A\u8BDD\u4E2D\u65B0\u5EFA\uFF09\uFF0C\u65E0\u6CD5\u5B89\u5168\u64A4\u56DE\uFF1B\u8BF7\u624B\u52A8\u5904\u7406"
      };
    }
    if (!baseline) return { ok: false, error: "\u539F\u59CB\u5185\u5BB9\u5FEB\u7167\u5DF2\u88AB\u6E05\u7406\uFF08\u6CA1\u6709\u53EF\u7528\u57FA\u7EBF\uFF09\uFF0C\u65E0\u6CD5\u5B89\u5168\u64A4\u56DE" };
    try {
      if (baseline.before === null) {
        if (typeof this.deps.ledger.wasPruned === "function" && this.deps.ledger.wasPruned(filePath)) {
          return {
            ok: false,
            error: "\u8BE5\u6587\u4EF6\u7684\u5386\u53F2\u8BB0\u5F55\u5DF2\u88AB\u5BB9\u91CF\u88C1\u526A\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5B83\u662F\u5426\u5728\u4F1A\u8BDD\u5F00\u59CB\u65F6\u5DF2\u5B58\u5728\uFF1B\u5DF2\u62D2\u7EDD\u5220\u9664\uFF0C\u8BF7\u624B\u52A8\u5904\u7406"
          };
        }
        const guard = this.writeGuard(sessionId, filePath);
        if (!guard.ok) return { ok: false, error: guard.error };
        const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : void 0;
        if (!cwd || !isPathInsideWorkspace(filePath, [cwd])) {
          return { ok: false, error: "\u8BE5\u6587\u4EF6\u4E0D\u5728\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u5185\uFF0C\u62D2\u7EDD\u5220\u9664" };
        }
        await this.deleteFile(filePath, guard.policy);
      } else {
        const expected = await this.versionOf(filePath);
        const w = await this.writeGuarded(sessionId, filePath, baseline.before, expected);
        if (!w.ok) return w;
      }
      this.deps.ledger.removeOpsForFileInSession(sessionId, filePath);
      this.persist();
      this.notifyChanged(sessionId);
      return {
        ok: true,
        message: baseline.before === null ? "\u5DF2\u5220\u9664\u672C\u6B21\u4F1A\u8BDD\u4E2D\u65B0\u5EFA\u7684\u6587\u4EF6" : "\u5DF2\u64A4\u56DE\u8BE5\u6587\u4EF6\u7684\u5168\u90E8\u4FEE\u6539"
      };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  }
  clearSession(sessionId) {
    this.deps.ledger.clearSession(sessionId);
    this.persist();
    this.notifyChanged(sessionId);
  }
  /**
   * 统一写入口：授权 + 沙箱策略 + 乐观并发。
   * `version` 是读文件那一刻的版本令牌；有版本时包成 `{kind:'replaceIfVersion', version}` 交给宿主
   * （契约 §5：不是裸 version），无版本时传 undefined 表示无条件写。
   */
  async writeGuarded(sessionId, path, content, version) {
    const guard = this.writeGuard(sessionId, path);
    if (!guard.ok) return { ok: false, error: guard.error };
    const expected = version === void 0 || version === null ? void 0 : { kind: "replaceIfVersion", version };
    try {
      if (this.deps.fs) {
        const target = await this.deps.fs.resolve(path);
        await this.deps.fs.writeText(target, content, expected, void 0, guard.policy);
      } else if (this.deps.nodeWrite) {
        await this.deps.nodeWrite(path, content);
      } else {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, content, "utf8");
      }
      return { ok: true, message: "" };
    } catch (e) {
      return { ok: false, error: `\u5199\u5165\u88AB\u62D2\u7EDD\u6216\u6587\u4EF6\u5DF2\u88AB\u5E76\u53D1\u4FEE\u6539\uFF1A${String(e.message ?? e)}` };
    }
  }
  /** 读文件同时取回版本令牌，供写入时的乐观并发校验使用。 */
  async versionOf(path) {
    if (!this.deps.fs) return void 0;
    try {
      const target = await this.deps.fs.resolve(path);
      const info = await this.deps.fs.stat(target);
      return info?.version;
    } catch {
      return void 0;
    }
  }
  /**
   * 删除文件（契约 §5）。前置条件是**已经**确认过路径在沙箱根内；这里再校验一次兜底：
   * - 后端有 `remove(target, policy)` → 用它（受沙箱约束）；
   * - 否则用 `processPath` 拿本机路径再 `unlink`（受沙箱约束，绝不裸删）；
   * - 两者都没有则拒绝。
   */
  async deleteFile(path, sandboxPolicy) {
    if (!isPathInsideWorkspace(path, [sandboxPolicy.workspaceRoot])) {
      throw new Error("\u76EE\u6807\u4E0D\u5728\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u5185\uFF0C\u62D2\u7EDD\u5220\u9664");
    }
    const fs = this.deps.fs;
    if (fs) {
      const target = await fs.resolve(path);
      if (typeof fs.remove === "function") {
        await fs.remove(target, sandboxPolicy);
        return;
      }
      const osPath = typeof fs.processPath === "function" ? fs.processPath(target) : void 0;
      if (typeof osPath === "string" && osPath !== "") {
        const { unlink } = await import("node:fs/promises");
        await unlink(osPath);
        return;
      }
    }
    if (this.deps.nodeUnlink) {
      await this.deps.nodeUnlink(path);
      return;
    }
    throw new Error("\u5F53\u524D\u6587\u4EF6\u7CFB\u7EDF\u540E\u7AEF\u6CA1\u6709\u5220\u9664\u80FD\u529B\uFF0C\u8BF7\u624B\u52A8\u5220\u9664\u8BE5\u6587\u4EF6");
  }
};

// src/host/routes.ts
var ROUTE_PREFIX = "/api/dsh-workspace-studio";
var MAX_BODY_BYTES = 256 * 1024;
var MAX_SSE_CLIENTS = 32;
var SSE_KEEPALIVE_MS = 25e3;
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
function destroyRequest(req) {
  try {
    req.destroy?.();
  } catch {
  }
}
function collectJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (!req.on) return resolve({});
    const declared = Number(req.headers?.["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      destroyRequest(req);
      reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      bytes += buf.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        destroyRequest(req);
        reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (aborted) return;
      const data = Buffer.concat(chunks).toString("utf8");
      if (!data) return resolve({});
      try {
        const parsed = JSON.parse(data);
        resolve(parsed !== null && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("\u8BF7\u6C42\u4F53\u4E0D\u662F\u6709\u6548\u7684 JSON"));
      }
    });
    req.on("error", reject);
  });
}
function mount(webServer, disposers, route) {
  try {
    const d = webServer.register(route);
    if (typeof d === "function") disposers.push(d);
  } catch (err) {
    console.error(`ws-studio: \u8DEF\u7531 ${route.path} \u6CE8\u518C\u5931\u8D25`, err);
  }
}
function registerRoutes(service, webServer, options) {
  const clients = /* @__PURE__ */ new Set();
  const disposers = [];
  const rootsFor = (sessionId) => {
    const roots = /* @__PURE__ */ new Set();
    try {
      for (const p of options.workspaceRoots()) if (typeof p === "string" && p !== "") roots.add(p);
    } catch {
    }
    if (sessionId) {
      try {
        const cwd = options.sessionCwd?.(sessionId);
        if (cwd) roots.add(cwd);
      } catch {
      }
    }
    return [...roots];
  };
  const pathAllowed = (path, sessionId) => {
    if (isSensitivePath(path)) return { ok: false, error: "\u8BE5\u8DEF\u5F84\u88AB\u63D2\u4EF6\u7B56\u7565\u62D2\u7EDD\uFF08\u654F\u611F\u6587\u4EF6\uFF09" };
    if (!isPathInsideWorkspace(path, rootsFor(sessionId))) {
      return { ok: false, error: "\u8BE5\u8DEF\u5F84\u4E0D\u5728\u5DF2\u6CE8\u518C\u7684\u5DE5\u4F5C\u533A\u5185" };
    }
    return { ok: true };
  };
  const denied = (res, r) => {
    sendJson(res, 403, { ok: false, error: r.error });
  };
  const offChanged = service.onChanged(() => {
    const payload = 'data: {"changed":true}\n\n';
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  });
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/events`,
    handler: (req, res) => {
      if (clients.size >= MAX_SSE_CLIENTS) {
        return sendJson(res, 503, { ok: false, error: "SSE \u8FDE\u63A5\u6570\u5DF2\u8FBE\u4E0A\u9650" });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write("retry: 3000\n\n");
      clients.add(res);
      const drop = () => {
        clients.delete(res);
      };
      req.on?.("close", drop);
      const resOn = res.on;
      if (typeof resOn === "function") {
        resOn.call(res, "close", drop);
        resOn.call(res, "error", drop);
      }
    }
  });
  const keepalive = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(": ping\n\n");
      } catch {
        clients.delete(res);
      }
    }
  }, SSE_KEEPALIVE_MS);
  keepalive.unref?.();
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/tree`,
    handler: async (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        const root = queryParam(req, "root");
        const session = queryParam(req, "session") || void 0;
        if (!root) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 root \u53C2\u6570" });
        const allow = pathAllowed(root, session);
        if (allow.ok !== true) return denied(res, allow);
        sendJson(res, 200, await service.tree(root));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/file`,
    handler: async (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        const path = queryParam(req, "path");
        const session = queryParam(req, "session") || void 0;
        if (!path) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 path \u53C2\u6570" });
        const allow = pathAllowed(path, session);
        if (allow.ok !== true) return denied(res, allow);
        const r = await service.readFileText(path);
        sendJson(res, r.ok ? 200 : 400, r);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/context`,
    handler: (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        const sessionId = queryParam(req, "session");
        if (!sessionId) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u53C2\u6570" });
        sendJson(res, 200, service.sessionContext(sessionId));
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `\u4F1A\u8BDD\u4E0A\u4E0B\u6587\u8BFB\u53D6\u5931\u8D25\uFF1A${errorMessage(e)}` });
      }
    }
  });
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/ops`,
    handler: (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        const sessionId = queryParam(req, "session");
        if (!sessionId) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u53C2\u6570" });
        const file = queryParam(req, "file") || void 0;
        if (file) {
          const allow = pathAllowed(file, sessionId);
          if (allow.ok !== true) return denied(res, allow);
          return sendJson(res, 200, service.opsFor(sessionId, file));
        }
        const payload = service.opsFor(sessionId);
        const files = payload.files.filter((f) => pathAllowed(f.path, sessionId).ok === true);
        sendJson(res, 200, { files });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `\u6539\u52A8\u8BB0\u5F55\u8BFB\u53D6\u5931\u8D25\uFF1A${errorMessage(e)}` });
      }
    }
  });
  const resolveOpId = (body, sessionId, filePath) => {
    if (typeof body.opId === "string" && body.opId !== "") return body.opId;
    if (typeof body.op === "number") {
      const view = service.opsFor(sessionId, filePath);
      const op = view.files[0]?.ops[body.op];
      if (op && typeof op.id === "string") return op.id;
    }
    return void 0;
  };
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/revert`,
    handler: async (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        if (req.method !== void 0 && req.method !== "POST") {
          return sendJson(res, 405, { ok: false, error: "\u4EC5\u652F\u6301 POST" });
        }
        const body = await collectJsonBody(req);
        const sessionId = queryParam(req, "session");
        const filePath = typeof body.path === "string" ? body.path : "";
        if (!sessionId || !filePath) {
          return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u6216 path \u53C2\u6570" });
        }
        const allow = pathAllowed(filePath, sessionId);
        if (allow.ok !== true) return denied(res, allow);
        if (typeof body.hunk === "number") {
          const opId = resolveOpId(body, sessionId, filePath);
          if (!opId) {
            return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 opId\uFF08\u6216 opId \u5DF2\u8FC7\u671F\uFF09\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5" });
          }
          const result2 = await service.revertHunk(sessionId, filePath, opId, body.hunk);
          return sendJson(res, result2.ok ? 200 : 400, result2);
        }
        const result = await service.revertFile(sessionId, filePath);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/accept`,
    handler: async (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        if (req.method !== void 0 && req.method !== "POST") {
          return sendJson(res, 405, { ok: false, error: "\u4EC5\u652F\u6301 POST" });
        }
        const body = await collectJsonBody(req);
        const sessionId = queryParam(req, "session");
        const filePath = typeof body.path === "string" ? body.path : "";
        if (!sessionId || !filePath || typeof body.hunk !== "number") {
          return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session/path/hunk \u53C2\u6570" });
        }
        const allow = pathAllowed(filePath, sessionId);
        if (allow.ok !== true) return denied(res, allow);
        const opId = resolveOpId(body, sessionId, filePath);
        if (!opId) {
          return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 opId\uFF08\u6216 opId \u5DF2\u8FC7\u671F\uFF09\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5" });
        }
        const result = await service.acceptHunk(sessionId, filePath, opId, body.hunk);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/accept-all`,
    handler: async (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        if (req.method !== void 0 && req.method !== "POST") {
          return sendJson(res, 405, { ok: false, error: "\u4EC5\u652F\u6301 POST" });
        }
        const body = await collectJsonBody(req);
        const sessionId = queryParam(req, "session");
        const filePath = typeof body.path === "string" ? body.path : "";
        if (!sessionId || !filePath) {
          return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u6216 path \u53C2\u6570" });
        }
        const allow = pathAllowed(filePath, sessionId);
        if (allow.ok !== true) return denied(res, allow);
        const result = await service.acceptAllHunks(sessionId, filePath);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    }
  });
  mount(webServer, disposers, {
    kind: "exact",
    path: `${ROUTE_PREFIX}/clear`,
    handler: (req, res) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: "\u8BF7\u6C42\u672A\u88AB\u4FE1\u4EFB" });
        if (req.method !== void 0 && req.method !== "POST") {
          return sendJson(res, 405, { ok: false, error: "\u4EC5\u652F\u6301 POST" });
        }
        const sessionId = queryParam(req, "session");
        if (!sessionId) return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11 session \u53C2\u6570" });
        service.clearSession(sessionId);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `\u6E05\u7A7A\u5931\u8D25\uFF1A${errorMessage(e)}` });
      }
    }
  });
  return () => {
    clearInterval(keepalive);
    for (const res of clients) {
      try {
        res.end?.();
      } catch {
      }
      try {
        res.destroy?.();
      } catch {
      }
    }
    clients.clear();
    for (const d of disposers) {
      try {
        d();
      } catch {
      }
    }
    try {
      offChanged();
    } catch {
    }
  };
}

// src/host/agents.ts
function newTurnCursor() {
  return { turn: null, scanSeq: 0 };
}
function agentOf(agents, id) {
  if (!agents) return void 0;
  try {
    const direct = agents.get?.(id);
    if (direct) return direct;
  } catch {
  }
  try {
    return agents.store?.get(id)?.agent;
  } catch {
    return void 0;
  }
}
function parentOf(agents, id) {
  const agent = agentOf(agents, id);
  const header = agent?.session?.header;
  if (header && typeof header.parentSession === "string" && header.parentSession !== "") {
    return header.parentSession;
  }
  try {
    const fromStore = agents?.store?.get(id)?.owner?.id;
    if (typeof fromStore === "string" && fromStore !== "") return fromStore;
  } catch {
  }
  try {
    const fromAgent = agent?.owner?.id;
    if (typeof fromAgent === "string" && fromAgent !== "") return fromAgent;
  } catch {
  }
  return void 0;
}
function resolveRootId(agents, agentId) {
  let current = agentId;
  const seen = /* @__PURE__ */ new Set([current]);
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = parentOf(agents, current);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = parent;
  }
  return current;
}
function eventsOf(agent) {
  if (!agent) return void 0;
  const session = agent.session;
  if (!session) return void 0;
  try {
    if (typeof session.snapshotEvents === "function") {
      const list = session.snapshotEvents();
      if (Array.isArray(list)) {
        return list;
      }
    }
  } catch {
  }
  const legacy = session.events;
  if (Array.isArray(legacy)) return legacy;
  return void 0;
}
function currentTurnOf(agents, rootId, cursor) {
  try {
    const events = eventsOf(agentOf(agents, rootId));
    if (events && events.length > cursor.scanSeq) {
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
    } else if (events && events.length < cursor.scanSeq) {
      cursor.scanSeq = 0;
    }
  } catch {
  }
  return cursor.turn;
}

// src/host/index.ts
var name = "ws-studio";
var inject = ["webServer", "agents", "fs", "workspaceRegistry"];
var STATE_FILE_NAME = "ws-studio-state.json";
var SAVE_DEBOUNCE_MS = 800;
var MAX_TURN_CURSORS = 200;
function stateFilePath() {
  return join(homedir2(), ".dsh", STATE_FILE_NAME);
}
function registeredRoots(ctx) {
  try {
    const list = ctx.workspaceRegistry?.list?.();
    if (!Array.isArray(list)) return [];
    const roots = [];
    for (const w of list) {
      const p = typeof w?.path === "string" ? w.path : void 0;
      if (p !== void 0 && p !== "") roots.push(p);
    }
    return roots;
  } catch {
    return [];
  }
}
function apply(ctx) {
  const ledger = new ChangeLedger();
  const stateFile = stateFilePath();
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
      if (turnCursors.size > MAX_TURN_CURSORS) {
        const oldest = turnCursors.keys().next().value;
        if (oldest !== void 0) turnCursors.delete(oldest);
      }
    }
    return c;
  };
  const sessionCwdOf = (sessionId) => agentOf(ctx.agents, sessionId)?.session?.header?.cwd;
  const isWriteAllowed = (path, sessionId) => {
    const roots = registeredRoots(ctx);
    const cwd = sessionCwdOf(sessionId);
    if (cwd) roots.push(cwd);
    return roots.length > 0 && isPathInsideWorkspace(path, roots);
  };
  const service = new WsStudioService({
    ledger,
    fs: ctx.fs,
    resolveRoot: (agentId) => resolveRootId(ctx.agents, agentId),
    currentTurn: (rootId) => currentTurnOf(ctx.agents, rootId, cursorFor(rootId)),
    // 0.2.1：ctx.agents.get(id).session.header.cwd；旧宿主回退 store 条目里的 agent
    sessionCwd: sessionCwdOf,
    // 写操作（撤回/认可落盘、删除文件）必须落在工作区内，否则 service 直接拒绝
    isWriteAllowed,
    // 用户动作（撤回/认可/清空）成功后立即排一次落盘，避免只靠 tools/result 触发（契约 §7）
    persist: scheduleSave
  });
  ctx.effect(
    () => {
      const off = ctx.on("tools/result", (exec, result) => {
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
          const operation = value.operation;
          const created = operation === "create" || operation === void 0 && before === null;
          const rootId = service.resolveRoot(agentId);
          ledger.add({
            sessionId: rootId,
            filePath: file,
            before,
            after,
            created,
            turn: service.currentTurn(rootId)
          });
          service.notifyChanged(rootId);
          scheduleSave();
        } catch (err) {
          console.error("ws-studio track failed", err);
        }
      });
      return typeof off === "function" ? off : () => {
      };
    },
    "ws-studio: tools listener"
  );
  ctx.effect(
    () => registerRoutes(service, ctx.webServer, {
      workspaceRoots: () => registeredRoots(ctx),
      sessionCwd: sessionCwdOf
    }),
    "ws-studio: http routes"
  );
}
export {
  apply,
  inject,
  name
};
