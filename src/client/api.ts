// 浏览器半侧 API 层：与 host 的 /ws-studio/* 路由通信（同源 fetch）。
import type { FileEntry, OpsPayload, ReadResult, RevertResult, SessionContext } from '../shared/types.ts';

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  return (await res.json()) as T;
}

/** ① 工作区文件树 */
export function apiTree(root: string): Promise<FileEntry[]> {
  return apiJson(`/ws-studio/tree?root=${encodeURIComponent(root)}`);
}

/** ② 文件内容 */
export function apiFile(path: string): Promise<ReadResult> {
  return apiJson(`/ws-studio/file?path=${encodeURIComponent(path)}`);
}

/** 会话上下文（默认文件树根） */
export function apiContext(session: string): Promise<SessionContext> {
  return apiJson(`/ws-studio/context?session=${encodeURIComponent(session)}`);
}

/** ③ 某文件/会话的改动列表（含 hunks） */
export function apiOps(session: string, file?: string): Promise<OpsPayload> {
  const fileQ = file ? `&file=${encodeURIComponent(file)}` : '';
  return apiJson(`/ws-studio/ops?session=${encodeURIComponent(session)}${fileQ}`);
}

/** ④ 撤回：带 op+hunk 为 hunk 级；不带为整文件 */
export function apiRevert(session: string, path: string, op?: number, hunk?: number): Promise<RevertResult> {
  return apiJson(`/ws-studio/revert?session=${encodeURIComponent(session)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, op: op ?? null, hunk: hunk ?? null }),
  });
}

/** 认可一个变更块（确认保留，不再标记/显示差异） */
export function apiAccept(session: string, path: string, op: number, hunk: number): Promise<RevertResult> {
  return apiJson(`/ws-studio/accept?session=${encodeURIComponent(session)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, op, hunk }),
  });
}

export function apiClear(session: string): Promise<{ ok: boolean }> {
  return apiJson(`/ws-studio/clear?session=${encodeURIComponent(session)}`, { method: 'POST' });
}
