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

export interface FsLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>;
  stat(target: FsTargetLike, signal?: AbortSignal): Promise<FsInfoLike | undefined>;
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>;
  listDir(target: FsTargetLike, signal?: AbortSignal): Promise<FsDirEntryLike[]>;
  /** sandboxPolicy: { mode: 'read-only'|'workspace-write'|'danger-full-access', workspaceRoot: string } */
  writeText(
    target: FsTargetLike,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown>;
  /** 部分后端提供删除能力；缺失时回退 node:fs */
  unlink?(target: FsTargetLike): Promise<unknown>;
}

/** ctx.webServer.register 的路由对象形状。 */
export interface WebRouteLike {
  kind: 'exact';
  path: string;
  handler: (req: unknown, res: unknown) => void;
}

export interface WebServerLike {
  register(route: WebRouteLike): unknown;
}

/** ctx.agents.store 的条目形状。 */
export interface AgentEntryLike {
  owner?: { id?: string };
  agent?: {
    id?: string;
    session?: {
      header?: { cwd?: string };
      events?: Array<{ type: string; data?: { turn?: number } }>;
    };
  };
}

export interface AgentsLike {
  store: Map<string, AgentEntryLike>;
}

/** node:http 风格的最小 req/res（测试可用假对象）。 */
export interface ReqLike {
  url: string;
  on?(event: 'data' | 'end' | 'error' | 'close', cb: (...args: unknown[]) => void): void;
}

export interface ResLike {
  statusCode: number;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  setHeader?(key: string, value: string): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}
