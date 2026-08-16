// 工作区文件树：递归列出目录内容（注入 reader，便于纯逻辑测试）。
// host 集成时用 ctx.fs 实现 FsReader；测试用假 reader。

export interface FsEntry {
  name: string;
  isDir: boolean;
}

export interface FsReader {
  listDir(path: string): Promise<FsEntry[]>;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileEntry[];
}

export interface TreeOptions {
  maxDepth: number;
  maxEntries: number;
  ignore: string[];
}

export const DEFAULT_TREE_OPTIONS: TreeOptions = {
  maxDepth: 12,
  maxEntries: 2000,
  ignore: [
    '.git',
    '.hg',
    '.svn',
    '.gitignore',
    '.gitattributes',
    '.editorconfig',
    '.DS_Store',
    'node_modules',
    'dist',
    'build',
    'out',
    'target',
    'bin',
    'obj',
    '.venv',
    'venv',
    '__pycache__',
    '.dsh',
    '.idea',
    '.vscode',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'coverage',
    '.next',
    '.nuxt',
    '.parcel-cache',
  ],
};

export async function buildFileTree(
  root: string,
  reader: FsReader,
  options: TreeOptions = DEFAULT_TREE_OPTIONS,
): Promise<FileEntry[]> {
  // 归一化根路径（Windows 反斜杠 → 正斜杠），保证树节点路径与台账归一化路径一致，
  // 客户端才能用 Set.has() 精确匹配"已修改"标记。
  const normRoot = root.replace(/\\/g, '/');
  return walk(normRoot, reader, options, 0, { count: 0 });
}

async function walk(
  dir: string,
  reader: FsReader,
  options: TreeOptions,
  depth: number,
  budget: { count: number },
): Promise<FileEntry[]> {
  if (depth > options.maxDepth) return [];
  let entries: FsEntry[];
  try {
    entries = await reader.listDir(dir);
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (options.ignore.includes(e.name)) continue;
    if (budget.count >= options.maxEntries) break;
    budget.count++;
    const full = `${dir.replace(/[\\/]+$/, '')}/${e.name}`;
    if (e.isDir) {
      const children = await walk(full, reader, options, depth + 1, budget);
      out.push({ name: e.name, path: full, isDir: true, children });
    } else {
      out.push({ name: e.name, path: full, isDir: false });
    }
  }
  return out;
}
