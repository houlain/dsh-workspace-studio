// 会话归属工具：子代理聚合到根会话 + 从会话日志尾部解析当前轮次。
//
// 0.2.1 的真实形状（对照 dsh-diff-approval / dsh-cost-meter 的用法）：
// - 父会话标识在 `agent.session.header.parentSession`（`delegationDepth` 辅助），
//   不是 `agent.owner`；`agents.store` 在本机宿主里无证据。
// - 事件日志通过 `agent.session.snapshotEvents()` 取，不是 `session.events` 属性。
// 这里对两套形状都做兼容：新形状优先，旧形状作为回退。

import type { AgentLike, AgentsLike } from './types.ts';

export interface TurnCursor {
  turn: number | null;
  scanSeq: number;
}

export function newTurnCursor(): TurnCursor {
  return { turn: null, scanSeq: 0 };
}

/** 取某个会话的 Agent：优先新访问器，回退旧 store 条目。 */
export function agentOf(agents: AgentsLike | undefined, id: string): AgentLike | undefined {
  if (!agents) return undefined;
  try {
    const direct = agents.get?.(id);
    if (direct) return direct;
  } catch {
    // 新访问器在旧宿主上缺失或抛错 → 走 store
  }
  try {
    return agents.store?.get(id)?.agent;
  } catch {
    return undefined;
  }
}

/** 取某个会话的父会话 id（子代理指回父会话）。 */
function parentOf(agents: AgentsLike | undefined, id: string): string | undefined {
  const agent = agentOf(agents, id);
  const header = agent?.session?.header as { parentSession?: unknown } | undefined;
  if (header && typeof header.parentSession === 'string' && header.parentSession !== '') {
    return header.parentSession;
  }
  try {
    const fromStore = agents?.store?.get(id)?.owner?.id;
    if (typeof fromStore === 'string' && fromStore !== '') return fromStore;
  } catch {
    // 忽略
  }
  try {
    const fromAgent = agent?.owner?.id;
    if (typeof fromAgent === 'string' && fromAgent !== '') return fromAgent;
  } catch {
    // 忽略
  }
  return undefined;
}

/** 沿父链向上走到根会话，使子代理的改动归入用户看到的父会话。 */
export function resolveRootId(agents: AgentsLike, agentId: string): string {
  let current = agentId;
  const seen = new Set<string>([current]);
  // 归属链理论上很短；设上限防御环。
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = parentOf(agents, current);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = parent;
  }
  return current;
}

/** 取会话事件序列：0.2.1 是 snapshotEvents()，旧形状是 events 数组。 */
function eventsOf(agent: AgentLike | undefined): ReadonlyArray<{ type: string; data?: { turn?: number } }> | undefined {
  if (!agent) return undefined;
  const session = agent.session as
    | { snapshotEvents?: () => unknown; events?: unknown }
    | undefined;
  if (!session) return undefined;
  try {
    if (typeof session.snapshotEvents === 'function') {
      const list = session.snapshotEvents();
      if (Array.isArray(list)) {
        return list as ReadonlyArray<{ type: string; data?: { turn?: number } }>;
      }
    }
  } catch {
    // 快照读取失败 → 尝试旧属性
  }
  const legacy = session.events;
  if (Array.isArray(legacy)) return legacy as ReadonlyArray<{ type: string; data?: { turn?: number } }>;
  return undefined;
}

/** 增量扫描会话日志尾部，返回当前轮次号（无轮次返回 null）。 */
export function currentTurnOf(agents: AgentsLike, rootId: string, cursor: TurnCursor): number | null {
  try {
    const events = eventsOf(agentOf(agents, rootId));
    if (events && events.length > cursor.scanSeq) {
      const from = cursor.scanSeq;
      cursor.scanSeq = events.length;
      for (let i = events.length - 1; i >= from; i--) {
        const e = events[i];
        if (e.type === 'turn/start') {
          cursor.turn = e.data && typeof e.data.turn === 'number' ? e.data.turn : null;
          break;
        }
        if (e.type === 'turn/end') {
          cursor.turn = null;
          break;
        }
      }
    } else if (events && events.length < cursor.scanSeq) {
      // 会话被压缩/恢复导致日志变短：游标失效，重置后重扫
      cursor.scanSeq = 0;
    }
  } catch {
    // 会话状态不可读时保持现状
  }
  return cursor.turn;
}
