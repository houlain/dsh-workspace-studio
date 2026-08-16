// 服务门面：把核心逻辑（台账/diff/hunk 撤回/文件树）与 DSH 运行时解耦。
// 文件访问优先走 ctx.fs（策略感知），缺失时回退 node:fs；
// 所有依赖可注入，便于纯 Node 环境测试。

import { ChangeLedger, type LedgerOp } from '../core/ledger.ts';
import { diffHunks } from '../core/diff.ts';
import { revertHunk as applyHunkRevert } from '../core/hunkRevert.ts';
import { buildFileTree, type FsReader, type TreeOptions } from '../core/fileTree.ts';
import type { FsLike } from './types.ts';

export type {
  FileEntry,
  FileOpsView,
  Hunk,
  OpView,
  OpsPayload,
  ReadResult,
  RevertResult,
  SessionContext,
} from '../shared/types.ts';
import type {
  FileEntry,
  FileOpsView,
  OpsPayload,
  OpView,
  ReadResult,
  RevertResult,
  SessionContext,
} from '../shared/types.ts';

export interface WsStudioDeps {
  ledger: ChangeLedger;
  /** ctx.fs；提供时优先使用（策略感知） */
  fs?: FsLike;
  /** node:fs 回退：读 */
  nodeRead?: (path: string) => Promise<string>;
  /** node:fs 回退：写 */
  nodeWrite?: (path: string, content: string) => Promise<void>;
  /** node:fs 回退：删 */
  nodeUnlink?: (path: string) => Promise<void>;
  resolveRoot?: (agentId: string) => string;
  currentTurn?: (rootId: string) => number | null;
  /** 会话工作目录（浏览器侧文件树默认根） */
  sessionCwd?: (sessionId: string) => string | undefined;
  /** 单文件读取上限（字节），超出拒绝读取 */
  maxReadBytes?: number;
  treeOptions?: TreeOptions;
}

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** 路径归一化：Windows 反斜杠 → 正斜杠，保证台账（工具输入路径）与文件树（拼接路径）可比较。 */
const normPath = (p: string): string => p.replace(/\\/g, '/');

class CtxFsReader implements FsReader {
  private readonly fs: FsLike;
  constructor(fs: FsLike) {
    this.fs = fs;
  }
  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const target = await this.fs.resolve(path);
    const entries = await this.fs.listDir(target);
    return entries.map((e) => ({ name: e.name, isDir: e.type === 'directory' }));
  }
}

class NodeFsReader implements FsReader {
  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
}

export class WsStudioService {
  private readonly listeners = new Set<(sessionId: string) => void>();
  private readonly deps: WsStudioDeps;

  constructor(deps: WsStudioDeps) {
    this.deps = deps;
  }

  /** 会话上下文（浏览器侧默认文件树根目录） */
  sessionContext(sessionId: string): SessionContext {
    return { cwd: this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : undefined };
  }

  /** 会话级沙箱策略：撤回写入按会话工作区根放行（workspace-write），避免命中部署默认根。 */
  private sandboxPolicyFor(sessionId: string): { mode: 'workspace-write'; workspaceRoot: string } | undefined {
    const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : undefined;
    return cwd ? { mode: 'workspace-write', workspaceRoot: cwd } : undefined;
  }

  /** 变更订阅（SSE 广播用）；返回取消函数。 */
  onChanged(cb: (sessionId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  notifyChanged(sessionId: string): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(sessionId);
      } catch {
        // 单个监听器异常不影响其他
      }
    }
  }

  resolveRoot(agentId: string): string {
    return this.deps.resolveRoot ? this.deps.resolveRoot(agentId) : agentId;
  }

  currentTurn(rootId: string): number | null {
    return this.deps.currentTurn ? this.deps.currentTurn(rootId) : null;
  }

  private reader(): FsReader {
    if (this.deps.fs) return new CtxFsReader(this.deps.fs);
    return new NodeFsReader();
  }

  /** ① 工作区文件树 */
  async tree(root: string): Promise<FileEntry[]> {
    return buildFileTree(root, this.reader(), this.deps.treeOptions);
  }

  /** ② 读取文件内容（带大小上限） */
  async readFileText(path: string): Promise<ReadResult> {
    const max = this.deps.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    try {
      let content: string;
      if (this.deps.fs) {
        const target = await this.deps.fs.resolve(path);
        const info = await this.deps.fs.stat(target);
        if (!info) return { ok: false, error: `文件不存在: ${path}` };
        if (info.type !== 'file') return { ok: false, error: `不是普通文件: ${path}` };
        if (typeof info.size === 'number' && info.size > max) {
          return { ok: false, error: `文件过大（${info.size} 字节，上限 ${max}）` };
        }
        content = await this.deps.fs.readText(target);
      } else if (this.deps.nodeRead) {
        content = await this.deps.nodeRead(path);
      } else {
        const { readFile } = await import('node:fs/promises');
        const buf = await readFile(path);
        if (buf.byteLength > max) return { ok: false, error: `文件过大（${buf.byteLength} 字节，上限 ${max}）` };
        content = buf.toString('utf8');
      }
      const truncated = content.length > max;
      return { ok: true, content: truncated ? content.slice(0, max) : content, truncated };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  }

  /** ③ 某会话（可选限定文件）的变更列表：每个操作的 hunks */
  opsFor(sessionId: string, filePath?: string): OpsPayload {
    const paths = filePath ? [filePath] : this.deps.ledger.filesForSession(sessionId);
    const files: FileOpsView[] = [];
    for (const p of paths) {
      const np = normPath(p);
      const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
      if (ops.length === 0) continue;
      const views: OpView[] = ops.map((op, index) => this.viewOf(op, index));
      const pending = views.some((v) => v.pending);
      // 文件列表视图（不带 file）只列出仍有未处理改动的文件；
      // 指定文件时始终返回（已处理的块以"已撤回/已认可"紧凑形式展示）。
      if (!filePath && !pending) continue;
      files.push({
        path: np,
        latestAt: Math.max(...ops.map((o) => o.ts), 0),
        ops: views,
        pending,
      });
    }
    files.sort((x, y) => y.latestAt - x.latestAt);
    return { files };
  }

  private viewOf(op: LedgerOp, index: number): OpView {
    const revertible = op.before !== undefined && op.before !== '' && op.after !== '';
    let hunks: Hunk[] = [];
    if (op.before !== undefined && op.before !== null && op.before !== '' && op.after !== '') {
      hunks = diffHunks(op.before.split('\n'), op.after.split('\n'));
    }
    const revertedHunks = op.revertedHunks ? [...op.revertedHunks] : [];
    const acceptedHunks = op.acceptedHunks ? [...op.acceptedHunks] : [];
    const resolved = new Set([...revertedHunks, ...acceptedHunks]);
    // 有变更块且并非全部已处理 → pending
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
      removed,
    };
  }

  /** ④c 认可一个变更块（确认保留，不再标记、不再显示差异） */
  async acceptHunk(
    sessionId: string,
    filePath: string,
    opIndex: number,
    hunkIndex: number,
  ): Promise<RevertResult> {
    const np = normPath(filePath);
    const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
    const op = ops[opIndex];
    if (!op) return { ok: false, error: `操作索引无效（共 ${ops.length} 条记录）` };
    const hunkCount = this.viewOf(op, opIndex).hunks.length;
    if (hunkIndex < 0 || hunkIndex >= hunkCount) {
      return { ok: false, error: `变更块索引无效（该操作共有 ${hunkCount} 个变更块）` };
    }
    const reverted = op.revertedHunks ?? [];
    const accepted = op.acceptedHunks ?? [];
    if (reverted.includes(hunkIndex)) return { ok: false, error: '该变更块已撤回，无需认可' };
    if (accepted.includes(hunkIndex)) return { ok: false, error: '该变更块已认可' };
    this.deps.ledger.markHunkAccepted(op.id, hunkIndex);
    this.notifyChanged(sessionId);
    return { ok: true, message: `已认可变更块 ${hunkIndex + 1}` };
  }

  /** ④a hunk 级部分撤回 */
  async revertHunk(
    sessionId: string,
    filePath: string,
    opIndex: number,
    hunkIndex: number,
  ): Promise<RevertResult> {
    const np = normPath(filePath);
    const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
    const op = ops[opIndex];
    if (!op) return { ok: false, error: `操作索引无效（共 ${ops.length} 条记录）` };
    if (op.before === undefined || op.before === null || op.before === '' || op.after === '') {
      return { ok: false, error: '该操作没有完整内容快照，无法撤回' };
    }
    const read = await this.readFileText(filePath);
    if (!read.ok) return { ok: false, error: read.error };
    const r = applyHunkRevert(read.content.split('\n'), op.before, op.after, hunkIndex);
    if (!r.ok) return { ok: false, error: r.reason };
    const written = await this.writeFileText(filePath, r.content, this.sandboxPolicyFor(sessionId));
    if (!written.ok) return written;
    this.deps.ledger.markHunkReverted(op.id, hunkIndex);
    this.notifyChanged(sessionId);
    return { ok: true, message: `已撤回变更块 ${hunkIndex + 1}` };
  }

  /** ④b 整文件撤回（恢复到该文件在本次会话的首次操作前；新建文件则删除） */
  async revertFile(sessionId: string, filePath: string): Promise<RevertResult> {
    const np = normPath(filePath);
    const ops = this.deps.ledger.opsForSession(sessionId).filter((o) => normPath(o.filePath) === np);
    const first = ops[0];
    if (!first) return { ok: false, error: '该文件没有可撤回的修改' };
    if (first.before === undefined || first.before === '') {
      return { ok: false, error: '首次修改没有内容快照，无法撤回' };
    }
    try {
      if (first.before === null) {
        // 会话中新建的文件 → 删除
        await this.deleteFile(filePath);
      } else {
        const w = await this.writeFileText(filePath, first.before, this.sandboxPolicyFor(sessionId));
        if (!w.ok) return w;
      }
      this.deps.ledger.removeOpsForFileInSession(sessionId, first.filePath);
      this.notifyChanged(sessionId);
      return {
        ok: true,
        message: first.before === null ? '已删除本次会话中新建的文件' : '已撤回该文件的全部修改',
      };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  }

  clearSession(sessionId: string): void {
    this.deps.ledger.clearSession(sessionId);
    this.notifyChanged(sessionId);
  }

  private async writeFileText(
    path: string,
    content: string,
    sandboxPolicy?: { mode: 'workspace-write'; workspaceRoot: string },
  ): Promise<RevertResult> {
    try {
      if (this.deps.fs) {
        const target = await this.deps.fs.resolve(path);
        await this.deps.fs.writeText(target, content, undefined, undefined, sandboxPolicy);
      } else if (this.deps.nodeWrite) {
        await this.deps.nodeWrite(path, content);
      } else {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path, content, 'utf8');
      }
      return { ok: true, message: '' };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  }

  private async deleteFile(path: string): Promise<void> {
    if (this.deps.fs && this.deps.fs.unlink) {
      const target = await this.deps.fs.resolve(path);
      await this.deps.fs.unlink(target);
      return;
    }
    if (this.deps.nodeUnlink) {
      await this.deps.nodeUnlink(path);
      return;
    }
    const { unlink } = await import('node:fs/promises');
    await unlink(path);
  }
}
