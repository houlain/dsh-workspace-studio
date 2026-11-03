// 浏览器/服务端共享的载荷类型（不含任何 node 依赖，浏览器可安全引入）。
import type { FileEntry } from '../core/fileTree.ts';
import type { Hunk } from '../core/diff.ts';

export type { FileEntry, Hunk };

export interface OpView {
  /** 稳定操作 id（uuid）：撤回/认可按它定位，不再按数组下标（下标会被台账裁剪带偏） */
  id: string;
  /** 台账索引，仅用于展示排序；接口不再接受它作为唯一定位 */
  index: number;
  at: number;
  turn: number | null;
  hunks: Hunk[];
  revertedHunks: number[];
  acceptedHunks: number[];
  revertible: boolean;
  /** 快照过大被截断（占位记录）：可见但不可撤回 */
  truncated?: boolean;
  /** 是否还有未处理（未撤回也未认可）的变更块 */
  pending: boolean;
  added: number;
  removed: number;
}

export interface FileOpsView {
  path: string;
  latestAt: number;
  ops: OpView[];
  /** 该文件是否还有未处理的改动（决定 ● 标记与角标） */
  pending: boolean;
}

export interface OpsPayload {
  files: FileOpsView[];
}

export type ReadResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; error: string };

export type RevertResult = { ok: true; message: string } | { ok: false; error: string };

export interface SessionContext {
  /** 会话工作目录；取不到时显式给 null（不要用空对象冒充成功） */
  cwd: string | null;
}
