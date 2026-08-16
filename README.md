# dsh-workspace-studio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20(verified)-orange)

> ⚠️ **Platform status: Windows verified only.**
> This plugin has been tested on **Windows** (PowerShell). It has **NOT been verified on Linux or macOS** — path handling, shell behavior, and sandbox interactions may differ on those platforms. **Use with caution on non-Windows systems.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that turns the Web UI into a lightweight coding workspace with **Trae-style partial revert**:

1. **Workspace file browser** — collapsible file tree; build-artifact noise filtered; folders containing changed files are auto-expanded with count badges; modified files are marked with a dot.
2. **Code viewer** — click any file to view its content with line numbers.
3. **Change review (git-style diff)** — every `write` / `edit` the agent makes is tracked with full before/after snapshots and rendered as line-level diff hunks, with live SSE updates.
4. **Per-hunk partial revert / accept** — revert **one change block at a time** (like Trae), or mark it as **accepted**; resolved changes stop being shown and stop being marked. Conflict protection rejects reverts when the region was modified afterwards.

---

## ⚠️ Important notes

- **Windows-only (verified).** Linux/macOS are **unverified** — use at your own risk on those platforms.
- Change tracking is **per session** — a session only sees its own changes (by design).
- Only `write` / `edit` tool calls are tracked. Direct file edits made outside those tools (e.g. in your own editor) are not recorded.

## Install

### From GitHub (recommended)

```sh
dsh plugin --profile web add github:houlain/dsh-workspace-studio
```

Then restart `dsh web` and open a **new session**.

### Manually (no pnpm required)

1. Copy the package into the profile's `node_modules`:

   ```powershell
   $src = "<your-clone-path>\dsh-workspace-studio"
   $dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-workspace-studio"
   Copy-Item -Recurse -Force $src $dst
   ```

2. Register it in the profile's `package.json`:

   ```json
   {
     "dependencies": { "dsh-workspace-studio": "0.1.0" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-workspace-studio"] } }
   }
   ```

3. Restart `dsh web`.

> The package ships pre-built (`lib/`), so no build step is needed for installation.
> The installed copy must be a **copy**, not a symlink into a directory you keep editing — rebuild and re-copy after updating.

## Usage

1. Open a session in the Web UI and switch to the **「Studio」** tab (next to Chat).
2. The left pane shows the workspace file tree:
   - Folders are collapsible (`▸` / `▾`); folders containing pending changes show a **count badge** and auto-expand.
   - Files modified by the agent carry a **●** marker.
3. Click a file to view its content (top-right) and its change panel (bottom-right).
4. Each change operation shows one or more **change blocks (hunks)** with two actions:
   - **「撤回此块」(Revert this block)** — undoes only that block; other blocks stay. A confirm dialog appears, then the file is rewritten on disk.
   - **「认可」(Accept)** — keeps the change; the block stops being shown/marked and can no longer be reverted.
5. **「撤回全部修改」(Revert all)** restores the file to its state before this session's first recorded change (files created in this session are deleted).
6. **「清空」(Clear)** removes this session's change records (does not touch file contents).
7. The **Studio tab label** shows a badge with the number of files that still have pending changes; it and all markers update in real time via SSE when the agent edits files.

### Revert safety rules

- A hunk can only be reverted if **its exact lines are still present** in the file. If a later change modified that region, the revert is **rejected with a hint** (conflict protection).
- A hunk that was reverted or accepted cannot be acted on again.
- Reverting a hunk of an old operation works even when later operations shifted line numbers elsewhere.

## Architecture

One package, two halves (`dsh.bundle` + `dsh.client` manifests), mounted as a **single** loader entry:

```
dsh-workspace-studio/
├── src/
│   ├── core/        # Pure logic, zero deps, fully unit-tested
│   │   ├── diff.ts       # LCS line diff → hunks with context
│   │   ├── ledger.ts     # before/after snapshot ledger + persistence
│   │   ├── hunkRevert.ts # per-hunk reverse apply + conflict detection
│   │   └── fileTree.ts   # tree builder with ignore rules
│   ├── host/        # Node half: tools/result listener, HTTP/SSE routes, ctx.fs
│   ├── client/      # Browser half: Studio view (React, no external deps)
│   └── shared/      # Payload types shared by both halves
├── lib/             # Pre-built bundles (lib/index.js host, lib/client.js browser)
└── tests/           # 67 tests (node:test, no test framework dependency)
```

### HTTP routes (same-origin, all under `/ws-studio/*`)

| Route | Method | Purpose |
|---|---|---|
| `/ws-studio/tree?root=` | GET | Workspace file tree |
| `/ws-studio/file?path=` | GET | File content (size-capped) |
| `/ws-studio/ops?session=` | GET | Change operations with hunks (pending only in the file list) |
| `/ws-studio/revert?session=` | POST | Revert one hunk, or the whole file (no `op`/`hunk`) |
| `/ws-studio/accept?session=` | POST | Accept one hunk |
| `/ws-studio/clear?session=` | POST | Clear the session's change records |
| `/ws-studio/context?session=` | GET | Session working directory |
| `/ws-studio/events` | GET (SSE) | Live change notifications |

### Data & persistence

- Change snapshots persist to `<profile-dir>/ws-studio-state.json` (e.g. `~/.dsh/profiles/web/ws-studio-state.json`), debounced, atomic write, flushed on exit.
- Per-file capacity guards: max 100 operations per file, 120 KB per snapshot (oversized operations are recorded without content — visible but not revertible).

### Sandbox awareness

- Revert writes go through the harness filesystem service (`ctx.fs`) with a **session-level sandbox policy** (`workspace-write` + the session's workspace root), so writes outside the session workspace are rejected by the harness sandbox itself.
- File tree and reads also go through `ctx.fs` when available (fallback: `node:fs`).

## Security & privacy

- **No telemetry, no analytics, no external network calls.** All routes are same-origin; the plugin never contacts any third-party server.
- The plugin does **not** read or store credentials, API keys, environment secrets, or OS/user metadata.
- The only data stored on disk is the change ledger (file paths + file contents that were edited during a session) plus UI state.
- Sandbox policies of the harness still apply to revert writes.

## Configuration

The file tree ignores common noise by default (`.git`, `node_modules`, `dist`, `build`, lockfiles, `coverage`, etc.). The ignore list lives in `src/core/fileTree.ts` (`DEFAULT_TREE_OPTIONS`) — rebuild if you want to customize it.

## Development

Requirements: **Node.js ≥ 22.6** (tests run via Node's native TypeScript type-stripping — no build needed for tests), npm.

```sh
npm install        # dev dependency: esbuild
npm run build      # bundles lib/index.js (host) + lib/client.js (browser)
npm test           # 67 tests via node --test
```

Notes for contributors:

- The browser half uses `React.createElement` (no JSX) and a tiny local `react` stub under `node_modules/react` so tests can assert the rendered element tree without a DOM. Do **not** delete the stub; a real `npm install react` would replace it.
- Code must stay **erasable-syntax TypeScript** (no enums, no parameter properties) so Node's type-stripping can run the tests directly.
- Relative imports use explicit `.ts` extensions (NodeNext).

## Known limitations

- **Platform**: verified on Windows only; Linux/macOS untested — use with caution.
- Change tracking is per-session and covers only `write`/`edit` tool calls.
- Diff is line-based LCS; hunk display is simplified (no intra-line character diff).
- Reverting a middle hunk of an old operation requires the region's lines to still be intact; overlapping later edits reject the revert.
- Whole-file revert restores the state before the session's *first* recorded operation on that file.
- Very large files (> 2 MB) are refused by the viewer; oversized change snapshots (> 120 KB) are not revertible.

## License

[MIT](LICENSE) © 2026 houlain
