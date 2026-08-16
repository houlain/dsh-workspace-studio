// 变更台账：记录会话内每次 write/edit 的前后内容快照。
// 纯 TypeScript + node:fs，持久化为 JSON（原子写：tmp + rename）。
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
  ts: number;
  /** 已撤回的 hunk 索引（hunk 级部分撤回后标记） */
  revertedHunks?: number[];
  /** 已认可（确认保留）的 hunk 索引 */
  acceptedHunks?: number[];
}

export interface LedgerState {
  ops: LedgerOp[];
}

export interface LedgerOptions {
  maxOpsPerFile: number;
  maxOpBytes: number;
}

export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = {
  maxOpsPerFile: 100,
  maxOpBytes: 120 * 1024,
};

export class ChangeLedger {
  private ops: LedgerOp[] = [];
  private readonly options: LedgerOptions;

  constructor(options: LedgerOptions = DEFAULT_LEDGER_OPTIONS) {
    this.options = options;
  }

  add(op: Omit<LedgerOp, 'id' | 'ts'>): LedgerOp {
    const beforeLen = typeof op.before === 'string' ? op.before.length : 0;
    if (beforeLen > this.options.maxOpBytes || op.after.length > this.options.maxOpBytes) {
      // 超大操作只留占位（可见但不可撤回），避免台账爆炸
      const record: LedgerOp = { ...op, id: randomUUID(), ts: Date.now(), before: '', after: '' };
      this.ops.push(record);
      return record;
    }
    const record: LedgerOp = { ...op, id: randomUUID(), ts: Date.now() };
    this.ops.push(record);
    this.pruneFile(op.filePath);
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

  /** 移除某文件在某会话下的全部操作记录（整文件撤回后调用）。 */
  removeOpsForFileInSession(sessionId: string, filePath: string): number {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => !(o.sessionId === sessionId && o.filePath === filePath));
    return before - this.ops.length;
  }

  /** 每个文件最多保留 maxOpsPerFile 条，超出丢最旧。 */
  private pruneFile(filePath: string): void {
    const max = this.options.maxOpsPerFile;
    const idxs: number[] = [];
    for (let i = 0; i < this.ops.length; i++) if (this.ops[i].filePath === filePath) idxs.push(i);
    while (idxs.length > max) {
      const victim = idxs.shift()!;
      this.ops.splice(victim, 1);
      for (let k = 0; k < idxs.length; k++) if (idxs[k] > victim) idxs[k]--;
    }
  }

  all(): readonly LedgerOp[] {
    return this.ops;
  }

  opsForFile(filePath: string): LedgerOp[] {
    return this.ops.filter((o) => o.filePath === filePath);
  }

  opsForSession(sessionId: string): LedgerOp[] {
    return this.ops.filter((o) => o.sessionId === sessionId);
  }

  filesForSession(sessionId: string): string[] {
    return [...new Set(this.opsForSession(sessionId).map((o) => o.filePath))];
  }

  clearSession(sessionId: string): number {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => o.sessionId !== sessionId);
    return before - this.ops.length;
  }

  clear(): void {
    this.ops = [];
  }

  load(path: string): void {
    try {
      const raw = readFileSync(path, 'utf8');
      const state = JSON.parse(raw) as LedgerState;
      this.ops = Array.isArray(state.ops) ? state.ops : [];
    } catch {
      this.ops = [];
    }
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ops: this.ops } satisfies LedgerState), 'utf8');
    renameSync(tmp, path);
  }
}
