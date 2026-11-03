// 契约 §2–§7 的 host 侧断言（路由、opId、基线策略、写意图、hunk 定位、落盘）。
//
// 归属说明：本文件里的断言按 `docs/0.3.0-fix-contract.md` 写，实现分属 Lead（routes/security/types）
// 与并行的 host 子代理（service/ledger/hunkRevert）。**实现尚未落地时这些用例会失败**，
// 失败即"等实现"，不是测试写错——报告里逐条标注归属。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ChangeLedger } from '../src/core/ledger.ts';
import { revertHunk as revertHunkCore } from '../src/core/hunkRevert.ts';
import { WsStudioService } from '../src/host/service.ts';
import { registerRoutes } from '../src/host/routes.ts';
import type { FsLike, FsTargetLike, FsInfoLike, FsDirEntryLike, ReqLike, ResLike } from '../src/host/types.ts';

const isWin = process.platform === 'win32';
const ROOT = isWin ? 'C:\\work' : '/work';
const FILE = join(ROOT, 'main.cpp');
const at = (name: string) => join(ROOT, name);
const SESSION = 's1';

// ── 内存文件系统：记录写入参数（写意图/沙箱策略）与删除 ───────────────
class MemFs implements FsLike {
  private readonly nodes = new Map<string, { type: 'file' | 'directory'; content?: string }>();
  lastWrite: { content: string; expected: unknown; policy: unknown } | undefined;
  removed: string[] = [];

  addFile(path: string, content: string): void {
    this.nodes.set(path, { type: 'file', content });
  }
  addDir(path: string): void {
    this.nodes.set(path, { type: 'directory' });
  }
  contentOf(path: string): string | undefined {
    return this.nodes.get(path)?.content;
  }
  exists(path: string): boolean {
    return this.nodes.has(path);
  }
  async resolve(path: string): Promise<FsTargetLike> {
    return { targetKey: path, displayPath: path };
  }
  async stat(target: FsTargetLike): Promise<FsInfoLike | undefined> {
    const n = this.nodes.get(target.targetKey);
    return n ? { type: n.type, version: 1, size: n.content?.length } : undefined;
  }
  async readText(target: FsTargetLike): Promise<string> {
    const n = this.nodes.get(target.targetKey);
    if (!n || n.type !== 'file') throw new Error('ENOENT');
    return n.content ?? '';
  }
  async listDir(target: FsTargetLike): Promise<FsDirEntryLike[]> {
    const out: FsDirEntryLike[] = [];
    for (const [p, n] of this.nodes) {
      if (!p.startsWith(`${target.targetKey}/`) && !p.startsWith(`${target.targetKey}\\`)) continue;
      const rest = p.slice(target.targetKey.length + 1);
      if (rest.includes('/') || rest.includes('\\')) continue;
      out.push({ name: rest, type: n.type, target: { targetKey: p, displayPath: p } });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async writeText(
    target: FsTargetLike,
    content: string,
    expected?: unknown,
    _signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown> {
    this.lastWrite = { content, expected, policy: sandboxPolicy };
    this.nodes.set(target.targetKey, { type: 'file', content });
    return { version: 2 };
  }
  async remove(target: FsTargetLike): Promise<unknown> {
    this.removed.push(target.targetKey);
    this.nodes.delete(target.targetKey);
    return undefined;
  }
}

interface Deps {
  ledger?: ChangeLedger;
  fs?: MemFs;
  allowWrite?: boolean;
  persist?: () => void;
}

function makeService(deps: Deps = {}) {
  const fs = deps.fs ?? new MemFs();
  const ledger = deps.ledger ?? new ChangeLedger();
  const service = new WsStudioService({
    ledger,
    fs,
    maxReadBytes: 10_000,
    sessionCwd: () => ROOT,
    isWriteAllowed: () => deps.allowWrite !== false,
    // 契约 §7：index.ts 注入 scheduleSave；测试里只数调用次数
    persist: deps.persist ?? (() => undefined),
  } as never);
  return { fs, ledger, service };
}

// ── 路由夹具 ────────────────────────────────────────────────────────
interface Route {
  kind: string;
  path: string;
  handler: (req: ReqLike, res: ResLike) => void;
}
interface Res extends ResLike {
  body: string;
  headers: Record<string, string>;
}

function makeRes(): Res {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
    },
  };
}

function makeReq(url: string, body?: unknown, opts: { method?: string; trusted?: boolean } = {}): ReqLike {
  const method = opts.method ?? (body !== undefined ? 'POST' : 'GET');
  const trusted = opts.trusted ?? true;
  const host = '127.0.0.1:3080';
  const headers: Record<string, string> = { host };
  if (trusted) {
    headers['x-dsh-workspace-studio'] = '1';
    headers['sec-fetch-site'] = 'same-origin';
    headers.origin = `http://${host}`;
  }
  const req = { url, method, headers, socket: { remoteAddress: '127.0.0.1' } } as ReqLike;
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

function makeRoutes(deps: Deps = {}) {
  const { service, fs, ledger } = makeService(deps);
  const routes: Route[] = [];
  const dispose = registerRoutes(service, { register: (r) => routes.push(r as Route) }, {
    workspaceRoots: () => [ROOT],
    sessionCwd: () => ROOT,
  });
  const byPath = new Map(routes.map((r) => [r.path, r.handler]));
  return { service, fs, ledger, byPath, dispose };
}

const P = '/api/dsh-workspace-studio';

// ══ §2 路由契约 ═════════════════════════════════════════════════════
test('§2 routes: 敏感路径（.env / *.key / .secrets）读与写一律 403', async () => {
  const h = makeRoutes();
  for (const name of ['.env', 'server.key', join('.secrets', 'token.txt')]) {
    const target = at(name);
    h.fs.addFile(target, 'SECRET=1');
    const res = makeRes();
    await h.byPath.get(`${P}/file`)!(makeReq(`${P}/file?path=${encodeURIComponent(target)}`), res);
    assert.equal(res.statusCode, 403, `${name} 读取必须 403`);
    assert.match(String(JSON.parse(res.body).error), /插件策略拒绝/);

    const write = makeRes();
    h.ledger.add({ sessionId: SESSION, filePath: target, before: 'a', after: 'b', turn: 1 });
    await h.byPath.get(`${P}/revert`)!(
      makeReq(`${P}/revert?session=${SESSION}`, { path: target }),
      write,
    );
    assert.equal(write.statusCode, 403, `${name} 撤回必须 403`);
    assert.equal(h.fs.contentOf(target), 'SECRET=1', '被拒的写请求不得改文件');
  }
});

test('§2 routes: 错误响应统一带 ok:false + error，成功载荷不得出现 ok:false', async () => {
  const h = makeRoutes();
  h.fs.addDir(ROOT);
  h.fs.addFile(FILE, 'x');
  h.ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a', after: 'b', turn: 1 });

  // 成功载荷：/tree 是裸数组（契约 §2 表格），/ops 是 {files}
  const tree = makeRes();
  await h.byPath.get(`${P}/tree`)!(makeReq(`${P}/tree?root=${encodeURIComponent(ROOT)}`), tree);
  assert.equal(tree.statusCode, 200);
  assert.equal(Array.isArray(JSON.parse(tree.body)), true, '/tree 的载荷本身是数组');

  const ops = makeRes();
  await h.byPath.get(`${P}/ops`)!(makeReq(`${P}/ops?session=${SESSION}`), ops);
  const opsPayload = JSON.parse(ops.body);
  assert.notEqual(opsPayload.ok, false, '成功载荷不能带 ok:false');

  // 错误载荷：必须带 ok:false 与可读的 error 字符串
  const denied = makeRes();
  await h.byPath.get(`${P}/revert`)!(
    makeReq(`${P}/revert?session=${SESSION}`, { path: FILE }, { trusted: false }),
    denied,
  );
  assert.equal(denied.statusCode, 403);
  const deniedBody = JSON.parse(denied.body);
  assert.equal(deniedBody.ok, false);
  assert.equal(typeof deniedBody.error, 'string');
  assert.ok(deniedBody.error.length > 0);

  const badParam = makeRes();
  await h.byPath.get(`${P}/tree`)!(makeReq(`${P}/tree`), badParam);
  assert.equal(badParam.statusCode, 400);
  const badBody = JSON.parse(badParam.body);
  assert.equal(badBody.ok, false);
  assert.equal(typeof badBody.error, 'string');
});

test('§2 routes: /ops 不带 file 时只返回允许根内的文件（不整份回吐）', async () => {
  const h = makeRoutes();
  h.ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a', after: 'b', turn: 1 });
  const outside = isWin ? 'C:\\Windows\\system.ini' : '/etc/passwd';
  h.ledger.add({ sessionId: SESSION, filePath: outside, before: 'x', after: 'y', turn: 1 });
  const res = makeRes();
  await h.byPath.get(`${P}/ops`)!(makeReq(`${P}/ops?session=${SESSION}`), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  const paths = payload.files.map((f: { path: string }) => f.path);
  assert.ok(paths.some((p: string) => p.includes('main.cpp')), '允许根内的文件应在列表里');
  assert.equal(
    paths.some((p: string) => p.includes('passwd') || p.includes('system.ini')),
    false,
    '工作区外的文件不得出现',
  );
});

test('§2 routes: /context 取不到会话 cwd 时返回 {cwd:null}', async () => {
  // 这里特意不注入 sessionCwd：取不到就要显式 null，而不是回 {}
  const ledger = new ChangeLedger();
  const service = new WsStudioService({ ledger, fs: new MemFs(), maxReadBytes: 10_000 } as never);
  const routes: Route[] = [];
  registerRoutes(
    service,
    { register: (r) => routes.push(r as Route) },
    { workspaceRoots: () => [ROOT] },
  );
  const res = makeRes();
  await routes.find((r) => r.path === `${P}/context`)!.handler(makeReq(`${P}/context?session=nosuch`), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal('cwd' in payload, true, '必须显式给出 cwd 字段');
  assert.equal(payload.cwd, null, '取不到时要显式给 null，不能回 {}');
  assert.notEqual(payload.ok, false);
});

test('§2 routes: SSE 载荷只表示"有变化"，不再带 session', async () => {
  const h = makeRoutes();
  const res = makeRes();
  h.byPath.get(`${P}/events`)!(makeReq(`${P}/events`), res);
  h.service.notifyChanged(SESSION);
  assert.match(res.body, /"changed":\s*true/, '载荷应为 {"changed":true}');
  assert.equal(/session/i.test(res.body), false, 'SSE 载荷里不应再出现 session');
  h.dispose();
});

// ══ §3 操作身份 opId ════════════════════════════════════════════════
test('§3 opId: 过期/未知 id 返回明确错误', async () => {
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'a\nX\nb');
  ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const r = await service.revertHunk(SESSION, FILE, 'gone-id', 0);
  assert.equal(r.ok, false);
  assert.match(String((r as { error?: string }).error), /已过期|请刷新/, '过期 id 的错误必须可读且指明刷新');
  assert.equal(fs.contentOf(FILE), 'a\nX\nb', '过期 id 不得改写文件');
});

test('§3 opId: 按稳定 id 撤回，同一 hunk 不能撤回两次', async () => {
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'a\nX\nb');
  const op = ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const first = await service.revertHunk(SESSION, FILE, op.id, 0);
  assert.equal(first.ok, true, '按 opId 应能撤回');
  assert.equal(fs.contentOf(FILE), 'a\nb');
  const second = await service.revertHunk(SESSION, FILE, op.id, 0);
  assert.equal(second.ok, false, '重复撤回必须被拒');
  assert.equal(fs.contentOf(FILE), 'a\nb', '重复撤回不得再次改写文件');
});

test('§3 opId: 已撤回的 hunk 不能再认可', async () => {
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'a\nX\nb');
  const op = ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  assert.equal((await service.revertHunk(SESSION, FILE, op.id, 0)).ok, true);
  const r = await service.acceptHunk(SESSION, FILE, op.id, 0);
  assert.equal(r.ok, false);
  assert.match(String((r as { error?: string }).error), /已撤回/);
});

test('§3 routes: 撤回/认可按 opId 定位（不再用下标）', async () => {
  const h = makeRoutes();
  h.fs.addFile(FILE, 'a\nX\nb');
  const op = h.ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const res = makeRes();
  await h.byPath.get(`${P}/revert`)!(makeReq(`${P}/revert?session=${SESSION}`, { path: FILE, opId: op.id, hunk: 0 }), res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(h.fs.contentOf(FILE), 'a\nb');
});

// ══ §4 整文件撤回的基线策略 ═════════════════════════════════════════
test('§4 baseline: 占位快照被跳过，仍能撤回到最早的真实基线', async () => {
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'orig\n2');
  // 第一条是被截断的占位（before/after 置空 + truncated）
  ledger.add({ sessionId: SESSION, filePath: FILE, before: '', after: '', turn: 1, truncated: true });
  ledger.add({ sessionId: SESSION, filePath: FILE, before: 'orig\n2', after: 'orig\nCHANGED', turn: 2 });
  const r = await service.revertFile(SESSION, FILE);
  assert.equal(r.ok, true, String((r as { error?: string }).error ?? ''));
  assert.equal(fs.contentOf(FILE), 'orig\n2', '必须恢复到最早那条带内容快照的 before');
});

test('§4 baseline: 全部是占位 → 拒绝，且不动文件', async () => {
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'current');
  ledger.add({ sessionId: SESSION, filePath: FILE, before: '', after: '', turn: 1, truncated: true });
  const r = await service.revertFile(SESSION, FILE);
  assert.equal(r.ok, false);
  assert.match(String((r as { error?: string }).error), /原始内容快照已被清理|无法安全撤回/);
  assert.equal(fs.contentOf(FILE), 'current');
});

test('§4 baseline: 只有 created===true 才允许删除文件', async () => {
  // created=true → 删除
  {
    const { fs, ledger, service } = makeService();
    fs.addFile(FILE, 'new file');
    ledger.add({ sessionId: SESSION, filePath: FILE, before: null, after: 'new file', turn: 1, created: true });
    const r = await service.revertFile(SESSION, FILE);
    assert.equal(r.ok, true, String((r as { error?: string }).error ?? ''));
    assert.equal(fs.exists(FILE), false, 'created=true 时应删除本次会话新建的文件');
  }
  // created=false（write 的 before:null）→ 拒绝删除
  {
    const { fs, ledger, service } = makeService();
    fs.addFile(FILE, 'existing');
    ledger.add({ sessionId: SESSION, filePath: FILE, before: null, after: 'existing', turn: 1, created: false });
    const r = await service.revertFile(SESSION, FILE);
    assert.equal(r.ok, false);
    assert.equal(fs.exists(FILE), true, '不得把没有基线的 write 当新建文件删掉');
  }
  // created=true 但写入未授权（沙箱根不通过）→ 拒绝删除
  {
    const { fs, ledger, service } = makeService({ allowWrite: false });
    fs.addFile(FILE, 'new file');
    ledger.add({ sessionId: SESSION, filePath: FILE, before: null, after: 'new file', turn: 1, created: true });
    const r = await service.revertFile(SESSION, FILE);
    assert.equal(r.ok, false);
    assert.equal(fs.exists(FILE), true, '删除前必须先在沙箱根内校验通过');
  }
});

test('§4 baseline: 撤回成功后按 canonicalPath 清账（不同写法也算同一文件）', async () => {
  const stored = isWin ? 'C:\\Work\\Main.cpp' : '/work/main.cpp';
  const query = isWin ? 'c:/work/main.cpp' : '/work//main.cpp';
  const { fs, ledger, service } = makeService();
  fs.addFile(query, 'a');
  ledger.add({ sessionId: SESSION, filePath: stored, before: 'orig', after: 'a', turn: 1 });
  const r = await service.revertFile(SESSION, query);
  assert.equal(r.ok, true, String((r as { error?: string }).error ?? ''));
  assert.equal(fs.contentOf(query), 'orig');
  assert.equal(ledger.all().length, 0, '清账必须用 canonical 口径匹配到原记录');
});

// ══ §5 写到宿主的契约 ═══════════════════════════════════════════════
test('§5 write intent: 传给 writeText 的 expected 是 {kind:"replaceIfVersion"} 对象', async () => {
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'a\nX\nb');
  ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const r = await service.revertFile(SESSION, FILE);
  assert.equal(r.ok, true, String((r as { error?: string }).error ?? ''));
  assert.deepEqual(fs.lastWrite?.expected, { kind: 'replaceIfVersion', version: 1 });
  // 沙箱策略仍要带 workspace-write + 会话根
  assert.deepEqual(fs.lastWrite?.policy, { mode: 'workspace-write', workspaceRoot: ROOT });
});

test('§5 write intent: hunk 级撤回同样带写意图', async () => {
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'a\nX\nb');
  const op = ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const r = await service.revertHunk(SESSION, FILE, op.id, 0);
  assert.equal(r.ok, true, String((r as { error?: string }).error ?? ''));
  assert.deepEqual(fs.lastWrite?.expected, { kind: 'replaceIfVersion', version: 1 });
});

// ══ §6 hunk 定位：绝不猜测 ══════════════════════════════════════════
test('§6 hunkRevert: 目标位置上下文不符 + 全文多处同内容 → 拒绝', () => {
  const before = ['h1', 'h2', 'h3', 'h4', 'h5', 'B', 'C'].join('\n');
  const after = ['h1', 'h2', 'h3', 'h4', 'h5', 'B', 'X', 'C'].join('\n');
  // 提示位置（第 6–7 行附近）已被改坏；同样内容在后面出现两次
  const current = ['h1', 'h2', 'h3', 'h4', 'h5', 'CHANGED', 'C', 'zz', 'B', 'X', 'C', 'zz2', 'B', 'X', 'C'];
  const r = revertHunkCore(current, before, after, 0);
  assert.equal(r.ok, false, '多处同内容时不得猜测位置');
  assert.match(String((r as { reason?: string }).reason), /无法唯一确定该变更块的位置/);
});

test('§6 hunkRevert: 上下文不符且全文找不到 → 拒绝', () => {
  const before = ['h1', 'h2', 'h3', 'B', 'C'].join('\n');
  const after = ['h1', 'h2', 'h3', 'B', 'X', 'C'].join('\n');
  const current = ['h1', 'h2', 'h3', 'ZZZ', 'C'];
  const r = revertHunkCore(current, before, after, 0);
  assert.equal(r.ok, false);
});

// ══ §7 台账：用户动作必须落盘 + 截断标记 ════════════════════════════
test('§7 persist: 撤回/认可/整文件撤回/清空成功后都要落盘', async () => {
  let saved = 0;
  const persist = () => {
    saved += 1;
  };
  // revertHunk
  {
    const { fs, ledger, service } = makeService({ persist });
    fs.addFile(FILE, 'a\nX\nb');
    const op = ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
    saved = 0;
    assert.equal((await service.revertHunk(SESSION, FILE, op.id, 0)).ok, true);
    assert.equal(saved, 1, 'revertHunk 成功后必须 persist');
  }
  // acceptHunk
  {
    const { fs, ledger, service } = makeService({ persist });
    fs.addFile(FILE, 'a\nX\nb');
    const op = ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
    saved = 0;
    assert.equal((await service.acceptHunk(SESSION, FILE, op.id, 0)).ok, true);
    assert.equal(saved, 1, 'acceptHunk 成功后必须 persist');
  }
  // acceptAllHunks
  {
    const { fs, ledger, service } = makeService({ persist });
    fs.addFile(FILE, 'a\nX\nb');
    ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
    saved = 0;
    assert.equal((await service.acceptAllHunks(SESSION, FILE)).ok, true);
    assert.equal(saved, 1, 'acceptAllHunks 成功后必须 persist');
  }
  // revertFile
  {
    const { fs, ledger, service } = makeService({ persist });
    fs.addFile(FILE, 'a\nX\nb');
    ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
    saved = 0;
    assert.equal((await service.revertFile(SESSION, FILE)).ok, true);
    assert.equal(saved, 1, 'revertFile 成功后必须 persist');
  }
  // clearSession
  {
    const { ledger, service } = makeService({ persist });
    ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a', after: 'b', turn: 1 });
    saved = 0;
    service.clearSession(SESSION);
    assert.equal(saved, 1, 'clearSession 成功后必须 persist');
  }
});

test('§7 ledger: 超大快照置 truncated=true，与空文件区分', () => {
  const ledger = new ChangeLedger();
  const big = 'x'.repeat(200 * 1024);
  const truncated = ledger.add({ sessionId: SESSION, filePath: FILE, before: big, after: 'small', turn: 1 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.before, '');
  assert.equal(truncated.after, '');

  const empty = ledger.add({ sessionId: SESSION, filePath: at('empty.txt'), before: '', after: '', turn: 1 });
  assert.equal(empty.truncated, undefined, '空文件不能被标记成"快照过大"');
});

// ══ 客户端 / 服务端的载荷契约对接 ════════════════════════════════════
test('§3+§8 对接: 服务端下发的 /ops 载荷能被客户端的形状校验接受，且带 id', async () => {
  const { isOpsPayload, opIdOf } = await import('../src/client/view.ts');
  const { fs, ledger, service } = makeService();
  fs.addFile(FILE, 'a\nX\nb');
  const op = ledger.add({ sessionId: SESSION, filePath: FILE, before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const payload = service.opsFor(SESSION, FILE);
  assert.equal(isOpsPayload(payload), true, '客户端形状校验必须接受服务端真实载荷');
  assert.equal(opIdOf(payload.files[0].ops[0]), op.id, '下发 id 必须就是台账里的稳定 id');
  // 未处理的 hunk 上，客户端拿到的 opId 可直接用于撤回
  const r = await service.revertHunk(SESSION, FILE, opIdOf(payload.files[0].ops[0]) as string, 0);
  assert.equal(r.ok, true, String((r as { error?: string }).error ?? ''));
});
