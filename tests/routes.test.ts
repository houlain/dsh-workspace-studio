import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeLedger } from '../src/core/ledger.ts';
import { WsStudioService } from '../src/host/service.ts';
import { registerRoutes } from '../src/host/routes.ts';
import { isPathInsideWorkspace } from '../src/host/security.ts';
import type { FsLike, FsTargetLike, FsInfoLike, FsDirEntryLike, ReqLike, ResLike } from '../src/host/types.ts';

class MemFs implements FsLike {
  private readonly nodes = new Map<string, { type: 'file' | 'directory'; content?: string }>();
  addFile(p: string, c: string): void {
    this.nodes.set(p, { type: 'file', content: c });
  }
  addDir(p: string): void {
    this.nodes.set(p, { type: 'directory' });
  }
  contentOf(p: string): string | undefined {
    return this.nodes.get(p)?.content;
  }
  async resolve(path: string): Promise<FsTargetLike> {
    return { targetKey: path, displayPath: path };
  }
  async stat(t: FsTargetLike): Promise<FsInfoLike | undefined> {
    const n = this.nodes.get(t.targetKey);
    return n ? { type: n.type, version: 1, size: n.content?.length } : undefined;
  }
  async readText(t: FsTargetLike): Promise<string> {
    const n = this.nodes.get(t.targetKey);
    if (!n || n.type !== 'file') throw new Error('ENOENT');
    return n.content ?? '';
  }
  async listDir(t: FsTargetLike): Promise<FsDirEntryLike[]> {
    const out: FsDirEntryLike[] = [];
    for (const [p, n] of this.nodes) {
      if (!p.startsWith(`${t.targetKey}/`)) continue;
      const rest = p.slice(t.targetKey.length + 1);
      if (rest.includes('/')) continue;
      out.push({ name: rest, type: n.type, target: { targetKey: p, displayPath: p } });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async writeText(t: FsTargetLike, content: string): Promise<unknown> {
    this.nodes.set(t.targetKey, { type: 'file', content });
    return { version: 2 };
  }
  async remove(t: FsTargetLike): Promise<unknown> {
    this.nodes.delete(t.targetKey);
    return undefined;
  }
  async unlink(t: FsTargetLike): Promise<unknown> {
    this.nodes.delete(t.targetKey);
    return undefined;
  }
}

interface Route {
  kind: string;
  path: string;
  handler: (req: ReqLike, res: ResLike) => void;
}

function makeHarness() {
  const fs = new MemFs();
  const ledger = new ChangeLedger();
  const service = new WsStudioService({
    ledger,
    fs,
    maxReadBytes: 1000,
    sessionCwd: () => '/work',
    isWriteAllowed: (p) => isPathInsideWorkspace(p, ['/work']),
  });
  const routes: Route[] = [];
  registerRoutes(service, { register: (r) => routes.push(r as Route) }, {
    workspaceRoots: () => ['/work'],
    sessionCwd: () => '/work',
  });
  const byPath = new Map(routes.map((r) => [r.path, r.handler]));
  return { fs, ledger, service, byPath };
}

function makeRes(): ResLike & { body: string; headers: Record<string, string> } {
  const res: ResLike & { body: string; headers: Record<string, string> } = {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      return undefined;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return undefined;
    },
    write(chunk) {
      this.body += chunk;
      return undefined;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      return undefined;
    },
  };
  return res;
}

function makeReq(
  url: string,
  body?: unknown,
  opts: { method?: string; trusted?: boolean } = {},
): ReqLike {
  const method = opts.method ?? (body !== undefined ? 'POST' : 'GET');
  const trusted = opts.trusted ?? true;
  const host = '127.0.0.1:3080';
  const headers: Record<string, string> = { host };
  if (trusted) {
    headers['x-dsh-workspace-studio'] = '1';
    headers['sec-fetch-site'] = 'same-origin';
    headers.origin = `http://${host}`;
  }
  const req: ReqLike = { url, method, headers, socket: { remoteAddress: '127.0.0.1' } };
  if (body !== undefined) {
    const json = JSON.stringify(body);
    req.on = (ev, cb) => {
      if (ev === 'data') cb(json);
      if (ev === 'end') cb();
    };
  } else {
    req.on = () => undefined;
  }
  return req;
}

const FILE = '/work/main.cpp';

test('routes: /api/dsh-workspace-studio/tree 返回文件树 JSON', async () => {
  const h = makeHarness();
  h.fs.addDir('/work');
  h.fs.addFile(`${FILE}`, 'x');
  h.fs.addDir('/work/node_modules');
  const res = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/tree')!(makeReq('/api/dsh-workspace-studio/tree?root=/work'), res);
  assert.equal(res.statusCode, 200);
  const tree = JSON.parse(res.body);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'main.cpp');
});

test('routes: /api/dsh-workspace-studio/file 返回内容 / 缺失返回 400', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'hello');
  const ok = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/file')!(makeReq(`/api/dsh-workspace-studio/file?path=${FILE}`), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).content, 'hello');
  const bad = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/file')!(makeReq('/api/dsh-workspace-studio/file?path=/work/nope'), bad);
  assert.equal(bad.statusCode, 400);
});

test('routes: /api/dsh-workspace-studio/ops 返回带 hunks 的视图', async () => {
  const h = makeHarness();
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const res = makeRes();
  h.byPath.get('/api/dsh-workspace-studio/ops')!(makeReq('/api/dsh-workspace-studio/ops?session=s1'), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.files[0].path, FILE);
  assert.equal(payload.files[0].ops[0].hunks.length, 1);
});

test('routes: /api/dsh-workspace-studio/revert POST hunk → 200 且文件已改', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nX\nb');
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const res = makeRes();
  const req = makeReq('/api/dsh-workspace-studio/revert?session=s1', { path: FILE, op: 0, hunk: 0 });
  await h.byPath.get('/api/dsh-workspace-studio/revert')!(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(h.fs.contentOf(FILE), 'a\nb');
});

test('routes: /api/dsh-workspace-studio/revert POST 冲突 → 400', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nY\nb'); // X 被改
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const res = makeRes();
  const req = makeReq('/api/dsh-workspace-studio/revert?session=s1', { path: FILE, op: 0, hunk: 0 });
  await h.byPath.get('/api/dsh-workspace-studio/revert')!(req, res);
  assert.equal(res.statusCode, 400);
});

test('routes: /api/dsh-workspace-studio/revert POST 不带 hunk → 整文件撤回', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nX\nb');
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const res = makeRes();
  const req = makeReq('/api/dsh-workspace-studio/revert?session=s1', { path: FILE });
  await h.byPath.get('/api/dsh-workspace-studio/revert')!(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(h.fs.contentOf(FILE), 'a\nb');
});

test('routes: /api/dsh-workspace-studio/events SSE 注册 + 变更广播', async () => {
  const h = makeHarness();
  const res = makeRes();
  const handler = h.byPath.get('/api/dsh-workspace-studio/events')!;
  handler(makeReq('/api/dsh-workspace-studio/events'), res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.match(res.body, /retry: 3000/);
  h.service.notifyChanged('s1');
  // 契约 §2：载荷只表示"有变化"，不再回传 sessionId（客户端自己刷新当前会话）
  assert.match(res.body, /data: \{"changed":true\}/);
});

test('routes: /api/dsh-workspace-studio/context 返回会话 cwd', async () => {
  const h = makeHarness();
  // 给 service 注入 sessionCwd
  const svc = new WsStudioService({
    ledger: h.ledger,
    fs: h.fs,
    sessionCwd: (sid) => (sid === 's1' ? '/work' : undefined),
  });
  const routes2: Route[] = [];
  registerRoutes(svc, { register: (r) => routes2.push(r as Route) }, {
    workspaceRoots: () => ['/work'],
    sessionCwd: (sid) => (sid === 's1' ? '/work' : undefined),
  });
  const res = makeRes();
  await routes2.find((r) => r.path === '/api/dsh-workspace-studio/context')!.handler(makeReq('/api/dsh-workspace-studio/context?session=s1'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).cwd, '/work');
});

test('routes: /api/dsh-workspace-studio/clear 清空会话', async () => {
  const h = makeHarness();
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a', after: 'b', turn: 1 });
  const res = makeRes();
  h.byPath.get('/api/dsh-workspace-studio/clear')!(
    makeReq('/api/dsh-workspace-studio/clear?session=s1', undefined, { method: 'POST' }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(h.ledger.all().length, 0);
});

// ── 安全边界：写操作信任判定 + 工作区路径授权 ────────────────────────

test('routes.security: 缺少信任头的撤回请求 → 403 且不动文件', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nX\nb');
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const res = makeRes();
  const req = makeReq(
    '/api/dsh-workspace-studio/revert?session=s1',
    { path: FILE, op: 0, hunk: 0 },
    { trusted: false },
  );
  await h.byPath.get('/api/dsh-workspace-studio/revert')!(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(h.fs.contentOf(FILE), 'a\nX\nb', '被拒的请求不得改写文件');
});

test('routes.security: 跨站 Origin 即使带信任头也 → 403', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nX\nb');
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const req = makeReq('/api/dsh-workspace-studio/revert?session=s1', { path: FILE });
  req.headers = { ...(req.headers ?? {}), origin: 'http://evil.example' };
  const res = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/revert')!(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(h.fs.contentOf(FILE), 'a\nX\nb');
});

test('routes.security: 非回环对端地址 → 403', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nX\nb');
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const req = makeReq('/api/dsh-workspace-studio/revert?session=s1', { path: FILE });
  req.socket = { remoteAddress: '10.0.0.9' };
  const res = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/revert')!(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(h.fs.contentOf(FILE), 'a\nX\nb');
});

test('routes.security: 工作区之外的 root 读取 → 403，路径穿越同样被拒', async () => {
  const h = makeHarness();
  const outside = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/tree')!(
    makeReq('/api/dsh-workspace-studio/tree?root=/etc'),
    outside,
  );
  assert.equal(outside.statusCode, 403);

  const traversal = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/tree')!(
    makeReq('/api/dsh-workspace-studio/tree?root=/work/../etc'),
    traversal,
  );
  assert.equal(traversal.statusCode, 403, '../ 归一化后落在工作区外，必须拒绝');
});

test('routes.security: 工作区之外的 file 读取 → 403', async () => {
  const h = makeHarness();
  const res = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/file')!(
    makeReq('/api/dsh-workspace-studio/file?path=/etc/passwd'),
    res,
  );
  assert.equal(res.statusCode, 403);
});

test('routes.security: 写操作必须是 POST（GET → 405）', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nX\nb');
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const res = makeRes();
  const req = makeReq('/api/dsh-workspace-studio/revert?session=s1', { path: FILE }, { method: 'GET' });
  await h.byPath.get('/api/dsh-workspace-studio/revert')!(req, res);
  assert.equal(res.statusCode, 405);
  assert.equal(h.fs.contentOf(FILE), 'a\nX\nb');
});

test('routes.security: 清空台账同样要求信任请求', async () => {
  const h = makeHarness();
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a', after: 'b', turn: 1 });
  const res = makeRes();
  h.byPath.get('/api/dsh-workspace-studio/clear')!(
    makeReq('/api/dsh-workspace-studio/clear?session=s1', undefined, { method: 'POST', trusted: false }),
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.equal(h.ledger.all().length, 1, '未信任的清空请求不得删除记录');
});

test('routes: /api/dsh-workspace-studio/accept-all 需要信任请求，且能一次认可', async () => {
  const h = makeHarness();
  h.fs.addFile(FILE, 'a\nX\nb');
  h.ledger.add({ sessionId: 's1', filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });

  const denied = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/accept-all')!(
    makeReq('/api/dsh-workspace-studio/accept-all?session=s1', { path: FILE }, { trusted: false }),
    denied,
  );
  assert.equal(denied.statusCode, 403);

  const ok = makeRes();
  await h.byPath.get('/api/dsh-workspace-studio/accept-all')!(
    makeReq('/api/dsh-workspace-studio/accept-all?session=s1', { path: FILE }),
    ok,
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
});
