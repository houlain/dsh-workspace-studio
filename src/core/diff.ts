// 行级 diff：LCS 算法产出变更块（ChangeBlock）与带上下文的 hunks（Hunk）。
// 纯 TypeScript、零依赖，可在 Node 24 type-stripping 下直接运行。

export interface ChangeBlock {
  /** 1-based，闭区间；纯插入时 oldEnd < oldStart */
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  removed: string[];
  added: string[];
}

export interface Hunk {
  /** hunk 在 before 中的起始行（含前置上下文，1-based） */
  oldStart: number;
  /** hunk 在 after 中的起始行（含前置上下文，1-based） */
  newStart: number;
  /** 前置上下文（两侧相同） */
  ctxBefore: string[];
  /** 后置上下文（两侧相同） */
  ctxAfter: string[];
  /** 被删除的变更行 */
  removed: string[];
  /** 被新增的变更行 */
  added: string[];
}

export const DEFAULT_CONTEXT = 3;

/** 行级 LCS diff，返回变更块（无上下文，1-based 行号）。 */
export function diffLines(before: string[], after: string[]): ChangeBlock[] {
  if (before.length === 0) {
    return after.length === 0
      ? []
      : [{ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: after.length, removed: [], added: [...after] }];
  }
  if (after.length === 0) {
    return [{ oldStart: 1, oldEnd: before.length, newStart: 1, newEnd: 0, removed: [...before], added: [] }];
  }
  // 先裁剪公共前缀/后缀，缩小 LCS 规模
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) {
    s++;
  }
  const midB = before.slice(p, before.length - s);
  const midA = after.slice(p, after.length - s);
  const blocks = lcs(midB, midA);
  for (const b of blocks) {
    b.oldStart += p;
    b.oldEnd += p;
    b.newStart += p;
    b.newEnd += p;
  }
  return blocks;
}

function lcs(b: string[], a: string[]): ChangeBlock[] {
  if (b.length === 0) {
    return a.length === 0
      ? []
      : [{ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: a.length, removed: [], added: [...a] }];
  }
  if (a.length === 0) {
    return [{ oldStart: 1, oldEnd: b.length, newStart: 1, newEnd: 0, removed: [...b], added: [] }];
  }
  const n = b.length;
  const m = a.length;
  const row = m + 1;
  const dp = new Int32Array((n + 1) * row);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * row + j] =
        b[i] === a[j] ? dp[(i + 1) * row + j + 1] + 1 : Math.max(dp[(i + 1) * row + j], dp[i * row + j + 1]);
    }
  }
  const blocks: ChangeBlock[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  let oldStart = 0;
  let newStart = 0;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (removed.length > 0 || added.length > 0) {
      blocks.push({
        oldStart,
        oldEnd: oldStart + removed.length - 1,
        newStart,
        newEnd: newStart + added.length - 1,
        removed,
        added,
      });
      removed = [];
      added = [];
    }
  };
  while (i < n && j < m) {
    if (b[i] === a[j]) {
      flush();
      i++;
      j++;
    } else if (dp[(i + 1) * row + j] >= dp[i * row + j + 1]) {
      if (removed.length === 0 && added.length === 0) {
        oldStart = i + 1;
        newStart = j + 1;
      }
      removed.push(b[i]);
      i++;
    } else {
      if (removed.length === 0 && added.length === 0) {
        oldStart = i + 1;
        newStart = j + 1;
      }
      added.push(a[j]);
      j++;
    }
  }
  while (i < n) {
    if (removed.length === 0 && added.length === 0) {
      oldStart = i + 1;
      newStart = j + 1;
    }
    removed.push(b[i]);
    i++;
  }
  while (j < m) {
    if (removed.length === 0 && added.length === 0) {
      oldStart = i + 1;
      newStart = j + 1;
    }
    added.push(a[j]);
    j++;
  }
  flush();
  return blocks;
}

/** 由变更块生成带上下文的 hunks（供 UI 展示与 hunk 级撤回定位）。 */
export function diffHunks(before: string[], after: string[], context = DEFAULT_CONTEXT): Hunk[] {
  const blocks = diffLines(before, after);
  const hunks: Hunk[] = [];
  for (const blk of blocks) {
    // 变更区域之后的第一行（0-based）：
    // 有删除行 → 被删行结束于 1-based oldEnd，其后第一行 0-based 下标即 oldEnd；
    // 纯插入 → 插入点位于 1-based oldStart 之前，其后第一行 0-based 下标为 oldStart - 1。
    const afterStartIdx = blk.oldEnd >= blk.oldStart ? blk.oldEnd : blk.oldStart - 1;
    const ctxBefore = before.slice(Math.max(0, blk.oldStart - 1 - context), blk.oldStart - 1);
    const ctxAfter = before.slice(afterStartIdx, Math.min(before.length, afterStartIdx + context));
    hunks.push({
      oldStart: Math.max(1, blk.oldStart - context),
      newStart: Math.max(1, blk.newStart - context),
      ctxBefore,
      ctxAfter,
      removed: [...blk.removed],
      added: [...blk.added],
    });
  }
  return hunks;
}
