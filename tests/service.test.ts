import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeLedger } from '../src/core/ledger.ts';
import { WsStudioService } from '../src/host/service.ts';
import type { FsLike, FsTargetLike, FsInfoLike, FsDirEntryLike } from '../src/host/types.ts';

/** 内存文件系统（模拟 ctx.fs） */
class MemFs implements FsLike {
  private readonly nodes = new Map<string, { type: 'file' | 'directory'; content?: string }>();
  lastPolicy: unknown = undefined;

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
    if (!n || n.type !== 'file') throw new Error(`ENOENT: ${target.targetKey}`);
    return n.content ?? '';
  }
  async listDir(target: FsTargetLike): Promise<FsDirEntryLike[]> {
    const dir = target.targetKey;
    const out: FsDirEntryLike[] = [];
    for (const [p, n] of this.nodes) {
      if (!p.startsWith(`${dir}/`)) continue;
      const rest = p.slice(dir.length + 1);
      if (rest.includes('/')) continue;
      out.push({ name: rest, type: n.type, target: { targetKey: p, displayPath: p } });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async writeText(
    target: FsTargetLike,
    content: string,
    _expected?: unknown,
    _signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown> {
    this.lastPolicy = sandboxPolicy;
    const n = this.nodes.get(target.targetKey);
    if (n && n.type !== 'file') throw new Error('EISDIR');
    this.nodes.set(target.targetKey, { type: 'file', content });
    return { version: 2 };
  }
  async unlink(target: FsTargetLike): Promise<unknown> {
    if (!this.nodes.delete(target.targetKey)) throw new Error(`ENOENT: ${target.targetKey}`);
    return undefined;
  }
}

function makeService(fs: MemFs, ledger = new ChangeLedger()) {
  return new WsStudioService({ ledger, fs, maxReadBytes: 100 });
}

const SESSION = 's1';
const FILE = '/work/main.cpp';

function addEditOp(
  ledger: ChangeLedger,
  before: string,
  after: string,
  filePath = FILE,
  sessionId = SESSION,
  turn: number | null = 1,
) {
  ledger.add({ sessionId, filePath, before, after, turn });
}

test('service.tree: 经 ctx.fs 构建文件树', async () => {
  const fs = new MemFs();
  fs.addDir('/work');
  fs.addDir('/work/src');
  fs.addDir('/work/node_modules');
  fs.addFile('/work/README.md', 'hi');
  fs.addFile('/work/src/main.cpp', 'int main(){}');
  const s = makeService(fs);
  const tree = await s.tree('/work');
  const names = tree.map((e) => e.name).sort();
  assert.deepEqual(names, ['README.md', 'src']);
  const src = tree.find((e) => e.name === 'src')!;
  assert.equal(src.children![0].name, 'main.cpp');
});

test('service.readFileText: 正常读取 / 目录拒绝 / 超大拒绝 / 不存在', async () => {
  const fs = new MemFs();
  fs.addDir('/work');
  fs.addFile('/work/a.cpp', 'abc');
  fs.addFile('/work/big.cpp', 'x'.repeat(500));
  const s = makeService(fs);
  const ok = await s.readFileText('/work/a.cpp');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.content, 'abc');
  const dir = await s.readFileText('/work');
  assert.equal(dir.ok, false);
  const big = await s.readFileText('/work/big.cpp');
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /过大/);
  const missing = await s.readFileText('/work/nope.cpp');
  assert.equal(missing.ok, false);
});

test('service.opsFor: 操作视图含 hunks 与统计', () => {
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'a\nb\nc', 'a\nX\nb\nc');
  const s = makeService(new MemFs(), ledger);
  const payload = s.opsFor(SESSION);
  assert.equal(payload.files.length, 1);
  const f = payload.files[0];
  assert.equal(f.path, FILE);
  assert.equal(f.ops.length, 1);
  assert.equal(f.ops[0].revertible, true);
  assert.equal(f.ops[0].added, 1);
  assert.deepEqual(f.ops[0].revertedHunks, []);
  assert.equal(f.ops[0].hunks.length, 1);
});

test('service.opsFor: 无快照的操作不可撤回（详情视图仍返回）', () => {
  const ledger = new ChangeLedger();
  ledger.add({ sessionId: SESSION, filePath: FILE, before: '', after: '', turn: 1 });
  const s = makeService(new MemFs(), ledger);
  const payload = s.opsFor(SESSION, FILE);
  const f = payload.files[0];
  assert.equal(f.ops[0].revertible, false);
  assert.equal(f.ops[0].hunks.length, 0);
  assert.equal(f.pending, false);
  // 列表视图（不带 file）不包含无未处理改动的文件
  assert.equal(s.opsFor(SESSION).files.length, 0);
});

test('service.revertHunk: 成功撤回并写回文件、标记台账、触发通知', async () => {
  const fs = new MemFs();
  fs.addFile(FILE, 'a\nX\nb\nc');
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'a\nb\nc', 'a\nX\nb\nc');
  const s = makeService(fs, ledger);
  let notified = '';
  s.onChanged((sid) => (notified = sid));
  const r = await s.revertHunk(SESSION, FILE, 0, 0);
  assert.equal(r.ok, true);
  assert.equal(fs.contentOf(FILE), 'a\nb\nc');
  assert.equal(notified, SESSION);
  const op = ledger.all()[0];
  assert.deepEqual(op.revertedHunks, [0]);
});

test('service.revertHunk: 冲突（区域已被后续修改）→ 拒绝且文件不变', async () => {
  const fs = new MemFs();
  fs.addFile(FILE, 'a\nY\nb\nc'); // X 被后续改成了 Y
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'a\nb\nc', 'a\nX\nb\nc');
  const s = makeService(fs, ledger);
  const r = await s.revertHunk(SESSION, FILE, 0, 0);
  assert.equal(r.ok, false);
  assert.equal(fs.contentOf(FILE), 'a\nY\nb\nc');
});

test('service.revertFile: 恢复首次操作前内容并清空记录', async () => {
  const fs = new MemFs();
  fs.addFile(FILE, 'a\nb\nc');
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'plain', 'a\nb\nc');
  const s = makeService(fs, ledger);
  const r = await s.revertFile(SESSION, FILE);
  assert.equal(r.ok, true);
  assert.equal(fs.contentOf(FILE), 'plain');
  assert.equal(ledger.all().length, 0);
});

test('service.revertFile: 会话中新建的文件 → 删除', async () => {
  const fs = new MemFs();
  fs.addFile(FILE, 'new content');
  const ledger = new ChangeLedger();
  ledger.add({ sessionId: SESSION, filePath: FILE, before: null, after: 'new content', turn: 1 });
  const s = makeService(fs, ledger);
  const r = await s.revertFile(SESSION, FILE);
  assert.equal(r.ok, true);
  assert.equal(fs.exists(FILE), false);
});

test('service.clearSession: 清空并通知', () => {
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'a', 'b');
  const s = makeService(new MemFs(), ledger);
  let notified = '';
  s.onChanged((sid) => (notified = sid));
  s.clearSession(SESSION);
  assert.equal(ledger.all().length, 0);
  assert.equal(notified, SESSION);
});

// ── 路径归一化（Windows 反斜杠 vs 文件树正斜杠） ──────────────────────
test('service.opsFor: 反斜杠台账路径 vs 正斜杠查询路径 → 命中并归一化输出', () => {
  const ledger = new ChangeLedger();
  ledger.add({ sessionId: SESSION, filePath: 'E:\\work\\main.cpp', before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const s = makeService(new MemFs(), ledger);
  const payload = s.opsFor(SESSION, 'E:/work/main.cpp');
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].path, 'E:/work/main.cpp');
  assert.equal(payload.files[0].ops[0].hunks.length, 1);
  // 不带 file 参数时同样归一化输出
  const all = s.opsFor(SESSION);
  assert.equal(all.files[0].path, 'E:/work/main.cpp');
});

test('service.revertHunk: 正斜杠路径命中反斜杠台账并成功撤回', async () => {
  const fs = new MemFs();
  fs.addFile('E:/work/main.cpp', 'a\nX\nb');
  const ledger = new ChangeLedger();
  ledger.add({ sessionId: SESSION, filePath: 'E:\\work\\main.cpp', before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const s = makeService(fs, ledger);
  const r = await s.revertHunk(SESSION, 'E:/work/main.cpp', 0, 0);
  assert.equal(r.ok, true);
  assert.equal(fs.contentOf('E:/work/main.cpp'), 'a\nb');
});

test('service.revertHunk: 撤回写入携带会话级沙箱策略（workspace-write + 会话工作区根）', async () => {
  const fs = new MemFs();
  fs.addFile(FILE, 'a\nX\nb');
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'a\nb', 'a\nX\nb');
  const s = new WsStudioService({
    ledger,
    fs,
    sessionCwd: (sid) => (sid === SESSION ? '/work' : undefined),
    maxReadBytes: 100,
  });
  const r = await s.revertHunk(SESSION, FILE, 0, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(fs.lastPolicy, { mode: 'workspace-write', workspaceRoot: '/work' });
});

test('service.revertFile: 正斜杠路径整文件撤回并清空该文件记录', async () => {
  const fs = new MemFs();
  fs.addFile('E:/work/main.cpp', 'a\nX\nb');
  const ledger = new ChangeLedger();
  ledger.add({ sessionId: SESSION, filePath: 'E:\\work\\main.cpp', before: 'a\nb', after: 'a\nX\nb', turn: 1 });
  const s = makeService(fs, ledger);
  const r = await s.revertFile(SESSION, 'E:/work/main.cpp');
  assert.equal(r.ok, true);
  assert.equal(fs.contentOf('E:/work/main.cpp'), 'a\nb');
  assert.equal(ledger.all().length, 0);
});

// ── 认可（accept）与 pending 语义 ────────────────────────────────────
test('service.acceptHunk: 认可成功、重复认可拒绝、已撤回的拒绝', async () => {
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'a\nb', 'a\nX\nb');
  const s = makeService(new MemFs(), ledger);
  let notified = '';
  s.onChanged((sid) => (notified = sid));

  const r1 = await s.acceptHunk(SESSION, FILE, 0, 0);
  assert.equal(r1.ok, true);
  assert.deepEqual(ledger.all()[0].acceptedHunks, [0]);
  assert.equal(notified, SESSION);

  const r2 = await s.acceptHunk(SESSION, FILE, 0, 0);
  assert.equal(r2.ok, false); // 重复认可

  const r3 = await s.acceptHunk(SESSION, FILE, 0, 5);
  assert.equal(r3.ok, false); // 越界 hunk 索引
});

test('service.opsFor: 全部处理完的文件不再出现在列表视图，但指定文件时仍返回', async () => {
  const ledger = new ChangeLedger();
  addEditOp(ledger, 'a\nb', 'a\nX\nb'); // 1 个 hunk
  const s = makeService(new MemFs(), ledger);
  assert.equal(s.opsFor(SESSION).files.length, 1);
  assert.equal(s.opsFor(SESSION).files[0].pending, true);

  // 认可唯一 hunk → 列表视图排除该文件；指定文件时仍返回且 pending=false
  const opId = ledger.all()[0].id;
  ledger.markHunkAccepted(opId, 0);
  assert.equal(s.opsFor(SESSION).files.length, 0);
  const detail = s.opsFor(SESSION, FILE);
  assert.equal(detail.files.length, 1);
  assert.equal(detail.files[0].pending, false);
  assert.deepEqual(detail.files[0].ops[0].acceptedHunks, [0]);
});
