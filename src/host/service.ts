// 服务门面：把核心逻辑（台账/diff/hunk 撤回/文件树）与 DSH 运行时解耦。
// 文件访问优先走 ctx.fs（策略感知），缺失时回退 node:fs；
// 所有依赖可注入，便于纯 Node 环境测试。
//
// 0.3.0 契约要点：
// §1 路径比较统一走 canonicalPath（台账分桶 / 文件匹配 / 清账都不再用裸字符串相等）；
// §3 撤回/认可按 opId 定位，找不到就明确报"已过期或被清理"；
// §4 整文件撤回的基线 = 最早一条**仍带内容快照**的记录，不再假设 ops[0]；
// §5 写意图 {kind:'replaceIfVersion', version}；删除必须先过会话沙箱根校验。

import { ChangeLedger, type LedgerOp } from '../core/ledger.ts';
import { diffHunks, type Hunk } from '../core/diff.ts';
import { revertHunk as applyHunkRevert } from '../core/hunkRevert.ts';
import { buildFileTree, type FsReader, type TreeOptions } from '../core/fileTree.ts';
import { canonicalPath, isPathInsideWorkspace } from './security.ts';
import type { FsLike, FsWriteIntentLike } from './types.ts';

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
  /** 会话工作目录（浏览器侧文件树默认根；也是删除语义的沙箱根） */
  sessionCwd?: (sessionId: string) => string | undefined;
  /**
   * 写操作的路径授权（工作区归属校验）。提供时，越界的撤回/删除一律拒绝；
   * 未提供时按"拒绝写"处理（fail closed），只在纯只读场景下省略。
   */
  isWriteAllowed?: (path: string, sessionId: string) => boolean;
  /** 单文件读取上限（字节），超出拒绝读取 */
  maxReadBytes?: number;
  treeOptions?: TreeOptions;
  /**
   * 用户动作（撤回/认可/清空）成功后的落盘回调（契约 §7）；host 侧传 scheduleSave。
   * 落盘失败不影响功能，也不该把成功结果变成失败。
   */
  persist?: () => void;
}

/**
 * 写意图（契约 §5）：宿主的 writeText 第三参是 FsWriteIntent（types.ts 的 FsWriteIntentLike），
 * **不是裸 version**；无版本时一律传 undefined 表示无条件写。
 */
export type WriteIntent = FsWriteIntentLike;

/** 操作记录找不到时的统一口径（契约 §3）。 */
const EXPIRED_OP = '该操作已过期或被清理，请刷新';

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** 展示用路径：Windows 反斜杠 → 正斜杠（台账路径与文件树拼接路径统一展示）。 */
const normPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * 比较/分桶用的键（契约 §1）：能拿到 canonical 就用它，非绝对路径退化为去尾斜杠的规范化串。
 * 展示仍用原串（normPath），绝不把折叠后的路径回吐给 UI。
 */
const pathKey = (p: string): string => canonicalPath(p) ?? normPath(p).replace(/\/+$/, '');

/**
 * 该操作是否带**可用**的内容快照（契约 §4/§7）。
 * - truncated === true 是"快照过大"占位，不等于空文件，绝不可撤回；
 * - before === '' 按契约 §4 视为占位（旧台账没有 truncated 标记，只能这样兜底）；
 * - 没有 after 快照的操作无法计算 diff（保持 0.2.2 行为）。
 */
function hasSnapshot(op: LedgerOp): boolean {
  if (op.truncated === true) return false;
  if (op.before === null || op.before === undefined) return false;
  if (op.before === '') return false;
  return op.after !== '';
}

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

  /** 会话上下文（浏览器侧默认文件树根目录）；取不到时给 null（契约 §2：不要空对象）。 */
  sessionContext(sessionId: string): SessionContext {
    const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : undefined;
    return { cwd: cwd !== undefined && cwd !== '' ? cwd : null };
  }

  /** 会话级沙箱策略：撤回写入按会话工作区根放行（workspace-write）。
   *  返回 undefined 表示拿不到会话工作区——调用方必须**拒绝写入**（fail closed），
   *  不能让它落回部署默认策略（那可能是 danger-full-access）。 */
  private sandboxPolicyFor(sessionId: string): { mode: 'workspace-write'; workspaceRoot: string } | undefined {
    const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : undefined;
    return cwd ? { mode: 'workspace-write', workspaceRoot: cwd } : undefined;
  }

  /** 写路径的统一前置校验：授权 + 沙箱策略都要有，缺一即拒。 */
  private writeGuard(
    sessionId: string,
    filePath: string,
  ):
    | { ok: true; policy: { mode: 'workspace-write'; workspaceRoot: string } }
    | { ok: false; error: string } {
    const check = this.deps.isWriteAllowed;
    if (!check) return { ok: false, error: '插件未配置写授权，拒绝改写文件' };
    let allowed = false;
    try {
      allowed = check(filePath, sessionId);
    } catch {
      allowed = false;
    }
    if (!allowed) return { ok: false, error: '该路径不在已注册的工作区内，拒绝改写' };
    const policy = this.sandboxPolicyFor(sessionId);
    if (!policy) return { ok: false, error: '取不到会话工作区，无法在受限沙箱内写入，已拒绝' };
    return { ok: true, policy };
  }

  /** 用户动作成功后落盘（契约 §7）；失败不影响已成功的内存状态。 */
  private persist(): void {
    try {
      this.deps.persist?.();
    } catch {
      // 落盘失败不阻塞功能
    }
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

  /** 某会话中某文件的全部操作（路径按 canonical 比较，返回台账原序）。 */
  private opsOf(sessionId: string, filePath: string): LedgerOp[] {
    const key = pathKey(filePath);
    return this.deps.ledger.opsForSession(sessionId).filter((o) => pathKey(o.filePath) === key);
  }

  /** 按 opId 定位（契约 §3）：只在该会话、该文件下找，找不到交给调用方报"已过期"。 */
  private opById(sessionId: string, filePath: string, opId: unknown): LedgerOp | undefined {
    if (typeof opId !== 'string' || opId === '') return undefined;
    return this.opsOf(sessionId, filePath).find((o) => o.id === opId);
  }

  /** 该操作的 hunk 列表；没有可用快照时为空数组（前端据此显示"不可撤回"）。 */
  private hunksOf(op: LedgerOp): Hunk[] {
    if (!hasSnapshot(op)) return [];
    return diffHunks((op.before as string).split('\n'), op.after.split('\n'));
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
    const sessionOps = this.deps.ledger.opsForSession(sessionId);
    const wanted = filePath !== undefined && filePath !== '' ? filePath : undefined;
    // canonical 分桶：同一文件的不同写法（\ 与 /、大小写）合并成一条
    const buckets = new Map<string, { path: string; ops: LedgerOp[] }>();
    if (wanted !== undefined) {
      const key = pathKey(wanted);
      const ops = sessionOps.filter((o) => pathKey(o.filePath) === key);
      buckets.set(key, { path: normPath(wanted), ops });
    } else {
      for (const op of sessionOps) {
        const key = pathKey(op.filePath);
        const bucket = buckets.get(key);
        if (bucket) bucket.ops.push(op);
        else buckets.set(key, { path: normPath(op.filePath), ops: [op] });
      }
    }
    const files: FileOpsView[] = [];
    for (const bucket of buckets.values()) {
      const ops = bucket.ops;
      if (ops.length === 0) continue;
      const views: OpView[] = ops.map((op, index) => this.viewOf(op, index));
      const pending = views.some((v) => v.pending);
      // 文件列表视图（不带 file）只列出仍有未处理改动的文件；
      // 指定文件时始终返回（已处理的块以"已撤回/已认可"紧凑形式展示）。
      if (wanted === undefined && !pending) continue;
      files.push({
        path: bucket.path,
        latestAt: Math.max(...ops.map((o) => o.ts), 0),
        ops: views,
        pending,
      });
    }
    files.sort((x, y) => y.latestAt - x.latestAt);
    return { files };
  }

  private viewOf(op: LedgerOp, index: number): OpView {
    const truncated = op.truncated === true;
    const revertible = hasSnapshot(op);
    const hunks: Hunk[] = revertible ? this.hunksOf(op) : [];
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
      removed,
    };
  }

  /** ④c 认可一个变更块（确认保留，不再标记、不再显示差异） */
  async acceptHunk(sessionId: string, filePath: string, opId: string, hunkIndex: number): Promise<RevertResult> {
    const op = this.opById(sessionId, filePath, opId);
    if (!op) return { ok: false, error: EXPIRED_OP };
    const hunks = this.hunksOf(op);
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) {
      return { ok: false, error: `变更块索引无效（该操作共有 ${hunks.length} 个变更块）` };
    }
    const reverted = op.revertedHunks ?? [];
    const accepted = op.acceptedHunks ?? [];
    if (reverted.includes(hunkIndex)) return { ok: false, error: '该变更块已撤回，无需认可' };
    if (accepted.includes(hunkIndex)) return { ok: false, error: '该变更块已认可' };
    this.deps.ledger.markHunkAccepted(op.id, hunkIndex);
    this.persist();
    this.notifyChanged(sessionId);
    return { ok: true, message: `已认可变更块 ${hunkIndex + 1}` };
  }

  /** ④d 一键同意：认可该文件当前所有待处理的变更块（与「撤回全部修改」对称）。 */
  async acceptAllHunks(sessionId: string, filePath: string): Promise<RevertResult> {
    const ops = this.opsOf(sessionId, filePath);
    if (ops.length === 0) return { ok: false, error: '该文件没有可认可的修改' };
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
    if (pending === 0) return { ok: false, error: '该文件没有待处理的变更块' };
    this.persist();
    this.notifyChanged(sessionId);
    return { ok: true, message: `已认可 ${marked} 个变更块` };
  }

  /** ④a hunk 级部分撤回 */
  async revertHunk(sessionId: string, filePath: string, opId: string, hunkIndex: number): Promise<RevertResult> {
    const op = this.opById(sessionId, filePath, opId);
    if (!op) return { ok: false, error: EXPIRED_OP };
    if (op.truncated === true) return { ok: false, error: '该操作的快照过大，不可撤回' };
    if (!hasSnapshot(op)) return { ok: false, error: '该操作没有完整内容快照，无法撤回' };
    const hunks = this.hunksOf(op);
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0 || hunkIndex >= hunks.length) {
      return { ok: false, error: `变更块索引无效（该操作共有 ${hunks.length} 个变更块）` };
    }
    // 已处理过的块不再重复处理（契约 §3：revertHunk 也要先查）
    const reverted = op.revertedHunks ?? [];
    const accepted = op.acceptedHunks ?? [];
    if (reverted.includes(hunkIndex)) return { ok: false, error: '该变更块已撤回' };
    if (accepted.includes(hunkIndex)) return { ok: false, error: '该变更块已认可，无法撤回' };
    // 先取版本令牌，再读内容：写入时用它做乐观并发校验
    const expected = await this.versionOf(filePath);
    const read = await this.readFileText(filePath);
    if (!read.ok) return { ok: false, error: read.error };
    const r = applyHunkRevert(read.content.split('\n'), op.before as string, op.after, hunkIndex);
    if (!r.ok) return { ok: false, error: r.reason };
    const written = await this.writeGuarded(sessionId, filePath, r.content, expected);
    if (!written.ok) return written;
    this.deps.ledger.markHunkReverted(op.id, hunkIndex);
    this.persist();
    this.notifyChanged(sessionId);
    return { ok: true, message: `已撤回变更块 ${hunkIndex + 1}` };
  }

  /**
   * ④b 整文件撤回（恢复到该文件在本次会话的最早可用基线前；新建文件则删除）。
   * 基线策略见契约 §4：不再假设 ops[0]，而是取最早一条**仍带内容快照**的记录。
   */
  async revertFile(sessionId: string, filePath: string): Promise<RevertResult> {
    const ops = this.opsOf(sessionId, filePath).slice().sort((a, b) => a.ts - b.ts);
    if (ops.length === 0) return { ok: false, error: '该文件没有可撤回的修改' };
    let baseline: LedgerOp | undefined;
    let unsafe = false;
    for (const op of ops) {
      if (op.before === undefined) {
        // 未记录基线：更晚的快照已经包含这次改动，拿它当基线等于静默保留改动
        unsafe = true;
        break;
      }
      if (op.before === null) {
        if (op.created === true) {
          baseline = op;
          break;
        }
        // write 的 before:null 也可能是"覆盖式写入但没有基线"——删文件/回填都是数据丢失
        unsafe = true;
        break;
      }
      if (op.before === '') continue; // 过大占位（旧台账没有 truncated 标记）：跳过，继续找更晚的快照
      baseline = op;
      break;
    }
    if (unsafe) {
      return {
        ok: false,
        error: '该文件的首条修改没有基线快照（并非在当前会话中新建），无法安全撤回；请手动处理',
      };
    }
    if (!baseline) return { ok: false, error: '原始内容快照已被清理（没有可用基线），无法安全撤回' };
    try {
      if (baseline.before === null) {
        // 历史被裁剪过 → 一条 create 记录不能证明"文件在会话开始时不存在"：
        // 它可能只是"删掉后重建"的中间态，更早的原始内容已被裁剪丢弃。
        if (typeof this.deps.ledger.wasPruned === 'function' && this.deps.ledger.wasPruned(filePath)) {
          return {
            ok: false,
            error: '该文件的历史记录已被容量裁剪，无法确认它是否在会话开始时已存在；已拒绝删除，请手动处理',
          };
        }
        // 只有基线确认是「创建」（created === true）才允许删除
        const guard = this.writeGuard(sessionId, filePath);
        if (!guard.ok) return { ok: false, error: guard.error };
        const cwd = this.deps.sessionCwd ? this.deps.sessionCwd(sessionId) : undefined;
        if (!cwd || !isPathInsideWorkspace(filePath, [cwd])) {
          return { ok: false, error: '该文件不在会话工作区内，拒绝删除' };
        }
        await this.deleteFile(filePath, guard.policy);
      } else {
        const expected = await this.versionOf(filePath);
        const w = await this.writeGuarded(sessionId, filePath, baseline.before, expected);
        if (!w.ok) return w;
      }
      // 成功后再清账；清账口径走 canonical（契约 §1/§4）
      this.deps.ledger.removeOpsForFileInSession(sessionId, filePath);
      this.persist();
      this.notifyChanged(sessionId);
      return {
        ok: true,
        message: baseline.before === null ? '已删除本次会话中新建的文件' : '已撤回该文件的全部修改',
      };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  }

  clearSession(sessionId: string): void {
    this.deps.ledger.clearSession(sessionId);
    this.persist();
    this.notifyChanged(sessionId);
  }

  /**
   * 统一写入口：授权 + 沙箱策略 + 乐观并发。
   * `version` 是读文件那一刻的版本令牌；有版本时包成 `{kind:'replaceIfVersion', version}` 交给宿主
   * （契约 §5：不是裸 version），无版本时传 undefined 表示无条件写。
   */
  private async writeGuarded(
    sessionId: string,
    path: string,
    content: string,
    version?: unknown,
  ): Promise<RevertResult> {
    const guard = this.writeGuard(sessionId, path);
    if (!guard.ok) return { ok: false, error: guard.error };
    const expected: WriteIntent | undefined =
      version === undefined || version === null ? undefined : { kind: 'replaceIfVersion', version };
    try {
      if (this.deps.fs) {
        const target = await this.deps.fs.resolve(path);
        await this.deps.fs.writeText(target, content, expected, undefined, guard.policy);
      } else if (this.deps.nodeWrite) {
        await this.deps.nodeWrite(path, content);
      } else {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path, content, 'utf8');
      }
      return { ok: true, message: '' };
    } catch (e) {
      return { ok: false, error: `写入被拒绝或文件已被并发修改：${String((e as Error).message ?? e)}` };
    }
  }

  /** 读文件同时取回版本令牌，供写入时的乐观并发校验使用。 */
  private async versionOf(path: string): Promise<unknown> {
    if (!this.deps.fs) return undefined;
    try {
      const target = await this.deps.fs.resolve(path);
      const info = await this.deps.fs.stat(target);
      return info?.version;
    } catch {
      return undefined;
    }
  }

  /**
   * 删除文件（契约 §5）。前置条件是**已经**确认过路径在沙箱根内；这里再校验一次兜底：
   * - 后端有 `remove(target, policy)` → 用它（受沙箱约束）；
   * - 否则用 `processPath` 拿本机路径再 `unlink`（受沙箱约束，绝不裸删）；
   * - 两者都没有则拒绝。
   */
  private async deleteFile(
    path: string,
    sandboxPolicy: { mode: 'workspace-write'; workspaceRoot: string },
  ): Promise<void> {
    // 兜底复核：任何路径在删除前都必须落在会话沙箱根内
    if (!isPathInsideWorkspace(path, [sandboxPolicy.workspaceRoot])) {
      throw new Error('目标不在会话工作区内，拒绝删除');
    }
    const fs = this.deps.fs;
    if (fs) {
      const target = await fs.resolve(path);
      if (typeof fs.remove === 'function') {
        await fs.remove(target, sandboxPolicy);
        return;
      }
      const osPath = typeof fs.processPath === 'function' ? fs.processPath(target) : undefined;
      if (typeof osPath === 'string' && osPath !== '') {
        const { unlink } = await import('node:fs/promises');
        await unlink(osPath);
        return;
      }
    }
    if (this.deps.nodeUnlink) {
      await this.deps.nodeUnlink(path);
      return;
    }
    throw new Error('当前文件系统后端没有删除能力，请手动删除该文件');
  }
}
