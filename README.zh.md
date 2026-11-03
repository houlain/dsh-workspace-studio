# dsh-workspace-studio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/平台-Windows%20（已验证）-orange)

> ⚠️ **平台状态：仅 Windows 验证。**
> 本插件仅在 **Windows**（PowerShell）上测试过。**尚未在 Linux / macOS 上验证**——路径处理、shell 行为与沙箱交互在这些平台上可能不同。**非 Windows 平台请谨慎使用！**

> ✅ **宿主兼容：DSH 桌面版 0.2.1-rc.5。** 声明为 `engines.dsh >= 0.2.1-rc.5`——这是宿主插件闸门真正读取的字段。代码里的 `agents.store` / `session.events` 回退属于**防御性兼容，不是受支持的配置**：0.1.x 宿主在跑这些代码之前就会拒绝安装。

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

同一个 bundle 同时服务**桌面版**与 `dsh web` 界面：host 半侧（改动台账 + `/api/dsh-workspace-studio/*` 路由）加 client 半侧（会话标签栏里的 **Studio** 视图）。桌面版渲染的就是同一套 web 客户端，区别只在于装进哪个 profile。

### 桌面版（推荐）

1. **设置 → 插件 → 安装**，来源填 `github:houlain/dsh-workspace-studio`。
2. **完全退出桌面版再启动**——关窗口不够，宿主进程必须退出。
3. 打开会话，**Studio** 标签会出现在会话标签栏里。

安装器会自动把 bundle 写进 profile 的 `dsh.profile.bundles`，无需手工步骤。若你用手动方式安装（见下），记得自己往那个列表里加 `"dsh-workspace-studio"`。

### `dsh web` 命令行

```sh
dsh plugin --profile web add github:houlain/dsh-workspace-studio
```

然后重启 `dsh web`，打开**新会话**。

> 关于 `dsh.client.inject`：0.1.0 里声明了 `@deepseek-ai/dsh-client-runtime`，0.2.x 宿主并不提供它。该字段是加载/预取元数据（宿主插件作者说明明确写了它不参与 `apply` 排序），所以「它导致 Studio 标签不出现」**没有被浏览器侧实测证实**——移除它的理由只是：解析不到的名字本就不该声明。真正还没做的是端到端桌面验证（打开应用、肉眼确认 Studio 标签）。

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
└── tests/           # 82 个测试（node:test，无测试框架依赖）
```

### HTTP 路由（同源，全部位于 `/api/dsh-workspace-studio/*`）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/dsh-workspace-studio/tree?root=` | GET | 工作区文件树 |
| `/api/dsh-workspace-studio/file?path=` | GET | 文件内容（大小上限） |
| `/api/dsh-workspace-studio/ops?session=` | GET | 改动操作及 hunks（列表视图仅返回未处理项） |
| `/api/dsh-workspace-studio/revert?session=` | POST | 撤回单个 hunk；不带 `op`/`hunk` 时整文件撤回 |
| `/api/dsh-workspace-studio/accept?session=` | POST | 认可单个 hunk |
| `/api/dsh-workspace-studio/clear?session=` | POST | 清空会话改动记录 |
| `/api/dsh-workspace-studio/context?session=` | GET | 会话工作目录 |
| `/api/dsh-workspace-studio/events` | GET (SSE) | 实时改动推送 |

### 安全边界

这些路由注册在宿主的**纯路由载体**上，不在 `/api` 网关的鉴权栅栏之内，因此插件自己做闸。请分清它拦得住什么、拦不住什么：

- **读写都要信任标头**：除 SSE（`EventSource` 设不了头）外，所有路由要求 `x-dsh-workspace-studio: 1` + 回环**IP 字面量**对端（`127.evil.com` 这类主机名一律拒绝）+ 有 `sec-fetch-site` 时必须 `same-origin` + 有 `Origin` 时必须与 `Host` 同源。这挡得住跨站页面与 DNS rebinding。
- **它挡不住本机已在运行的进程**：没有密钥、cookie 或会话绑定，本机程序可以伪造这个头直接访问。**这不是身份认证**——不要把宿主端口暴露到回环之外。
- **路径限定**：所有 `root`/`path` 必须落在已注册工作区（`ctx.workspaceRegistry.list()`）或该会话 `cwd` 内，按统一规范口径比较（Windows 折叠大小写、统一 `/`）。越界一律 `403`。
- **敏感路径即便在工作区内也拒绝**：`.secrets`、`.env`/`.env.*`、`*.key`、`*.pem`、`id_rsa*`、`id_ed25519*`、`credentials*`、`.netrc`，以及 `~/.dsh` 下的一切。
- **写入 fail-closed**：拿不到工作区授权或会话沙箱策略时直接拒绝写/删，绝不回落到部署默认策略。
- **乐观并发是真的了**：写入传宿主的 `FsWriteIntent`（`{kind:'replaceIfVersion', version}`）而不是裸版本号；整文件撤回会先重读并确认基线，基线已被清理时**拒绝**而不覆盖。
- **SSE 有上限**（32）、有保活、卸载时结束，且**载荷不含 sessionId**，只表示"有变化"。

### 数据与持久化

- 改动快照持久化到 `~/.dsh/ws-studio-state.json`：防抖写入、原子替换（`tmp` + `fsync` + 随机后缀 `rename`）、退出时落盘，并在**每次认可/撤回/清空后立即落盘**。
- **`0600` 只是尽力而为**：Windows 上 Node 的 `mode` 不生成 DACL，文件会继承目录 ACL。在意的话请自行收紧 `~/.dsh` 的 ACL（台账是源码全文快照）。
- 容量守卫：每文件 100 条、每条 120 KB（超大操作记为 `truncated` 占位，可见但不可撤回）、全局 2000 条。整文件撤回若原始基线已被裁剪，会**拒绝**而不是猜。
- state 文件损坏或超大时隔离为 `*.corrupt-<ts>` / `*.oversized-<ts>`；校验失败的记录会被丢弃并打日志，丢弃前先把原文件复制成 `*.dropped-<ts>`。

### 沙箱感知

- 撤回写入走 harness 文件系统服务（`ctx.fs`），携带**会话级沙箱策略**（`workspace-write` + 会话工作区根）——会话工作区之外的文件会被 harness 沙箱本身拒绝。
- 文件树与读取同样优先走 `ctx.fs`（无则回退 `node:fs`）。

## 安全与隐私

- **无遥测、无统计、无任何外部网络请求**。所有路由都在本机，插件从不联系第三方服务器。
- 插件**不读取**凭据、API key 或环境密钥——0.3.0 起还会主动拒绝"看起来像凭据"的路径（见上面的敏感名单），即便它在工作区内。
- 磁盘上唯一的数据是改动台账（路径 + 会话中编辑过的文件内容）。请把它当敏感数据处理：它是源码的明文副本。
- 撤回写入仍受 harness 沙箱策略约束；插件在删除任何文件前还会额外确认它落在会话工作区根内。

## 配置

文件树默认忽略常见噪声（`.git`、`node_modules`、`dist`、`build`、锁文件、`coverage` 等）。忽略列表在 `src/core/fileTree.ts`（`DEFAULT_TREE_OPTIONS`），如需自定义请重新构建。

## 开发

要求：**Node.js ≥ 22.6**（测试直接使用 Node 原生 TS type-stripping，无需构建），npm。

```sh
npm install        # 开发依赖：esbuild
npm run build      # 产出 lib/index.js（host）+ lib/client.js（browser）
npm test           # 75 个测试（node --test）
```

给贡献者的注意：

- 浏览器半侧使用 `React.createElement`（无 JSX）。测试是**把组件当普通函数直接调用**（没有渲染器），所以 `npm test` 把 `react` 映射到一个刻意做小的桩：`tests/react-stub/shim.mjs`，由 `tests/react-stub/register.mjs`（`node --import`）挂上。该桩会把函数组件当场展开、像 React 一样摊平 children、并让 hooks 返回初值且不重渲染。它**已提交进仓库**——不要为了跑测试去装真实 `react`，也不要再依赖手搓的 `node_modules/react`。
- 代码必须保持**可擦除语法 TypeScript**（无 enum、无参数属性），以便 Node type-stripping 直接运行测试。
- 相对导入使用显式 `.ts` 扩展名（NodeNext）。

## 已知限制

- **平台**：仅 Windows 验证；Linux/macOS 未测试——请谨慎使用。
- 改动跟踪按会话隔离，且仅覆盖 `write`/`edit` 工具调用。
- diff 为行级 LCS，未做字符级（intra-line）高亮。
- 撤回旧操作的中间分块要求该区域行仍原样存在；重叠的后续编辑会拒绝撤回。
- 整文件撤回恢复到该文件在本会话**第一次**记录操作之前的状态。
- 超大文件（> 2 MB）查看器拒绝打开；超大改动快照（> 120 KB）不可撤回。

## 更新记录

### 0.3.0 — 红队评审 32 条缺陷全修

对 0.2.2 做了对抗式评审（数据 / 安全 / 兼容 / 反例），共 32 条，本版全部修掉。值得知道的几条：

- **工作区里的凭据不再可读**：原先读接口只要求"在工作区内"——只要注册的工作区里放了 `.secrets` 之类的目录，本机任意进程都能借宿主读到里面的 key。现在读也要信任标头，且 `.secrets`/`.env*`/`*.key`/`*.pem`/`id_rsa*`/`credentials*`/`~/.dsh` 一律拒绝（即便在工作区内）。
- **整文件撤回不会再删掉会话前就存在的文件**：基线原为 `ops[0]`，台账裁剪会把它悄悄换成中间状态甚至 `create` 记录——已复现"文件被删、原内容不可恢复"。现在基线取「最早一条仍带内容快照的记录」，没有就拒绝，只有 `created` 记录才允许删，且删除前必须落在会话工作区根内。
- **并发保护真的生效了**：`writeText` 第三参必须是 `{kind:'replaceIfVersion', version}`（宿主 `FsWriteIntent`），传裸版本号会让护栏静默失效。
- **不再假设 `fs.remove` 存在**：rc.5 的 fs seam 没有删除动词，现在要么用 `fs.remove`（未来宿主），要么在**复核沙箱根之后**用 `processPath` + `unlink`。
- **操作改用 `opId` 定位**：裁剪会让数组下标整体前移，原先可能"点第 3 块、改第 1 块"；现在按稳定 id 定位，且已处理的 hunk 会被拒绝。
- **hunk 撤回改为位置优先 + 上下文逐行校验**：多处同内容或上下文不符时**拒绝**，不再改错位置还报成功（"删掉无关空行"那种已复现）。
- **`/ops` 不带 file 不再整份回吐台账**，结果按允许根过滤；`/events` 载荷去掉 sessionId；SSE 限流保活。
- **人点出来的操作会落盘**：认可/撤回/清空过去只在内存，崩溃后已清空的记录会复活。
- **台账加固**：超大快照标 `truncated`；load 严格校验，丢弃记录打日志并另存 `*.dropped-<ts>`。
- **客户端**：所有请求带信任头、检查 `res.ok` 与 `{ok:false}`、切会话重置面板、用序号丢弃过期响应、空/错状态有可读文案。
- **诚实性修正**：README 不再声称"本机其它进程够不到"（能——这不是身份认证），也不再声称 `0600` 在 Windows 上能保护文件（Node 的 mode 不生成 DACL）。

### 0.2.0 — 适配桌面版

- **修掉「client 半侧声明了宿主不提供的包」**：`dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime` 在桌面端的 71 个客户端 entry 里不存在，已移除。**诚实说明**：该字段是加载/预取元数据，本次没有浏览器侧实测，所以「它是 Studio 标签不出现的根因」只是假设、不是已证事实。
- **按宿主的真实契约改正**（兼容评审指出，均对着 `node_modules` 里在跑的插件核实）：子代理父链是 `session.header.parentSession`（不是 `agent.owner`）、事件日志用 `session.snapshotEvents()`（不是 `session.events`）、fs 删除动词是可选 `fs.remove(target, policy)`（不是 `fs.unlink`）。三处都已实现并保留防御性回退。
- **修掉整文件撤回的数据丢失 bug**：`write` 的 `before: null` 既可能是 `operation:'create'`（文件原本不存在），也可能是 `update` 没带基线。0.1.0 一律当"新建"删除——撤回一次覆盖式写入会**删掉原本存在的文件**。现在记录 operation，只有 `create` 才允许删除。
- **改用 `ctx.agents.get(id)`**（0.2.1+），旧宿主自动回退 `ctx.agents.store`——会话 `cwd` 与轮次识别在两边都能工作。
- **路由改为在 `ctx.effect` 内注册并返回释放函数**：热重载/卸载不再残留重复的 `/api/dsh-workspace-studio/*` 注册（桌面版是在原进程内重载插件的）。
- **补上 `peerDependencies`**（`@deepseek-ai/cordis`、`react`）与 **`engines.dsh >= 0.2.1-rc.5`**，宿主不兼容时能明确报出来，而不是静默失败。
- **测试在干净克隆上可跑**：`tests/react-stub/` 补上了客户端测试一直依赖的 React 桩；新增 `tests/agents.test.ts` 覆盖两种 agents 访问器形状。共 82 个测试全部通过。

### 0.2.0 — 安全与稳定性加固

第一版 0.2.0 只修了「客户端不激活」。对那一版做对抗式评审（安全 / 兼容 / 稳定）后发现下列问题，本版全部修掉：

- **读接口没有工作区限制**：`?path=` 直接进 `ctx.fs`，本机任意进程都能读任意文件（例如 `~/.dsh/.credentials.yaml`）。现在路径必须落在已注册工作区内，穿越先归一化，越界返回 `403`。
- **写接口没有来源校验**：`revert`/`accept`/`clear` 原先无方法、无来源、无凭据判定。现在只接受 POST，并要求 `x-dsh-workspace-studio` 头 + 回环 + 同源。
- **写入可能回落到部署默认策略**：会话 `cwd` 解析不到时 `sandboxPolicyFor()` 返回 `undefined`，等于交给部署默认（本机是完全访问）。现在写入与删除一律 fail-closed。
- **删除绕过沙箱**：整文件撤回原先直接 `ctx.fs.unlink`，无策略也无授权；现在与写入走同一套工作区校验。
- **撤回没有并发控制**：读文件—内存合并—整文件写回，且把 `ctx.fs` 提供的版本令牌丢弃。现在读前取版本、写入时传入，并发改动会被拒绝而不是被覆盖。
- **请求体上限按字符而非字节计**，超限也不断开连接。现在按字节计 256 KiB、先看 `Content-Length`、超限即断。
- **SSE 连接泄漏**：卸载时只清集合不结束响应（浏览器侧 EventSource 会半死且收不到事件），客户端还每选一个文件就重连一次。现在服务端限 32 条、保活、卸载时结束；客户端每会话只订阅一次。
- **台账膨胀与损坏**：超大操作跳过每文件裁剪导致无上限增长；损坏的 state 会被静默替换成空台账。现在每条记录都裁剪、加了全局 2000 条上限，损坏文件隔离为 `*.corrupt-<ts>` 并在本进程内禁用覆盖写。
- **脏台账记录能打穿路由**：`ops`/`context`/`clear` 没有 try/catch，`load()` 也不校验字段。现在载入时做结构校验，handler 出错返回 `500` 而不是抛给宿主。

### 0.1.0 — 首个版本

- 工作区文件树、代码查看器、`write`/`edit` 的行级 diff、逐块撤回与认可、SSE 实时推送。

## License

[MIT](LICENSE) © 2026 houlain
