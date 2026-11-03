// 契约 §1/§2 的 host 侧断言：统一路径口径、敏感路径名单、请求信任判定。
// 这些用例检验的是 `src/host/security.ts`（由 Lead 实现），测试侧只按契约断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  TRUST_HEADER,
  canonicalPath,
  isPathInsideWorkspace,
  isSensitivePath,
  isTrustedRequest,
} from '../src/host/security.ts';

const isWin = process.platform === 'win32';

// ── §1 canonicalPath ────────────────────────────────────────────────
test('security.canonicalPath: 非绝对路径一律 undefined', () => {
  assert.equal(canonicalPath('relative/a.cpp'), undefined);
  assert.equal(canonicalPath('./a.cpp'), undefined);
  assert.equal(canonicalPath(''), undefined);
  assert.equal(canonicalPath('   '), undefined);
  assert.equal(canonicalPath(undefined as never), undefined);
});

test('security.canonicalPath: Windows 口径（折叠大小写 + 统一 / + 去尾斜杠）', { skip: !isWin }, () => {
  assert.equal(canonicalPath('C:\\Work\\src\\a.cpp'), 'c:/work/src/a.cpp');
  assert.equal(canonicalPath('C:/Work/src/a.cpp'), 'c:/work/src/a.cpp');
  // 大小写折叠：三种写法必须得到同一个键（台账分桶/去重都靠它）
  const keys = new Set([
    canonicalPath('C:\\WORK\\A.CPP'),
    canonicalPath('c:/work/a.cpp'),
    canonicalPath('C:\\Work\\..\\Work\\A.CPP'),
  ]);
  assert.equal(keys.size, 1);
  // 尾部斜杠、重复分隔符
  assert.equal(canonicalPath('C:\\Work\\sub\\'), 'c:/work/sub');
  assert.equal(canonicalPath('C:\\\\Work\\\\sub'), 'c:/work/sub');
  // `.` / `..` 归一化
  assert.equal(canonicalPath('C:\\Work\\.\\a\\..\\b.cpp'), 'c:/work/b.cpp');
  // 盘符根
  assert.equal(canonicalPath('C:\\'), 'c:');
});

test('security.canonicalPath: POSIX 口径（不折叠大小写）', { skip: isWin }, () => {
  assert.equal(canonicalPath('/Work/Sub/'), '/Work/Sub');
  assert.equal(canonicalPath('/work//a/./b.cpp'), '/work/a/b.cpp');
  assert.equal(canonicalPath('/work/a/../b.cpp'), '/work/b.cpp');
  assert.equal(canonicalPath('/'), '/');
  // POSIX 大小写敏感：不能把 /Work 与 /work 当同一个键
  assert.notEqual(canonicalPath('/Work/a.cpp'), canonicalPath('/work/a.cpp'));
});

test('security.isPathInsideWorkspace: 归一化比较，挡前缀兄弟目录', { skip: !isWin }, () => {
  assert.equal(isPathInsideWorkspace('C:\\Work\\a.cpp', ['c:/work']), true);
  assert.equal(isPathInsideWorkspace('c:/work', ['C:\\Work']), true, '根本身也算在根内');
  assert.equal(isPathInsideWorkspace('C:\\Work\\sub\\a.cpp', ['C:\\Work']), true);
  // /work2 不是 /work 的子目录（朴素 startsWith 会误判）
  assert.equal(isPathInsideWorkspace('C:\\Work2\\a.cpp', ['C:\\Work']), false);
  assert.equal(isPathInsideWorkspace('C:\\Other\\a.cpp', ['C:\\Work']), false);
  assert.equal(isPathInsideWorkspace('C:\\Work\\..\\Other\\a.cpp', ['C:\\Work']), false);
  assert.equal(isPathInsideWorkspace('relative/a.cpp', ['C:\\Work']), false);
});

// ── §2 敏感路径名单 ──────────────────────────────────────────────────
test('security.isSensitivePath: 凭据类文件名/目录一律命中', () => {
  const root = isWin ? 'C:\\work' : '/work';
  const p = (rel: string) => (isWin ? `${root}\\${rel}` : `${root}/${rel}`);
  for (const rel of [
    '.secrets',
    '.secrets\\token.txt',
    '.env',
    '.env.local',
    'server.key',
    'sub\\cert.pem',
    'id_rsa',
    'id_rsa.pub',
    'credentials.json',
    'sub\\.env.production',
  ]) {
    assert.equal(isSensitivePath(p(rel.replace(/\\/g, isWin ? '\\' : '/'))), true, `${rel} 应命中敏感名单`);
  }
  // ~/.dsh 下的任何文件都不能被读出来
  assert.equal(isSensitivePath(join(homedir(), '.dsh', 'ws-studio-state.json')), true);
  assert.equal(isSensitivePath(join(homedir(), '.dsh')), true);
  // 正常源码不受影响
  assert.equal(isSensitivePath(p('src\\main.cpp')), false);
  assert.equal(isSensitivePath(p('README.md')), false);
  assert.equal(isSensitivePath(p('keyboard.ts')), false, 'key 只能作为扩展名命中，不能误伤键盘文件');
});

// ── §2 请求信任判定 ──────────────────────────────────────────────────
function req(over: Partial<Record<string, string>> = {}, remoteAddress = '127.0.0.1'): never {
  return {
    headers: { host: '127.0.0.1:3080', [TRUST_HEADER]: '1', ...over },
    socket: { remoteAddress },
  } as never;
}

test('security.isTrustedRequest: 回环 + 信任头 + 同源才通过', () => {
  assert.equal(isTrustedRequest(req()), true);
  assert.equal(isTrustedRequest(req({ origin: 'http://127.0.0.1:3080' })), true);
  assert.equal(isTrustedRequest(req({ 'sec-fetch-site': 'same-origin' })), true);
  // ::1 / IPv4-mapped 也算回环
  assert.equal(isTrustedRequest(req({}, '::1')), true);
  assert.equal(isTrustedRequest(req({}, '::ffff:127.0.0.1')), true);
  // Host 为 localhost 时无 Origin 也可接受
  assert.equal(isTrustedRequest(req({ host: 'localhost:3080' })), true);
});

test('security.isTrustedRequest: 缺信任头 / 非回环 / 跨站一律拒绝', () => {
  const noHeader = req({ [TRUST_HEADER]: '0' });
  assert.equal(isTrustedRequest(noHeader), false);
  assert.equal(isTrustedRequest(req({}, '10.0.0.9')), false);
  assert.equal(isTrustedRequest(req({ origin: 'http://evil.example' })), false);
  assert.equal(isTrustedRequest(req({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isTrustedRequest(req({ 'sec-fetch-site': 'same-site' })), false);
  // Origin 端口不同也不算同源
  assert.equal(isTrustedRequest(req({ origin: 'http://127.0.0.1:9999' })), false);
});

test('security.isTrustedRequest: 主机名伪装一律拒绝（127.evil.com 前缀骗术）', () => {
  // DNS rebinding：解析到 127.0.0.1 但主机名不是回环字面量
  assert.equal(isTrustedRequest(req({ host: '127.evil.com:3080' })), false);
  assert.equal(isTrustedRequest(req({ origin: 'http://127.evil.com:3080' })), false);
  assert.equal(isTrustedRequest(req({ host: 'localhost.evil.com:3080' })), false);
  // Host 缺失同样拒绝
  assert.equal(isTrustedRequest({ headers: { [TRUST_HEADER]: '1' }, socket: { remoteAddress: '127.0.0.1' } } as never), false);
});
