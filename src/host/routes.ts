// HTTP + SSE 路由层（契约 docs/0.3.0-fix-contract.md §2/§3）。
//
// 红队裁决后的四处收紧：
// 1) 读接口也要信任标头（挡跨站页面/DNS rebinding；挡不住本机进程，README 如实写）；
// 2) 敏感路径（.secrets/.env/*.key/... 与 ~/.dsh）读写一律 403；
// 3) /ops 不带 file 时逐条过滤，只回允许根内的文件（不再整份回吐台账）；
// 4) /events 载荷去掉 sessionId（EventSource 带不了自定义头），只通知"有变化"。

import type { WsStudioService } from './service.ts';
import type { ReqLike, ResLike, WebRouteLike, WebServerLike } from './types.ts';
import { isPathInsideWorkspace, isSensitivePath, isTrustedRequest } from './security.ts';

export const ROUTE_PREFIX = '/api/dsh-workspace-studio';

export interface RouteOptions {
  /** 已注册工作区的绝对路径；每次请求时现取。 */
  workspaceRoots: () => string[];
  /** 某会话的工作目录。 */
  sessionCwd?: (sessionId: string) => string | undefined;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SSE_CLIENTS = 32;
const SSE_KEEPALIVE_MS = 25_000;

function sendJson(res: ResLike, status: number, body: unknown): void {
  res.statusCode = status;
  if (res.setHeader) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function queryParam(req: ReqLike, key: string): string {
  return new URL(req.url, 'http://localhost').searchParams.get(key) ?? '';
}

function errorMessage(e: unknown): string {
  return String((e as Error).message ?? e);
}

function destroyRequest(req: ReqLike): void {
  try {
    (req as unknown as { destroy?: () => void }).destroy?.();
  } catch {
    // 忽略
  }
}

function collectJsonBody(req: ReqLike): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!req.on) return resolve({});
    const declared = Number(req.headers?.['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      destroyRequest(req);
      reject(new Error('请求体过大'));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    req.on('data', (chunk: unknown) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      bytes += buf.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        destroyRequest(req);
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (aborted) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data) return resolve({});
      try {
        const parsed = JSON.parse(data) as unknown;
        resolve(parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error('请求体不是有效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function mount(webServer: WebServerLike, disposers: Array<() => void>, route: WebRouteLike): void {
  try {
    const d = webServer.register(route);
    if (typeof d === 'function') disposers.push(d as () => void);
  } catch (err) {
    console.error(`ws-studio: 路由 ${route.path} 注册失败`, err);
  }
}

export function registerRoutes(
  service: WsStudioService,
  webServer: WebServerLike,
  options: RouteOptions,
): () => void {
  const clients = new Set<ResLike>();
  const disposers: Array<() => void> = [];

  /** 本次请求允许的根：已注册工作区 + 会话 cwd。 */
  const rootsFor = (sessionId?: string): string[] => {
    const roots = new Set<string>();
    try {
      for (const p of options.workspaceRoots()) if (typeof p === 'string' && p !== '') roots.add(p);
    } catch {
      // 注册表不可读时仅用会话 cwd
    }
    if (sessionId) {
      try {
        const cwd = options.sessionCwd?.(sessionId);
        if (cwd) roots.add(cwd);
      } catch {
        // 忽略
      }
    }
    return [...roots];
  };

  /** 路径是否可访问：在允许根内，且不命中敏感名单。 */
  const pathAllowed = (path: string, sessionId?: string): { ok: true } | { ok: false; error: string } => {
    if (isSensitivePath(path)) return { ok: false, error: '该路径被插件策略拒绝（敏感文件）' };
    if (!isPathInsideWorkspace(path, rootsFor(sessionId))) {
      return { ok: false, error: '该路径不在已注册的工作区内' };
    }
    return { ok: true };
  };

  const denied = (res: ResLike, r: { ok: false; error: string }): void => {
    sendJson(res, 403, { ok: false, error: r.error });
  };

  // 服务变更 → SSE 广播（载荷不含 sessionId）
  const offChanged = service.onChanged(() => {
    const payload = 'data: {"changed":true}\n\n';
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  });

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/events`,
    handler: (req: ReqLike, res: ResLike) => {
      if (clients.size >= MAX_SSE_CLIENTS) {
        return sendJson(res, 503, { ok: false, error: 'SSE 连接数已达上限' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const drop = (): void => {
        clients.delete(res);
      };
      req.on?.('close', drop);
      const resOn = (res as unknown as { on?: (e: string, cb: () => void) => void }).on;
      if (typeof resOn === 'function') {
        resOn.call(res, 'close', drop);
        resOn.call(res, 'error', drop);
      }
    },
  });

  const keepalive = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, SSE_KEEPALIVE_MS);
  (keepalive as unknown as { unref?: () => void }).unref?.();

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/tree`,
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        const root = queryParam(req, 'root');
        const session = queryParam(req, 'session') || undefined;
        if (!root) return sendJson(res, 400, { ok: false, error: '缺少 root 参数' });
        const allow = pathAllowed(root, session);
        if (allow.ok !== true) return denied(res, allow as { ok: false; error: string });
        sendJson(res, 200, await service.tree(root));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/file`,
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        const path = queryParam(req, 'path');
        const session = queryParam(req, 'session') || undefined;
        if (!path) return sendJson(res, 400, { ok: false, error: '缺少 path 参数' });
        const allow = pathAllowed(path, session);
        if (allow.ok !== true) return denied(res, allow as { ok: false; error: string });
        const r = await service.readFileText(path);
        sendJson(res, r.ok ? 200 : 400, r);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/context`,
    handler: (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        const sessionId = queryParam(req, 'session');
        if (!sessionId) return sendJson(res, 400, { ok: false, error: '缺少 session 参数' });
        sendJson(res, 200, service.sessionContext(sessionId));
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `会话上下文读取失败：${errorMessage(e)}` });
      }
    },
  });

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/ops`,
    handler: (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        const sessionId = queryParam(req, 'session');
        if (!sessionId) return sendJson(res, 400, { ok: false, error: '缺少 session 参数' });
        const file = queryParam(req, 'file') || undefined;
        if (file) {
          const allow = pathAllowed(file, sessionId);
          if (allow.ok !== true) return denied(res, allow as { ok: false; error: string });
          return sendJson(res, 200, service.opsFor(sessionId, file));
        }
        // 不带 file：逐条过滤，只回允许根内、且非敏感路径的文件
        const payload = service.opsFor(sessionId);
        const files = payload.files.filter((f) => pathAllowed(f.path, sessionId).ok === true);
        sendJson(res, 200, { files });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `改动记录读取失败：${errorMessage(e)}` });
      }
    },
  });

  /** 从请求体解析操作定位：优先 opId，兼容旧客户端的数值下标。 */
  const resolveOpId = (body: Record<string, unknown>, sessionId: string, filePath: string): string | undefined => {
    if (typeof body.opId === 'string' && body.opId !== '') return body.opId;
    if (typeof body.op === 'number') {
      const view = service.opsFor(sessionId, filePath);
      const op = view.files[0]?.ops[body.op];
      if (op && typeof op.id === 'string') return op.id;
    }
    return undefined;
  };

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/revert`,
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        if (req.method !== undefined && req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
        }
        const body = await collectJsonBody(req);
        const sessionId = queryParam(req, 'session');
        const filePath = typeof body.path === 'string' ? body.path : '';
        if (!sessionId || !filePath) {
          return sendJson(res, 400, { ok: false, error: '缺少 session 或 path 参数' });
        }
        const allow = pathAllowed(filePath, sessionId);
        if (allow.ok !== true) return denied(res, allow as { ok: false; error: string });

        if (typeof body.hunk === 'number') {
          const opId = resolveOpId(body, sessionId, filePath);
          if (!opId) {
            return sendJson(res, 400, { ok: false, error: '缺少 opId（或 opId 已过期），请刷新后重试' });
          }
          const result = await service.revertHunk(sessionId, filePath, opId, body.hunk);
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        const result = await service.revertFile(sessionId, filePath);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/accept`,
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        if (req.method !== undefined && req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
        }
        const body = await collectJsonBody(req);
        const sessionId = queryParam(req, 'session');
        const filePath = typeof body.path === 'string' ? body.path : '';
        if (!sessionId || !filePath || typeof body.hunk !== 'number') {
          return sendJson(res, 400, { ok: false, error: '缺少 session/path/hunk 参数' });
        }
        const allow = pathAllowed(filePath, sessionId);
        if (allow.ok !== true) return denied(res, allow as { ok: false; error: string });
        const opId = resolveOpId(body, sessionId, filePath);
        if (!opId) {
          return sendJson(res, 400, { ok: false, error: '缺少 opId（或 opId 已过期），请刷新后重试' });
        }
        const result = await service.acceptHunk(sessionId, filePath, opId, body.hunk);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/accept-all`,
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        if (req.method !== undefined && req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
        }
        const body = await collectJsonBody(req);
        const sessionId = queryParam(req, 'session');
        const filePath = typeof body.path === 'string' ? body.path : '';
        if (!sessionId || !filePath) {
          return sendJson(res, 400, { ok: false, error: '缺少 session 或 path 参数' });
        }
        const allow = pathAllowed(filePath, sessionId);
        if (allow.ok !== true) return denied(res, allow as { ok: false; error: string });
        const result = await service.acceptAllHunks(sessionId, filePath);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  mount(webServer, disposers, {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/clear`,
    handler: (req: ReqLike, res: ResLike) => {
      try {
        if (!isTrustedRequest(req)) return sendJson(res, 403, { ok: false, error: '请求未被信任' });
        if (req.method !== undefined && req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
        }
        const sessionId = queryParam(req, 'session');
        if (!sessionId) return sendJson(res, 400, { ok: false, error: '缺少 session 参数' });
        service.clearSession(sessionId);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `清空失败：${errorMessage(e)}` });
      }
    },
  });

  return () => {
    clearInterval(keepalive);
    for (const res of clients) {
      try {
        (res as unknown as { end?: () => void }).end?.();
      } catch {
        // 忽略
      }
      try {
        (res as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        // 忽略
      }
    }
    clients.clear();
    for (const d of disposers) {
      try {
        d();
      } catch {
        // 单条释放失败不影响其余
      }
    }
    try {
      offChanged();
    } catch {
      // 忽略
    }
  };
}
