// HTTP + SSE 路由层：浏览器半侧通过这些路由访问服务。
// 全部依赖注入（service + webServer），可在纯 Node 环境测试。

import type { WsStudioService } from './service.ts';
import type { ReqLike, ResLike, WebServerLike } from './types.ts';

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

/** 收集 JSON 请求体（上限 1MB）。 */
function readJsonBody(req: ReqLike): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!req.on) return resolve({});
    let data = '';
    let tooBig = false;
    req.on('data', (chunk: unknown) => {
      if (tooBig) return;
      data += String(chunk);
      if (data.length > 1e6) {
        tooBig = true;
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('请求体不是有效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function registerRoutes(service: WsStudioService, webServer: WebServerLike): void {
  const clients = new Set<ResLike>();

  // 服务变更 → SSE 广播
  service.onChanged((sessionId) => {
    const payload = `data: ${JSON.stringify({ session: sessionId })}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/events',
    handler: (req: ReqLike, res: ResLike) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on?.('close', () => clients.delete(res));
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/tree',
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        const root = queryParam(req, 'root');
        if (!root) return sendJson(res, 400, { ok: false, error: '缺少 root 参数' });
        sendJson(res, 200, await service.tree(root));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/file',
    handler: async (req: ReqLike, res: ResLike) => {
      const path = queryParam(req, 'path');
      if (!path) return sendJson(res, 400, { ok: false, error: '缺少 path 参数' });
      const r = await service.readFileText(path);
      sendJson(res, r.ok ? 200 : 400, r);
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/context',
    handler: (req: ReqLike, res: ResLike) => {
      const sessionId = queryParam(req, 'session');
      if (!sessionId) return sendJson(res, 400, { ok: false, error: '缺少 session 参数' });
      sendJson(res, 200, service.sessionContext(sessionId));
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/ops',
    handler: (req: ReqLike, res: ResLike) => {
      const sessionId = queryParam(req, 'session');
      const file = queryParam(req, 'file') || undefined;
      sendJson(res, 200, service.opsFor(sessionId, file));
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/revert',
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        const body = await readJsonBody(req);
        const sessionId = queryParam(req, 'session');
        const filePath = typeof body.path === 'string' ? body.path : '';
        if (!sessionId || !filePath) {
          return sendJson(res, 400, { ok: false, error: '缺少 session 或 path 参数' });
        }
        const op = body.op;
        const hunk = body.hunk;
        let result;
        if (typeof op === 'number' && typeof hunk === 'number') {
          result = await service.revertHunk(sessionId, filePath, op, hunk);
        } else {
          result = await service.revertFile(sessionId, filePath);
        }
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/accept',
    handler: async (req: ReqLike, res: ResLike) => {
      try {
        const body = await readJsonBody(req);
        const sessionId = queryParam(req, 'session');
        const filePath = typeof body.path === 'string' ? body.path : '';
        const op = body.op;
        const hunk = body.hunk;
        if (!sessionId || !filePath || typeof op !== 'number' || typeof hunk !== 'number') {
          return sendJson(res, 400, { ok: false, error: '缺少 session/path/op/hunk 参数' });
        }
        const result = await service.acceptHunk(sessionId, filePath, op, hunk);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: errorMessage(e) });
      }
    },
  });

  webServer.register({
    kind: 'exact',
    path: '/ws-studio/clear',
    handler: (req: ReqLike, res: ResLike) => {
      const sessionId = queryParam(req, 'session');
      if (!sessionId) return sendJson(res, 400, { ok: false, error: '缺少 session 参数' });
      service.clearSession(sessionId);
      sendJson(res, 200, { ok: true });
    },
  });
}
