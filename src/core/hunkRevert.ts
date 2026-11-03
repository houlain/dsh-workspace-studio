// ★ 核心卖点：hunk 级部分撤回。
// 安全规则（契约 §6：位置优先 + 上下文校验，绝不猜测）：
// 1. 先按 hunk.newStart（±window 行）在目标位置找匹配；
// 2. 该位置的 ctxBefore/ctxAfter 必须与文件实际行**逐行相等**；
// 3. 位置不匹配才在全文搜索，且**只有唯一匹配**才应用；
// 4. 多个匹配或无匹配一律拒绝（文件已被其它修改影响，请刷新后重试）。
// 纯 TypeScript、零依赖。
import { diffHunks, type Hunk } from './diff.ts';

export type RevertResult =
  | { ok: true; content: string; revertedHunk: number }
  | { ok: false; reason: string };

export interface RevertOptions {
  /** 期望位置 ±window 行内优先搜索 */
  window: number;
  /** diff 上下文行数 */
  context: number;
}

export const DEFAULT_REVERT_OPTIONS: RevertOptions = { window: 2, context: 3 };

/** 位置无法唯一确定时的标准拒绝理由（契约 §6 固定文案，客户端/测试按此匹配）。 */
export const AMBIGUOUS_REASON = '无法唯一确定该变更块的位置（文件已被其它修改影响），请刷新后重试';

/** 完全找不到匹配行：先点明"已被覆盖"，再给出标准理由（便于 UI 与日志检索）。 */
export const NOT_FOUND_REASON = `该变更块的代码已被后续修改覆盖，${AMBIGUOUS_REASON}`;

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
  const located = locate(currentLines, hunk, options);
  if (!located.ok) return located;
  return {
    ok: true,
    content: applyAt(currentLines, hunk, located.anchor).join('\n'),
    revertedHunk: hunkIndex,
  };
}

type Location = { ok: true; anchor: number } | { ok: false; reason: string };

/**
 * 定位变更块：返回 `added` 块（或纯删除的插入点）的**锚点**下标。
 * 先窗口内找；窗口内不唯一/没有才全文找，全文必须唯一。
 */
function locate(current: string[], hunk: Hunk, options: RevertOptions): Location {
  const insertion = hunk.added.length > 0;
  // 纯删除：added 为空，用前后上下文拼出的块定位删除点；
  // 相邻重复行（dup/dup）下这种拼块仍然唯一，比只用上下文更稳。
  const target = insertion ? hunk.added : [...hunk.ctxBefore, ...hunk.ctxAfter];
  if (target.length === 0) {
    return { ok: false, reason: `该变更块没有可用于定位的内容，${AMBIGUOUS_REASON}` };
  }
  // hunk.newStart 是含前置上下文的 1-based 首行，块本体在其后 ctxBefore.length 行
  const expected = Math.max(0, hunk.newStart - 1 + (insertion ? hunk.ctxBefore.length : 0));
  const near = collectMatches(current, target, hunk, insertion, expected, options.window);
  if (near.length === 1) return { ok: true, anchor: near[0] };
  // 窗口内 0 个或多个 → 全文搜索，且只接受唯一匹配
  const all = collectMatches(current, target, hunk, insertion, expected, Number.MAX_SAFE_INTEGER);
  if (all.length === 1) return { ok: true, anchor: all[0] };
  if (all.length === 0) return { ok: false, reason: NOT_FOUND_REASON };
  return { ok: false, reason: AMBIGUOUS_REASON };
}

/** 在 [expected-window, expected+window] 内收集全部匹配位置（含上下文逐行校验）。 */
function collectMatches(
  lines: string[],
  target: string[],
  hunk: Hunk,
  insertion: boolean,
  expected: number,
  window: number,
): number[] {
  const maxAnchor = lines.length - target.length;
  if (maxAnchor < 0) return [];
  const start = Math.max(0, expected - window);
  const end = Math.min(maxAnchor, expected + window);
  const hits: number[] = [];
  for (let i = start; i <= end; i++) {
    if (matchesAt(lines, i, target, hunk, insertion)) hits.push(i);
  }
  return hits;
}

/** 该锚点处的正文与上下文是否**逐行**相等。 */
function matchesAt(lines: string[], anchor: number, target: string[], hunk: Hunk, insertion: boolean): boolean {
  if (anchor < 0) return false;
  if (anchor + target.length > lines.length) return false;
  if (insertion) {
    // 新增块两侧的上下文都必须原样存在，否则说明该区域被后续修改动过
    if (anchor - hunk.ctxBefore.length < 0) return false;
    if (anchor + target.length + hunk.ctxAfter.length > lines.length) return false;
  }
  for (let k = 0; k < target.length; k++) {
    if (lines[anchor + k] !== target[k]) return false;
  }
  if (!insertion) return true;
  for (let k = 0; k < hunk.ctxBefore.length; k++) {
    if (lines[anchor - hunk.ctxBefore.length + k] !== hunk.ctxBefore[k]) return false;
  }
  for (let k = 0; k < hunk.ctxAfter.length; k++) {
    if (lines[anchor + target.length + k] !== hunk.ctxAfter[k]) return false;
  }
  return true;
}

/** 在原位把新增行换成被删行；纯删除则在锚点 + 前置上下文长度处插回。 */
function applyAt(lines: string[], hunk: Hunk, anchor: number): string[] {
  if (hunk.added.length > 0) {
    return [...lines.slice(0, anchor), ...hunk.removed, ...lines.slice(anchor + hunk.added.length)];
  }
  const insAt = anchor + hunk.ctxBefore.length;
  return [...lines.slice(0, insAt), ...hunk.removed, ...lines.slice(insAt)];
}
