// ★ 核心卖点：hunk 级部分撤回。
// 安全规则：只有该 hunk 自己引入的变更行仍然原样存在于当前文件中时，
// 才允许撤回；该区域被后续修改覆盖则拒绝（冲突检测）。
// 纯 TypeScript、零依赖。
import { diffHunks, type Hunk } from './diff.ts';

export type RevertResult =
  | { ok: true; content: string; revertedHunk: number }
  | { ok: false; reason: string };

export interface RevertOptions {
  /** 在期望位置 ±window 行内优先搜索，找不到再全文件扫描 */
  window: number;
  context: number;
}

export const DEFAULT_REVERT_OPTIONS: RevertOptions = { window: 1000, context: 3 };

/**
 * 将某次操作（before→after）的第 hunkIndex 个变更块，从当前文件内容中反向撤回。
 * @param currentLines 当前文件的行数组（含后续操作的改动）
 * @param before 该操作执行前的内容
 * @param after 该操作执行后的内容
 */
export function revertHunk(
  currentLines: string[],
  before: string,
  after: string,
  hunkIndex: number,
  options: RevertOptions = DEFAULT_REVERT_OPTIONS,
): RevertResult {
  const hunks = diffHunks(before.split('\n'), after.split('\n'), options.context);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    return { ok: false, reason: `变更块 ${hunkIndex} 不存在（该操作共有 ${hunks.length} 个变更块）` };
  }
  const applied = applyHunk(currentLines, hunk, options);
  if (!applied.ok) return applied;
  return { ok: true, content: applied.lines.join('\n'), revertedHunk: hunkIndex };
}

function applyHunk(
  current: string[],
  hunk: Hunk,
  options: RevertOptions,
): { ok: true; lines: string[] } | { ok: false; reason: string } {
  if (hunk.added.length > 0) {
    // 有新增行：定位这些行（它们正是本 hunk 引入的），原位替换为被删行（或删除）
    const idx = indexOfBlock(current, hunk.added, hunk.newStart - 1, options.window);
    if (idx < 0) return { ok: false, reason: '该变更块的代码已被后续修改覆盖，无法撤回' };
    const lines = [...current.slice(0, idx), ...hunk.removed, ...current.slice(idx + hunk.added.length)];
    return { ok: true, lines };
  }
  // 纯删除：added 为空，用前后上下文定位删除点，把被删行插回去
  const marker = [...hunk.ctxBefore, ...hunk.ctxAfter];
  const idx = indexOfBlock(current, marker, Math.max(0, hunk.newStart - 1 - hunk.ctxBefore.length), options.window);
  if (idx < 0) return { ok: false, reason: '该删除位置的上下文已被后续修改覆盖，无法撤回' };
  const insAt = idx + hunk.ctxBefore.length;
  const lines = [...current.slice(0, insAt), ...hunk.removed, ...current.slice(insAt)];
  return { ok: true, lines };
}

function indexOfBlock(lines: string[], block: string[], expected: number, window: number): number {
  if (block.length === 0) return -1;
  const start = Math.max(0, expected - window);
  const end = Math.min(lines.length - block.length, expected + window);
  for (let i = start; i <= end; i++) {
    if (lines[i] === block[0] && eqBlock(lines, i, block)) return i;
  }
  for (let i = 0; i <= lines.length - block.length; i++) {
    if (lines[i] === block[0] && eqBlock(lines, i, block)) return i;
  }
  return -1;
}

function eqBlock(lines: string[], at: number, block: string[]): boolean {
  for (let k = 0; k < block.length; k++) {
    if (lines[at + k] !== block[k]) return false;
  }
  return true;
}
