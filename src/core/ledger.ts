// 变更台账：记录会话内每次 write/edit 的前后内容快照。
// 纯 TypeScript + node:fs，持久化为 JSON（原子写：tmp + fsync + rename）。
//
// 容量与损坏保护（红队评审后补）：
// - 超大操作也会走 prune，避免"占位记录"绕过上限；
// - 除每文件上限外还有全局上限，长会话不会无限膨胀；
// - load 失败/损坏/超大不再静默清空：文件被隔离成 *.corrupt-<ts> / *.oversized-<ts>，
//   且本进程内不再覆盖写；
// - 非法记录（字段类型错）被丢弃时打日志并把原文件另存 *.dropped-<ts>（契约 §7）；
// - state 文件以 0600 落盘，tmp 名带随机后缀，避免同 pid 多实例互相踩。
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { canonicalPath } from '../host/security.ts';

export interface LedgerOp {
  id: string;
  sessionId: string;
  /** 绝对路径 */
  filePath: string;
  /** 操作前内容；null = 文件不存在（本次会话新建）；undefined = 未记录（不可撤回） */
  before: string | null | undefined;
  after: string;
  /** 归属的根会话轮次（host 集成时从会话日志解析；core 只存储） */
  turn: number | null;
  /**
   * 该操作是否**创建了文件**。只有此值为 true 时，整文件撤回才允许删除文件。
   * 注意 write 的 `before: null` 有两种含义：create（文件原本不存在）与
   * update-without-baseline（覆盖式写入但没有基线快照）——后者绝不能当新建文件删掉。
   */
  created?: boolean;
  /**
   * 快照过大被截成占位（before/after 置空）的标记（契约 §7）。
   * 只有它为 true 才表示"快照过大，不可撤回"；空文件与占位不再混同。
   */
  truncated?: boolean;
  ts: number;
  /** 已撤回的 hunk 索引（hunk 级部分撤回后标记） */
  revertedHunks?: number[];
  /** 已认可（确认保留）的 hunk 索引 */
  acceptedHunks?: number[];
}

export interface LedgerState {
  ops: LedgerOp[];
  /** 历史被容量裁剪过的文件（canonical 口径）：撤回基线判定依赖它 */
  prunedFiles?: string[];
}

export interface LedgerOptions {
  maxOpsPerFile: number;
  /** 全台账上限（按文件分桶之外的兜底） */
  maxOpsTotal: number;
  maxOpBytes: number;
}

export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = {
  maxOpsPerFile: 100,
  maxOpsTotal: 2000,
  maxOpBytes: 120 * 1024,
};

/** state 文件读取上限：超过就不解析，避免一次 apply 把主线程拖死。 */
const MAX_STATE_BYTES = 64 * 1024 * 1024;

/** 索引数组必须是整数数组（契约 §7：revertedHunks/acceptedHunks 严格校验）。 */
function isIndexArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0);
}

function isValidOp(value: unknown): value is LedgerOp {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '') return false;
  if (typeof o.sessionId !== 'string') return false;
  if (typeof o.filePath !== 'string' || o.filePath === '') return false;
  if (typeof o.after !== 'string') return false;
  if (!(o.before === undefined || o.before === null || typeof o.before === 'string')) return false;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return false;
  if (!(o.turn === undefined || o.turn === null || typeof o.turn === 'number')) return false;
  if (!(o.created === undefined || typeof o.created === 'boolean')) return false;
  if (!(o.truncated === undefined || typeof o.truncated === 'boolean')) return false;
  if (!(o.revertedHunks === undefined || isIndexArray(o.revertedHunks))) return false;
  if (!(o.acceptedHunks === undefined || isIndexArray(o.acceptedHunks))) return false;
  return true;
}

/**
 * 台账内的路径比较口径（契约 §1）：优先用 canonicalPath（同一口径跨 host/core）；
 * 非绝对路径拿不到 canonical 时退化为"反斜杠转正斜杠 + 去尾斜杠"。
 */
function pathKey(p: string): string {
  const canonical = canonicalPath(p);
  if (canonical !== undefined) return canonical;
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export class ChangeLedger {
  private ops: LedgerOp[] = [];
  /** 历史被裁剪过的文件（canonical key）：整文件撤回不允许对这类文件走"删除"分支 */
  private prunedFiles = new Set<string>();
  private readonly options: LedgerOptions;
  /** load 因损坏/超大失败过：本进程内不再覆盖写，避免把历史抹成空表。 */
  private storageBroken = false;

  constructor(options: LedgerOptions = DEFAULT_LEDGER_OPTIONS) {
    this.options = options;
  }

  add(op: Omit<LedgerOp, 'id' | 'ts'>): LedgerOp {
    const beforeLen = typeof op.before === 'string' ? op.before.length : 0;
    const tooBig = beforeLen > this.options.maxOpBytes || op.after.length > this.options.maxOpBytes;
    // 超大操作只留占位（可见但不可撤回），但仍要计入上限——否则同一文件反复大改会无限增长。
    // truncated 标记让 UI 能区分"快照过大"与"空文件"（契约 §7）。
    const record: LedgerOp = tooBig
      ? { ...op, id: randomUUID(), ts: Date.now(), before: '', after: '', truncated: true }
      : { ...op, id: randomUUID(), ts: Date.now() };
    this.ops.push(record);
    this.pruneFile(op.filePath);
    this.pruneGlobal();
    return record;
  }

  /** 标记某操作的一个 hunk 已撤回；返回是否成功标记。 */
  markHunkReverted(opId: string, hunkIndex: number): boolean {
    const op = this.ops.find((o) => o.id === opId);
    if (!op) return false;
    if (!op.revertedHunks) op.revertedHunks = [];
    if (!op.revertedHunks.includes(hunkIndex)) op.revertedHunks.push(hunkIndex);
    return true;
  }

  /** 标记某操作的一个 hunk 已认可（确认保留）；返回是否成功标记。 */
  markHunkAccepted(opId: string, hunkIndex: number): boolean {
    const op = this.ops.find((o) => o.id === opId);
    if (!op) return false;
    if (!op.acceptedHunks) op.acceptedHunks = [];
    if (!op.acceptedHunks.includes(hunkIndex)) op.acceptedHunks.push(hunkIndex);
    return true;
  }

  /** 移除某文件在某会话下的全部操作记录（整文件撤回后调用）；路径按 canonical 比较。 */
  removeOpsForFileInSession(sessionId: string, filePath: string): number {
    const before = this.ops.length;
    const key = pathKey(filePath);
    this.ops = this.ops.filter((o) => !(o.sessionId === sessionId && pathKey(o.filePath) === key));
    return before - this.ops.length;
  }

  /** 每个文件最多保留 maxOpsPerFile 条，超出丢最旧（按 canonical 路径分桶）。 */
  private pruneFile(filePath: string): void {
    const max = this.options.maxOpsPerFile;
    const key = pathKey(filePath);
    // 只扫本条记录附近没有意义，直接按桶收集下标；ops 已达上限时是 O(n)
    const idxs: number[] = [];
    for (let i = 0; i < this.ops.length; i++) if (pathKey(this.ops[i].filePath) === key) idxs.push(i);
    while (idxs.length > max) {
      const victim = idxs.shift()!;
      this.notePruned(this.ops[victim]?.filePath);
      this.ops.splice(victim, 1);
      for (let k = 0; k < idxs.length; k++) if (idxs[k] > victim) idxs[k]--;
    }
  }

  /** 全台账上限：超出时丢最旧的记录（不同文件/会话累积也不至于无限增长）。 */
  private pruneGlobal(): void {
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
  private notePruned(filePath: string | undefined): void {
    if (typeof filePath !== 'string' || filePath === '') return;
    this.prunedFiles.add(pathKey(filePath));
  }

  /** 该文件的历史是否被容量裁剪过（撤回基线判定必须看它）。 */
  wasPruned(filePath: string): boolean {
    return this.prunedFiles.has(pathKey(filePath));
  }

  all(): readonly LedgerOp[] {
    return this.ops;
  }

  opsForFile(filePath: string): LedgerOp[] {
    const key = pathKey(filePath);
    return this.ops.filter((o) => pathKey(o.filePath) === key);
  }

  opsForSession(sessionId: string): LedgerOp[] {
    return this.ops.filter((o) => o.sessionId === sessionId);
  }

  /** 本会话涉及的文件（按 canonical 口径去重，返回首次出现的原串）。 */
  filesForSession(sessionId: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const op of this.opsForSession(sessionId)) {
      const key = pathKey(op.filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(op.filePath);
    }
    return out;
  }

  clearSession(sessionId: string): number {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => o.sessionId !== sessionId);
    return before - this.ops.length;
  }

  clear(): void {
    this.ops = [];
    this.prunedFiles.clear();
  }

  /** 是否发生过 load 失败（用于避免覆盖写丢历史）。 */
  isStorageBroken(): boolean {
    return this.storageBroken;
  }

  load(path: string): void {
    let raw: string;
    try {
      const size = statSync(path).size;
      if (size > MAX_STATE_BYTES) {
        this.quarantine(path, 'oversized');
        this.storageBroken = true;
        return;
      }
      raw = readFileSync(path, 'utf8');
    } catch {
      // 文件不存在 → 全新台账（正常路径）
      return;
    }
    try {
      const parsed = JSON.parse(raw) as LedgerState;
      const ops = parsed?.ops;
      const list: unknown[] = Array.isArray(ops) ? ops : [];
      const valid = list.filter(isValidOp);
      this.ops = valid;
      // 恢复"历史被裁剪过"的文件集合：撤回基线判定依赖它，丢了就会误删
      const pruned = parsed?.prunedFiles;
      this.prunedFiles = new Set(
        (Array.isArray(pruned) ? pruned : []).filter((x): x is string => typeof x === 'string' && x !== ''),
      );
      const dropped = list.length - valid.length;
      if (dropped > 0) {
        console.warn(
          `ws-studio: 台账有 ${dropped} 条记录字段非法，已丢弃（保留 ${valid.length} 条）；原文件另存为 .dropped 备份: ${path}`,
        );
        this.backup(path, 'dropped');
      } else if (ops !== undefined && !Array.isArray(ops)) {
        console.warn(`ws-studio: 台账 ops 字段不是数组，按空台账处理；原文件另存为 .dropped 备份: ${path}`);
        this.backup(path, 'dropped');
      }
    } catch {
      // 损坏：隔离而不是静默清空，并禁止本进程覆盖写
      this.quarantine(path, 'corrupt');
      this.storageBroken = true;
      console.error(`ws-studio: state 文件解析失败，已隔离为 .corrupt 备份（本次不覆盖写）: ${path}`);
    }
  }

  /** 把损坏/超大的 state 文件改名隔离，保留人工排查的可能。 */
  private quarantine(path: string, reason: string): void {
    try {
      renameSync(path, `${path}.${reason}-${Date.now()}`);
    } catch {
      // 隔离失败就算了，至少不改写原文件
    }
  }

  /** 另存一份原文件（丢弃非法记录时用：不移动原文件，只是留证）。 */
  private backup(path: string, reason: string): void {
    try {
      copyFileSync(path, `${path}.${reason}-${Date.now()}`);
    } catch {
      // 备份失败不阻塞加载
    }
  }

  save(path: string): void {
    if (this.storageBroken && this.ops.length === 0) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const state: LedgerState = { ops: this.ops, prunedFiles: [...this.prunedFiles] };
    const json = JSON.stringify(state);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, json, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }
}
