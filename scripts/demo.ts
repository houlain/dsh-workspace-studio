// 端到端演示：真实文件 + 台账 + diff + hunk 级部分撤回
// 运行：node scripts/demo.ts（仅在工作区内读写，安全）
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeLedger } from '../src/core/ledger.ts';
import { diffHunks } from '../src/core/diff.ts';
import { revertHunk } from '../src/core/hunkRevert.ts';

const demoDir = join(process.cwd(), '.demo');
mkdirSync(demoDir, { recursive: true });
const file = join(demoDir, 'hello.cpp');

const v0 = `#include <iostream>

int main() {
  std::cout << "Hello, DSH!" << std::endl;
  return 0;
}
`;

writeFileSync(file, v0, 'utf8');
const ledger = new ChangeLedger();

// ── 操作 1：agent 加了一个 greet 函数 ──────────────────────────────
const v1 = `#include <iostream>

void greet(const std::string& name) {
  std::cout << "Hello, " << name << "!" << std::endl;
}

int main() {
  std::cout << "Hello, DSH!" << std::endl;
  return 0;
}
`;
writeFileSync(file, v1, 'utf8');
ledger.add({ sessionId: 's1', filePath: file, before: v0, after: v1, turn: 1 });

// ── 操作 2：agent 又加了一个 sum 函数（换行符位置也变了） ─────────────
const v2 = `#include <iostream>

void greet(const std::string& name) {
  std::cout << "Hello, " << name << "!" << std::endl;
}

int sum(int a, int b) {
  return a + b;
}

int main() {
  std::cout << "Hello, DSH!" << std::endl;
  return 0;
}
`;
writeFileSync(file, v2, 'utf8');
ledger.add({ sessionId: 's1', filePath: file, before: v1, after: v2, turn: 1 });

const current = readFileSync(file, 'utf8');
const op1 = ledger.opsForFile(file)[0];
const op2 = ledger.opsForFile(file)[1];

console.log('═══ 操作 1 的变更块（diffHunks）═══');
const hunks1 = diffHunks(op1.before.split('\n'), op1.after.split('\n'));
hunks1.forEach((h, i) => {
  console.log(`hunk[${i}] oldStart=${h.oldStart} newStart=${h.newStart}`);
  for (const l of h.removed) console.log(`  - ${l}`);
  for (const l of h.added) console.log(`  + ${l}`);
});

console.log('\n═══ 撤回操作 1 的 hunk[0]（greet 函数整块）═══');
const r = revertHunk(current.split('\n'), op1.before, op1.after, 0);
if (r.ok) {
  writeFileSync(file, r.content, 'utf8');
  console.log('✅ 撤回成功，文件现在是：\n');
  console.log(r.content);
  const back = readFileSync(file, 'utf8');
  console.log('验证：sum 函数还在 =', back.includes('int sum(int a, int b)'));
  console.log('验证：greet 函数没了 =', !back.includes('void greet'));
} else {
  console.log('❌ 撤回失败：', r.reason);
}

rmSync(demoDir, { recursive: true, force: true });
console.log('\n（演示目录已清理）');
