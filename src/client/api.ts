// 浏览器半侧 API 层：与 host 的 /api/dsh-workspace-studio/* 路由通信（同源 fetch）。
//
// 契约（docs/0.3.0-fix-contract.md §2/§3/§8）：
// - **所有**请求（读也带）都带 `x-dsh-workspace-studio: 1` 信任头；
// - `apiJson` 必须同时检查 HTTP 状态（`res.ok`）与载荷里的 `ok === false`，
//   任一为失败就抛错——早期版本只看 JSON，404/403 的错误页也会被当成数据往下传；
// - 撤回/认可按**稳定 id**（`opId`）定位，不再用台账下标（下标会随清账漂移）。
import type { FileEntry, OpsPayload, ReadResult, RevertResult, SessionContext } from '../shared/types.ts';

const PREFIX = '/api/dsh-workspace-studio';

/** 宿主信任头（契约 §2）：写接口据此判定同源 + 回环。读接口也带，口径统一。 */
export const TRUST_HEADER = 'x-dsh-workspace-studio';

/** 接口调用失败。`status` 为 HTTP 状态码；载荷级失败时沿用响应状态。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function payloadError(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const e = (payload as { error?: unknown }).error;
    if (typeof e === 'string' && e.trim() !== '') return e;
  }
  return '';
}

/**
 * 统一请求入口：带信任头 → 解析载荷 → 状态与载荷双重校验。
 * 失败一律抛 `ApiError`，调用方 catch 后写 error 状态（不再把错误包当正常数据用）。
 */
export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { [TRUST_HEADER]: '1' };
  const given = init?.headers as Record<string, string> | undefined;
  if (given) for (const [k, v] of Object.entries(given)) headers[k] = v;

  const res = await fetch(url, { ...init, headers });

  let payload: unknown;
  let parsed = true;
  try {
    payload = await res.json();
  } catch {
    parsed = false;
    payload = undefined;
  }

  if (!res.ok) {
    const detail = payloadError(payload);
    throw new ApiError(`HTTP ${res.status}${detail ? `：${detail}` : ''}`, res.status);
  }
  if (!parsed) throw new ApiError('宿主返回的不是有效的 JSON', res.status);
  if (payload !== null && typeof payload === 'object' && (payload as { ok?: unknown }).ok === false) {
    throw new ApiError(payloadError(payload) || '请求被宿主拒绝', res.status);
  }
  return payload as T;
}

/** 写操作统一入口：POST + JSON（信任头由 apiJson 统一附加）。 */
function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return apiJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** ① 工作区文件树 */
export function apiTree(root: string): Promise<FileEntry[]> {
  return apiJson(`${PREFIX}/tree?root=${encodeURIComponent(root)}`);
}

/** ② 文件内容 */
export function apiFile(path: string): Promise<ReadResult> {
  return apiJson(`${PREFIX}/file?path=${encodeURIComponent(path)}`);
}

/** 会话上下文（默认文件树根）。取不到 cwd 时服务端返回 `{cwd: null}`。 */
export function apiContext(session: string): Promise<SessionContext> {
  return apiJson(`${PREFIX}/context?session=${encodeURIComponent(session)}`);
}

/** ③ 某文件/会话的改动列表（含 hunks） */
export function apiOps(session: string, file?: string): Promise<OpsPayload> {
  const fileQ = file ? `&file=${encodeURIComponent(file)}` : '';
  return apiJson(`${PREFIX}/ops?session=${encodeURIComponent(session)}${fileQ}`);
}

/**
 * ④ 撤回：带 `opId` + `hunk` 为 hunk 级；不带 `hunk` 为整文件撤回。
 *
 * `opId` 是服务端下发的稳定 uuid（`OpView.id`）。台账下标会随清账/裁剪漂移，
 * 用它定位可能撤错块，所以这里拒绝"没有 opId 的块级撤回"。
 */
export function apiRevert(
  session: string,
  path: string,
  opId?: string | null,
  hunk?: number | null,
): Promise<RevertResult> {
  const body: Record<string, unknown> = { path };
  if (hunk != null) {
    if (!opId) {
      return Promise.reject(new ApiError('该操作记录缺少 opId（服务端未下发），请刷新后重试'));
    }
    body.opId = opId;
    body.hunk = hunk;
  }
  return postJson(`${PREFIX}/revert?session=${encodeURIComponent(session)}`, body);
}

/** 认可一个变更块（确认保留，不再标记/显示差异） */
export function apiAccept(
  session: string,
  path: string,
  opId: string,
  hunk: number,
): Promise<RevertResult> {
  if (!opId) {
    return Promise.reject(new ApiError('该操作记录缺少 opId（服务端未下发），请刷新后重试'));
  }
  return postJson(`${PREFIX}/accept?session=${encodeURIComponent(session)}`, { path, opId, hunk });
}

/** 一键同意：认可该文件当前全部待处理的变更块 */
export function apiAcceptAll(session: string, path: string): Promise<RevertResult> {
  return postJson(`${PREFIX}/accept-all?session=${encodeURIComponent(session)}`, { path });
}

export function apiClear(session: string): Promise<{ ok: boolean }> {
  return postJson(`${PREFIX}/clear?session=${encodeURIComponent(session)}`, {});
}

/** SSE 事件流地址（会话变更提醒；载荷只表示"有变化"，不含 session）。 */
export const EVENTS_URL = `${PREFIX}/events`;
