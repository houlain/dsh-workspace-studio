// 会话归属工具：子代理聚合到根会话 + 从会话日志尾部解析当前轮次。
// 参考 dsh-change-review 的同名实现（结构类型化版本）。

import type { AgentsLike } from './types.ts';

export interface TurnCursor {
  turn: number | null;
  scanSeq: number;
}

export function newTurnCursor(): TurnCursor {
  return { turn: null, scanSeq: 0 };
}

/** 沿 owner 链向上走到根会话，使子代理的改动归入用户看到的父会话。 */
export function resolveRootId(agents: AgentsLike, agentId: string): string {
  const store = agents?.store;
  if (!store) return agentId;
  let current = store.get(agentId);
  if (!current) return agentId;
  const seen = new Set<string>();
  while (current.owner && current.owner.id && !seen.has(current.owner.id)) {
    seen.add(current.owner.id);
    const next = store.get(current.owner.id);
    if (!next) break;
    current = next;
  }
  return current.agent && current.agent.id ? current.agent.id : agentId;
}

/** 增量扫描会话日志尾部，返回当前轮次号（无轮次返回 null）。 */
export function currentTurnOf(agents: AgentsLike, rootId: string, cursor: TurnCursor): number | null {
  try {
    const entry = agents?.store?.get(rootId);
    const events = entry?.agent?.session?.events;
    if (events && Array.isArray(events) && events.length > cursor.scanSeq) {
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
    }
  } catch {
    // 会话状态不可读时保持现状
  }
  return cursor.turn;
}
