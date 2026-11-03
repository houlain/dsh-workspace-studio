// host 半侧的结构化类型（最小化、不依赖 @deepseek-ai 类型包，
// 与真实 DSH 运行时按结构兼容）。

/** ctx.fs 服务的最小结构（@deepseek-ai/dsh-fs 的 FileSystem）。 */
export interface FsTargetLike {
  targetKey: string;
  displayPath: string;
}

export interface FsInfoLike {
  type: 'file' | 'directory' | 'other';
  version: unknown;
  size?: number;
}

export interface FsDirEntryLike {
  name: string;
  type: 'file' | 'directory' | 'other';
  target: FsTargetLike;
}

/**
 * 宿主的写意图（契约 §5）：`ctx.fs.writeText` 的第三参数必须是这个**对象**，
 * 传裸版本令牌会让护栏静默失效（红队实测）。`{kind:'createIfAbsent'}` 表示"仅当不存在"。
 */
export type FsWriteIntentLike =
  | { kind: 'replaceIfVersion'; version: unknown }
  | { kind: 'createIfAbsent' };

export interface FsLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>;
  stat(target: FsTargetLike, signal?: AbortSignal): Promise<FsInfoLike | undefined>;
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>;
  listDir(target: FsTargetLike, signal?: AbortSignal): Promise<FsDirEntryLike[]>;
  /** sandboxPolicy: { mode: 'read-only'|'workspace-write'|'danger-full-access', workspaceRoot: string } */
  writeText(
    target: FsTargetLike,
    content: string,
    expected?: FsWriteIntentLike,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown>;
  /** 未来宿主若提供删除动词则用它；0.2.1-rc.5 的 fs seam 没有。 */
  remove?(target: FsTargetLike, sandboxPolicy?: unknown, signal?: AbortSignal): Promise<unknown>;
  /** 后端路径 → 本机 OS 路径；仅在无 `remove` 时用于「先校验沙箱根、再删本机文件」。 */
  processPath?(target: FsTargetLike): string;
  /** 旧形状（本机宿主无此方法，保留兼容） */
  unlink?(target: FsTargetLike): Promise<unknown>;
}

/** ctx.webServer.register 的路由对象形状。 */
export interface WebRouteLike {
  kind: 'exact';
  path: string;
  handler: (req: unknown, res: unknown) => void;
}

export interface WebServerLike {
  /** 返回该路由的释放函数（0.2.x 契约）；旧宿主可能返回其他值，按可选处理。 */
  register(route: WebRouteLike): unknown;
}

/** 一个 Agent（会话的运行体），0.2.1 起由 ctx.agents.get(id) 直接给出。 */
export interface AgentLike {
  id?: string;
  owner?: { id?: string };
  session?: {
    header?: {
      cwd?: string;
      /** 0.2.1：子代理会话的父会话 id */
      parentSession?: string;
      delegationDepth?: number;
    };
    /** 0.2.1 的事件访问器（冻结、按 seq 排序） */
    snapshotEvents?: () => unknown;
    /** 旧形状：直接挂在 session 上的事件数组 */
    events?: Array<{ type: string; data?: { turn?: number } }>;
  };
}

/** ctx.agents.store 的条目形状：包着 agent，并带上归属链。 */
export interface AgentEntryLike {
  owner?: { id?: string };
  agent?: AgentLike;
}

/**
 * agents 服务。0.2.1 起新增 `get(id)` 直接返回 Agent；
 * `store` 仍在（用于遍历归属链与删除）。两者都按可选处理，缺一也能工作。
 */
export interface AgentsLike {
  store?: Map<string, AgentEntryLike>;
  get?(id: string): AgentLike | undefined;
}

/** node:http 风格的最小 req/res（测试可用假对象）。 */
export interface ReqLike {
  url: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  on?(event: 'data' | 'end' | 'error' | 'close', cb: (...args: unknown[]) => void): void;
}

/** 工作区注册表（宿主 ctx.workspaceRegistry）。 */
export interface WorkspaceLike {
  id?: string;
  workspaceId?: string;
  path?: string;
  sessionIds?: string[];
}

export interface WorkspaceRegistryLike {
  list(): WorkspaceLike[];
}

export interface ResLike {
  statusCode: number;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  setHeader?(key: string, value: string): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}
