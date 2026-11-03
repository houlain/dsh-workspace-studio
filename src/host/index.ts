// ws-studio 插件入口（host 半侧）：
// 监听 tools/result 记录 write/edit 前后快照 → 台账；
// 注册 HTTP/SSE 路由供浏览器半侧使用。
// 参考 dsh-change-review 的集成模式（tools 事件 / webServer / agents store）。

import { join } from 'node:path';
import { homedir } from 'node:os';
import { ChangeLedger } from '../core/ledger.ts';
import { WsStudioService } from './service.ts';
import { registerRoutes } from './routes.ts';
import { agentOf, currentTurnOf, newTurnCursor, resolveRootId, type TurnCursor } from './agents.ts';
import { isPathInsideWorkspace } from './security.ts';
import type { AgentsLike, WebServerLike, WorkspaceRegistryLike } from './types.ts';

export const name = 'ws-studio';
// workspaceRegistry 用于路径授权（只允许读写已注册工作区内的文件）
export const inject = ['webServer', 'agents', 'fs', 'workspaceRegistry'];

const STATE_FILE_NAME = 'ws-studio-state.json';
const SAVE_DEBOUNCE_MS = 800;
/** 轮次游标表的容量上限（按会话数），防止长驻进程里无限增长。 */
const MAX_TURN_CURSORS = 200;

interface HostContext {
  baseUrl?: string;
  webServer: WebServerLike;
  agents: AgentsLike;
  workspaceRegistry?: WorkspaceRegistryLike;
  fs?: unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  effect(fn: () => (() => void) | void, label?: string): unknown;
}

function stateFilePath(): string {
  // 固定落在 ~/.dsh：不再跟随 ctx.baseUrl（那会把含全文快照的台账写到插件安装目录，
  // 位置随安装方式变化，既难审计也容易被误打包/误提交）。
  return join(homedir(), '.dsh', STATE_FILE_NAME);
}

/** 已注册工作区的绝对路径（每次现取，新加的工作区立即生效）。 */
function registeredRoots(ctx: HostContext): string[] {
  try {
    const list = ctx.workspaceRegistry?.list?.();
    if (!Array.isArray(list)) return [];
    const roots: string[] = [];
    for (const w of list) {
      const p = typeof w?.path === 'string' ? w.path : undefined;
      if (p !== undefined && p !== '') roots.push(p);
    }
    return roots;
  } catch {
    return [];
  }
}

export function apply(ctx: HostContext): void {
  const ledger = new ChangeLedger();
  const stateFile = stateFilePath();
  ledger.load(stateFile);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        ledger.save(stateFile);
      } catch {
        // 持久化失败不阻塞功能
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
        // 退出时的落盘尽力而为
      }
    },
    'ws-studio: persist flush',
  );

  const turnCursors = new Map<string, TurnCursor>();
  const cursorFor = (rootId: string): TurnCursor => {
    let c = turnCursors.get(rootId);
    if (!c) {
      c = newTurnCursor();
      turnCursors.set(rootId, c);
      // 只增不删会随会话数线性增长：超过上限丢最旧的（Map 保持插入序）
      if (turnCursors.size > MAX_TURN_CURSORS) {
        const oldest = turnCursors.keys().next().value;
        if (oldest !== undefined) turnCursors.delete(oldest);
      }
    }
    return c;
  };

  const sessionCwdOf = (sessionId: string): string | undefined =>
    agentOf(ctx.agents, sessionId)?.session?.header?.cwd;

  /** 写授权：目标必须在已注册工作区或该会话的 cwd 之内。 */
  const isWriteAllowed = (path: string, sessionId: string): boolean => {
    const roots = registeredRoots(ctx);
    const cwd = sessionCwdOf(sessionId);
    if (cwd) roots.push(cwd);
    return roots.length > 0 && isPathInsideWorkspace(path, roots);
  };

  const service = new WsStudioService({
    ledger,
    fs: ctx.fs as never,
    resolveRoot: (agentId) => resolveRootId(ctx.agents, agentId),
    currentTurn: (rootId) => currentTurnOf(ctx.agents, rootId, cursorFor(rootId)),
    // 0.2.1：ctx.agents.get(id).session.header.cwd；旧宿主回退 store 条目里的 agent
    sessionCwd: sessionCwdOf,
    // 写操作（撤回/认可落盘、删除文件）必须落在工作区内，否则 service 直接拒绝
    isWriteAllowed,
    // 用户动作（撤回/认可/清空）成功后立即排一次落盘，避免只靠 tools/result 触发（契约 §7）
    persist: scheduleSave,
  });

  // 监听器必须纳入 effect 生命周期：否则桌面端热重载会叠加多个监听器，
  // 同一次 write/edit 被重复记账。
  ctx.effect(
    () => {
      const off = ctx.on('tools/result', (exec: unknown, result: unknown) => {
        try {
          const e = exec as Record<string, unknown> | null | undefined;
          if (!e) return;
          const toolName = e.tool || e.name;
          if (toolName !== 'write' && toolName !== 'edit') return;
          const input = (e.input || e.arguments || e.args) as Record<string, unknown> | null | undefined;
          if (!input || typeof input !== 'object') return;
          const file = input.file_path || input.file || input.path;
          if (typeof file !== 'string' || !file) return;
          const agentId = (e.agent as { id?: unknown } | undefined)?.id;
          if (typeof agentId !== 'string' || !agentId) return;
          const r = result as
            | { isError?: unknown; error?: unknown; ok?: unknown; failed?: unknown; value?: unknown }
            | null
            | undefined;
          if (r && (r.isError || r.error || r.ok === false || r.failed)) return;
          const value = r && !r.isError && r.value && typeof r.value === 'object' ? r.value : null;
          const hasBefore = value !== null && 'before' in (value as Record<string, unknown>);
          const hasAfter = value !== null && 'after' in (value as Record<string, unknown>);
          if (!hasAfter) return; // 没有 after 快照的操作无法展示/撤回
          const beforeRaw = hasBefore ? (value as Record<string, unknown>).before : undefined;
          const before = beforeRaw === null || beforeRaw === undefined ? beforeRaw : String(beforeRaw);
          const after = String((value as Record<string, unknown>).after);
          // write 的结果带 operation：create = 文件原本不存在（可删）；update = 覆盖式写入
          // （即使 before 为 null 也绝不代表"新建"）。缺 operation 时用 before===null 兜底判定。
          const operation = (value as Record<string, unknown>).operation;
          const created = operation === 'create' || (operation === undefined && before === null);
          const rootId = service.resolveRoot(agentId);
          ledger.add({
            sessionId: rootId,
            filePath: file,
            before,
            after,
            created,
            turn: service.currentTurn(rootId),
          });
          service.notifyChanged(rootId);
          scheduleSave();
        } catch (err) {
          console.error('ws-studio track failed', err);
        }
      });
      return typeof off === 'function' ? (off as () => void) : () => {};
    },
    'ws-studio: tools listener',
  );

  // 路由纳入 effect 生命周期：宿主热重载 / 卸载时会调用返回的释放函数，
  // 否则同一路径会被重复注册（0.2.x 桌面端 HMR 下尤其明显）。
  ctx.effect(
    () =>
      registerRoutes(service, ctx.webServer, {
        workspaceRoots: () => registeredRoots(ctx),
        sessionCwd: sessionCwdOf,
      }),
    'ws-studio: http routes',
  );
}
