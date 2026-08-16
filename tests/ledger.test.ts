import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeLedger, DEFAULT_LEDGER_OPTIONS } from '../src/core/ledger.ts';

const tmp = mkdtempSync(join(process.cwd(), '.tmp-ledger-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const op = (filePath: string, before: string, after: string, sessionId = 's1', turn: number | null = 1) => ({
  sessionId,
  filePath,
  before,
  after,
  turn,
});

test('ledger: 添加/按文件/按会话查询', () => {
  const l = new ChangeLedger();
  l.add(op('/p/a.ts', '1', '2'));
  l.add(op('/p/b.ts', 'x', 'y', 's2'));
  assert.equal(l.all().length, 2);
  assert.equal(l.opsForFile('/p/a.ts').length, 1);
  assert.equal(l.filesForSession('s1').length, 1);
  assert.deepEqual(l.filesForSession('s2'), ['/p/b.ts']);
});

test('ledger: 每文件容量上限，超限丢最旧', () => {
  const l = new ChangeLedger({ maxOpsPerFile: 2, maxOpBytes: DEFAULT_LEDGER_OPTIONS.maxOpBytes });
  l.add(op('/p/a.ts', '1', '2'));
  l.add(op('/p/a.ts', '2', '3'));
  l.add(op('/p/a.ts', '3', '4'));
  assert.equal(l.opsForFile('/p/a.ts').length, 2);
  assert.equal(l.opsForFile('/p/a.ts')[0].after, '3');
});

test('ledger: 超大内容只留占位（before/after 置空，仍可见）', () => {
  const l = new ChangeLedger({ maxOpsPerFile: 10, maxOpBytes: 16 });
  const big = 'x'.repeat(100);
  const r = l.add(op('/p/big.ts', 'a', big));
  assert.equal(r.after, '');
  assert.equal(r.before, '');
  assert.equal(l.opsForFile('/p/big.ts').length, 1);
});

test('ledger: clearSession 只清指定会话', () => {
  const l = new ChangeLedger();
  l.add(op('/p/a.ts', '1', '2', 's1'));
  l.add(op('/p/b.ts', 'x', 'y', 's2'));
  assert.equal(l.clearSession('s1'), 1);
  assert.equal(l.all().length, 1);
});

test('ledger: 持久化 round-trip（save + load）', () => {
  const file = join(tmp, 'ledger.json');
  const l1 = new ChangeLedger();
  l1.add(op('/p/a.ts', '1', '2', 's9', 3));
  l1.save(file);
  assert.ok(existsSync(file));
  const l2 = new ChangeLedger();
  l2.load(file);
  assert.equal(l2.all().length, 1);
  assert.equal(l2.all()[0].filePath, '/p/a.ts');
  assert.equal(l2.all()[0].before, '1');
  assert.equal(l2.all()[0].turn, 3);
});

test('ledger: 加载不存在的文件得到空台账', () => {
  const l = new ChangeLedger();
  l.load(join(tmp, 'missing.json'));
  assert.equal(l.all().length, 0);
});

test('ledger: 损坏的 JSON 得到空台账而非崩溃', () => {
  const file = join(tmp, 'broken.json');
  writeFileSync(file, '{not json', 'utf8');
  const l = new ChangeLedger();
  l.load(file);
  assert.equal(l.all().length, 0);
});
