# dsh-workspace-studio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/平台-Windows%20（已验证）-orange)

> ⚠️ **平台状态：仅 Windows 验证。**
> 本插件仅在 **Windows**（PowerShell）上测试过。**尚未在 Linux / macOS 上验证**——路径处理、shell 行为与沙箱交互在这些平台上可能不同。**非 Windows 平台请谨慎使用！**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件，把 Web 界面变成轻量编码工作台，支持 **Trae 式逐块部分撤回**：

1. **工作区文件浏览器** — 可折叠文件树；自动过滤构建产物噪声；含改动的文件夹自动展开并显示数量角标；被修改的文件带 ● 标记。
2. **代码查看器** — 点击任意文件即可查看内容（带行号）。
3. **改动审查（git 风格 diff）** — 模型每次 `write`/`edit` 都被记录前后完整快照，渲染为行级 diff 变更块，SSE 实时推送。
4. **逐块部分撤回 / 认可** — 像 Trae 一样**一处一处撤回**，或标记为**认可**；已处理（撤回/认可）的改动不再显示差异、不再标记。冲突保护：区域被后续修改时拒绝撤回。

---

## ⚠️ 重要说明

- **仅 Windows 验证**。Linux/macOS **未验证**，在这些平台上使用风险自负。
- 改动记录**按会话隔离**——每个会话只能看到自己的改动（设计如此）。
- 只跟踪 `write` / `edit` 工具调用；你用自己的编辑器直接改的文件不会被记录。

## 安装

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:houlain/dsh-workspace-studio
```

然后重启 `dsh web`，打开**新会话**。

### 手动安装（无需 pnpm）

1. 把包复制进 profile 的 `node_modules`：

   ```powershell
   $src = "<你的克隆路径>\dsh-workspace-studio"
   $dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-workspace-studio"
   Copy-Item -Recurse -Force $src $dst
   ```

2. 在 profile 的 `package.json` 中登记：

   ```json
   {
     "dependencies": { "dsh-workspace-studio": "0.1.0" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-workspace-studio"] } }
   }
   ```

3. 重启 `dsh web`。

> 包内已附构建产物（`lib/`），安装无需构建。注意必须**复制**（不要符号链接到开发目录）；更新插件后重新构建并再次复制。

## 使用

1. 在 Web UI 打开一个会话，切换到 **「Studio」** 标签（在"对话"旁边）。
2. 左侧是工作区文件树：
   - 文件夹可折叠（`▸`/`▾`）；含未处理改动的文件夹显示**数量角标**并自动展开。
   - 被模型修改过的文件带 **●** 标记。
3. 点击文件：右上查看内容，右下查看改动面板。
4. 每个操作包含一个或多个**变更块**，每个块两个按钮：
   - **「撤回此块」** — 只撤销这一块，其他块保留；弹确认框后直接改写磁盘文件。
   - **「认可」** — 确认保留；该块不再显示差异、不再标记，之后也不能再撤回。
5. **「撤回全部修改」** — 恢复到该文件在本会话第一次修改前的状态（会话中新建的文件会被删除）。
6. **「清空」** — 清除本会话的改动记录（不影响文件内容）。
7. **Studio 标签角标**显示"仍有未处理改动"的文件数；模型改文件时通过 SSE 实时更新标记。

### 撤回安全规则

- 只有**该块的代码行仍然原样存在**时才能撤回；区域被后续修改覆盖时**拒绝并提示**（冲突保护）。
- 已撤回/已认可的分块不能再操作。
- 旧操作的某个分块可以撤回，即使后续操作导致行号偏移。

## 架构

单包双半侧（`dsh.bundle` + `dsh.client` 清单），以**单个** loader entry 挂载：

```
dsh-workspace-studio/
├── src/
│   ├── core/        # 纯逻辑，零依赖，完整单测
│   │   ├── diff.ts       # LCS 行级 diff → 带上下文 hunks
│   │   ├── ledger.ts     # 前后快照台账 + 持久化
│   │   ├── hunkRevert.ts # 逐块反向应用 + 冲突检测
│   │   └── fileTree.ts   # 文件树构建（忽略规则）
│   ├── host/        # Node 半侧：tools/result 监听、HTTP/SSE 路由、ctx.fs
│   ├── client/      # 浏览器半侧：Studio 视图（React，无外部依赖）
│   └── shared/      # 双半侧共享载荷类型
├── lib/             # 预构建产物（host: lib/index.js；browser: lib/client.js）
└── tests/           # 67 个测试（node:test，无测试框架依赖）
```

### HTTP 路由（同源，全部位于 `/ws-studio/*`）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/ws-studio/tree?root=` | GET | 工作区文件树 |
| `/ws-studio/file?path=` | GET | 文件内容（大小上限） |
| `/ws-studio/ops?session=` | GET | 改动操作及 hunks（列表视图仅返回未处理项） |
| `/ws-studio/revert?session=` | POST | 撤回单个 hunk；不带 `op`/`hunk` 时整文件撤回 |
| `/ws-studio/accept?session=` | POST | 认可单个 hunk |
| `/ws-studio/clear?session=` | POST | 清空会话改动记录 |
| `/ws-studio/context?session=` | GET | 会话工作目录 |
| `/ws-studio/events` | GET (SSE) | 实时改动推送 |

### 数据与持久化

- 改动快照持久化到 `<profile目录>/ws-studio-state.json`（如 `~/.dsh/profiles/web/ws-studio-state.json`），防抖写入、原子替换、退出时落盘。
- 容量守卫：每文件最多 100 条操作、每条快照 120 KB（超大操作只留占位——可见但不可撤回）。

### 沙箱感知

- 撤回写入走 harness 文件系统服务（`ctx.fs`），携带**会话级沙箱策略**（`workspace-write` + 会话工作区根）——会话工作区之外的文件会被 harness 沙箱本身拒绝。
- 文件树与读取同样优先走 `ctx.fs`（无则回退 `node:fs`）。

## 安全与隐私

- **无遥测、无统计、无任何外部网络请求**。所有路由均为同源，插件从不联系第三方服务器。
- 插件**不读取、不存储**凭据、API key、环境变量密钥、操作系统/用户元数据。
- 磁盘上唯一的数据是改动台账（会话中编辑过的文件路径与文件内容）和 UI 状态。
- 撤回写入仍受 harness 沙箱策略约束。

## 配置

文件树默认忽略常见噪声（`.git`、`node_modules`、`dist`、`build`、锁文件、`coverage` 等）。忽略列表在 `src/core/fileTree.ts`（`DEFAULT_TREE_OPTIONS`），如需自定义请重新构建。

## 开发

要求：**Node.js ≥ 22.6**（测试直接使用 Node 原生 TS type-stripping，无需构建），npm。

```sh
npm install        # 开发依赖：esbuild
npm run build      # 产出 lib/index.js（host）+ lib/client.js（browser）
npm test           # 67 个测试（node --test）
```

给贡献者的注意：

- 浏览器半侧使用 `React.createElement`（无 JSX），并在 `node_modules/react` 下放了一个极小的本地 `react` 桩，让测试无需 DOM 即可断言渲染树。**不要删除该桩**；将来真实 `npm install react` 会替换它。
- 代码必须保持**可擦除语法 TypeScript**（无 enum、无参数属性），以便 Node type-stripping 直接运行测试。
- 相对导入使用显式 `.ts` 扩展名（NodeNext）。

## 已知限制

- **平台**：仅 Windows 验证；Linux/macOS 未测试——请谨慎使用。
- 改动跟踪按会话隔离，且仅覆盖 `write`/`edit` 工具调用。
- diff 为行级 LCS，未做字符级（intra-line）高亮。
- 撤回旧操作的中间分块要求该区域行仍原样存在；重叠的后续编辑会拒绝撤回。
- 整文件撤回恢复到该文件在本会话**第一次**记录操作之前的状态。
- 超大文件（> 2 MB）查看器拒绝打开；超大改动快照（> 120 KB）不可撤回。

## License

[MIT](LICENSE) © 2026 houlain
