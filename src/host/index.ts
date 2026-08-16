// ws-studio 插件入口（host 半侧）：
// 监听 tools/result 记录 write/edit 前后快照 → 台账；
// 注册 HTTP/SSE 路由供浏览器半侧使用。
// 参考 dsh-change-review 的集成模式（tools 事件 / webServer / agents store）。

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ChangeLedger } from '../core/ledger.ts';
import { WsStudioService } from './service.ts';
import { registerRoutes } from './routes.ts';
import { currentTurnOf, newTurnCursor, resolveRootId, type TurnCursor } from './agents.ts';
import type { AgentsLike } from './types.ts';

export const name = 'ws-studio';
export const inject = ['webServer', 'agents', 'fs'];

const STATE_FILE_NAME = 'ws-studio-state.json';
const SAVE_DEBOUNCE_MS = 800;

interface HostContext {
  baseUrl?: string;
  webServer: { register(route: unknown): unknown };
  agents: AgentsLike;
  fs?: unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  effect(fn: () => (() => void) | void, label?: string): unknown;
}

function stateFilePath(ctx: HostContext): string {
  try {
    if (ctx.baseUrl) return fileURLToPath(new URL(STATE_FILE_NAME, ctx.baseUrl));
  } catch {
    // baseUrl 不可解析时回退 home
  }
  return join(homedir(), '.dsh', STATE_FILE_NAME);
}

export function apply(ctx: HostContext): void {
  const ledger = new ChangeLedger();
  const stateFile = stateFilePath(ctx);
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
    }
    return c;
  };

  const service = new WsStudioService({
    ledger,
    fs: ctx.fs as never,
    resolveRoot: (agentId) => resolveRootId(ctx.agents, agentId),
    currentTurn: (rootId) => currentTurnOf(ctx.agents, rootId, cursorFor(rootId)),
    sessionCwd: (sessionId) => {
      const entry = ctx.agents.store.get(sessionId);
      return entry?.agent?.session?.header?.cwd;
    },
  });

  ctx.on('tools/result', (exec: unknown, result: unknown) => {
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
      const r = result as { isError?: unknown; error?: unknown; ok?: unknown; failed?: unknown; value?: unknown } | null | undefined;
      if (r && (r.isError || r.error || r.ok === false || r.failed)) return;
      const value = r && !r.isError && r.value && typeof r.value === 'object' ? r.value : null;
      const hasBefore = value !== null && 'before' in (value as Record<string, unknown>);
      const hasAfter = value !== null && 'after' in (value as Record<string, unknown>);
      if (!hasAfter) return; // 没有 after 快照的操作无法展示/撤回
      const beforeRaw = hasBefore ? (value as Record<string, unknown>).before : undefined;
      const before = beforeRaw === null || beforeRaw === undefined ? beforeRaw : String(beforeRaw);
      const after = String((value as Record<string, unknown>).after);
      const rootId = service.resolveRoot(agentId);
      ledger.add({
        sessionId: rootId,
        filePath: file,
        before,
        after,
        turn: service.currentTurn(rootId),
      });
      service.notifyChanged(rootId);
      scheduleSave();
    } catch (err) {
      console.error('ws-studio track failed', err);
    }
  });

  registerRoutes(service, ctx.webServer);
}
