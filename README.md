# dsh-workspace-studio

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20(verified)-orange)

> ⚠️ **Platform status: Windows verified only.**
> This plugin has been tested on **Windows** (PowerShell). It has **NOT been verified on Linux or macOS** — path handling, shell behavior, and sandbox interactions may differ on those platforms. **Use with caution on non-Windows systems.**

> ✅ **Host compatibility: DSH Desktop 0.2.1-rc.5.** Declared as `engines.dsh >= 0.2.1-rc.5`, which is the requirement the host's own plugin gate actually reads. The `agents.store` / `session.events` fallbacks in the code are **defensive, not a supported configuration** — a 0.1.x host refuses the install before any of that code runs.

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

One bundle serves **both** the Desktop app and the `dsh web` UI: a host half (change ledger + `/api/dsh-workspace-studio/*` routes) and a client half (the **Studio** view in the conversation tab strip). The Desktop app renders the same web client, so the only difference is which profile you install into.

### Desktop app (recommended)

1. **Settings → Plugins → install** and give it the git source `github:houlain/dsh-workspace-studio`.
2. **Fully quit and restart the desktop app** — closing the window is not enough, the host process must exit.
3. Open a session: the **Studio** tab shows up next to the conversation tabs.

The installer registers the bundle in the profile's `dsh.profile.bundles` for you; no manual step is needed. If you install by hand (below), add `"dsh-workspace-studio"` to that list yourself.

### `dsh web` CLI

```sh
dsh plugin --profile web add github:houlain/dsh-workspace-studio
```

Then restart `dsh web` and open a **new session**.

> Note on `dsh.client.inject`: 0.1.0 declared `@deepseek-ai/dsh-client-runtime`, which no 0.2.x host provides. That list is loading/prefetch metadata — the host's plugin-author notes say it never sequences `apply` — so whether the stale entry actually blocked activation **was not proven** by a browser-side test; it is removed because a name that resolves to nothing has no reason to be declared. What is still unverified is the end-to-end desktop check (opening the app and seeing the **Studio** tab).

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
└── tests/           # 82 tests (node:test, no test framework dependency)
```

### HTTP routes (same-origin, all under `/api/dsh-workspace-studio/*`)

| Route | Method | Purpose |
|---|---|---|
| `/api/dsh-workspace-studio/tree?root=` | GET | Workspace file tree |
| `/api/dsh-workspace-studio/file?path=` | GET | File content (size-capped) |
| `/api/dsh-workspace-studio/ops?session=` | GET | Change operations with hunks (pending only in the file list) |
| `/api/dsh-workspace-studio/revert?session=` | POST | Revert one hunk, or the whole file (no `op`/`hunk`) |
| `/api/dsh-workspace-studio/accept?session=` | POST | Accept one hunk |
| `/api/dsh-workspace-studio/clear?session=` | POST | Clear the session's change records |
| `/api/dsh-workspace-studio/context?session=` | GET | Session working directory |
| `/api/dsh-workspace-studio/events` | GET (SSE) | Live change notifications |

### Security boundaries

These routes are registered on the host's route carrier, **not** behind the `/api` gateway's auth fence, so the plugin enforces its own fences. Be precise about what they are and are not:

- **Reads and writes both require a trust header.** Every route except the SSE stream (`EventSource` cannot set headers) requires `x-dsh-workspace-studio: 1`, a loopback peer **IP literal** (a hostname such as `127.evil.com` is rejected), `sec-fetch-site: same-origin` when present, and `Origin` matching `Host` when present. This stops cross-site pages and DNS rebinding.
- **What it does not stop: any process already running on this machine.** There is no secret, cookie or session binding, so a local program can forge the header and reach the routes. This is **not authentication** — do not expose the host port beyond loopback.
- **Path confinement.** Every `root`/`path` must resolve inside a registered workspace (`ctx.workspaceRegistry.list()`) or the requesting session's `cwd`, compared through one canonical path form (Windows case-folded, `/`-unified). Anything else is `403`.
- **Sensitive paths are refused** even inside a workspace: anything under `.secrets`, `.env`/`.env.*`, `*.key`, `*.pem`, `id_rsa*`, `id_ed25519*`, `credentials*`, `.netrc`, or anywhere under `~/.dsh`.
- **Writes are fail-closed.** Without both workspace authorization and a session sandbox policy, the service refuses to write or delete; it never falls back to the deployment default policy.
- **Optimistic concurrency.** A vetting write passes `{kind:'replaceIfVersion', version}` (the host's `FsWriteIntent`), so a concurrent agent write is rejected instead of silently overwritten. Whole-file revert re-reads and verifies a baseline first; it refuses rather than overwrite when the original snapshot was pruned.
- **SSE is capped** (32 clients), keep-alive pinged, ended on unload, and **carries no session id** — it only signals "something changed".

### Data & persistence

- Change snapshots persist to `~/.dsh/ws-studio-state.json`: debounced, atomic write (`tmp` + `fsync` + `rename` with a random suffix), flushed on exit and after every accept/revert/clear action.
- **`0600` is best-effort**: on Windows Node's `mode` does not create a DACL, so the file inherits the directory's ACL. If that matters on your machine, tighten the ACL on `~/.dsh` yourself (the ledger holds full-text snapshots of edited files).
- Per-file capacity guards: max 100 operations per file, 120 KB per snapshot (oversized operations are recorded as a `truncated` placeholder — visible but not revertible); plus a global cap of 2000 operations. A whole-file revert whose original baseline was pruned away is **refused** — it will not guess.
- A corrupt or oversized state file is **quarantined** (`*.corrupt-<ts>` / `*.oversized-<ts>`); records that fail validation are dropped with a log and the original file is copied to `*.dropped-<ts>` first.

### Sandbox awareness

- Revert writes go through the harness filesystem service (`ctx.fs`) with a **session-level sandbox policy** (`workspace-write` + the session's workspace root), so writes outside the session workspace are rejected by the harness sandbox itself.
- File tree and reads also go through `ctx.fs` when available (fallback: `node:fs`).

## Security & privacy

- **No telemetry, no analytics, no external network calls.** All routes are served locally; the plugin never contacts any third-party server.
- The plugin does **not** read credentials, API keys or environment secrets — and since 0.3.0 it actively refuses paths that look like them (see the sensitive-path list above), even when they sit inside a workspace.
- The only data stored on disk is the change ledger (paths + the file contents that were edited in a session). Treat it as sensitive: it is a plaintext copy of your source files.
- Harness sandbox policies still apply to revert writes; the plugin additionally enforces the session workspace root before deleting anything.

## Configuration

The file tree ignores common noise by default (`.git`, `node_modules`, `dist`, `build`, lockfiles, `coverage`, etc.). The ignore list lives in `src/core/fileTree.ts` (`DEFAULT_TREE_OPTIONS`) — rebuild if you want to customize it.

## Development

Requirements: **Node.js ≥ 22.6** (tests run via Node's native TypeScript type-stripping — no build needed for tests), npm.

```sh
npm install        # dev dependency: esbuild
npm run build      # bundles lib/index.js (host) + lib/client.js (browser)
npm test           # 82 tests via node --test
```

Notes for contributors:

- The browser half uses `React.createElement` (no JSX). Tests call components **as plain functions** (no renderer), so `npm test` maps `react` to a deliberately tiny stub: `tests/react-stub/shim.mjs`, wired in by `tests/react-stub/register.mjs` (`node --import`). The stub expands function components eagerly, flattens children like React, and makes hooks return their initial value without re-rendering. It is **committed and versioned** — never install a real `react` into the repo just to run tests, and never rely on a hand-made `node_modules/react`.
- Code must stay **erasable-syntax TypeScript** (no enums, no parameter properties) so Node's type-stripping can run the tests directly.
- Relative imports use explicit `.ts` extensions (NodeNext).

## Known limitations

- **Platform**: verified on Windows only; Linux/macOS untested — use with caution.
- Change tracking is per-session and covers only `write`/`edit` tool calls.
- Diff is line-based LCS; hunk display is simplified (no intra-line character diff).
- Reverting a middle hunk of an old operation requires the region's lines to still be intact; overlapping later edits reject the revert.
- Whole-file revert restores the state before the session's *first* recorded operation on that file.
- Very large files (> 2 MB) are refused by the viewer; oversized change snapshots (> 120 KB) are not revertible.

## Changelog

### 0.3.0 — adversarial review fixes (32 defects)

An adversarial review of 0.2.2 (data / security / compatibility / counter-example) produced 32 defects. All are fixed here; the ones worth knowing:

- **Credentials inside a workspace are no longer readable.** Reads used to be gated only by "inside the workspace", so a `.secrets/` directory inside the registered workspace would be served to any local process. Reads now require the trust header, and a sensitive-path list (`.secrets`, `.env*`, `*.key`, `*.pem`, `id_rsa*`, `credentials*`, `~/.dsh`) is refused even inside a workspace.
- **Whole-file revert can no longer delete a pre-existing file.** The revert baseline used to be `ops[0]`, which ledger pruning can silently turn into an intermediate (or a `create`) record — reproduced: file deleted, original content unrecoverable. The baseline is now "the earliest record that still carries a content snapshot"; missing snapshot → refuse; only `created` records may delete; deletion is confined to the session workspace root.
- **Writes now actually use the host's concurrency guard.** `writeText`'s third argument must be `{kind:'replaceIfVersion', version}`; passing a bare version silently disabled the guard.
- **Deletion no longer assumes a non-existent `fs.remove`.** The 0.2.1-rc.5 fs seam has no delete verb, so deletion either uses `fs.remove` (future hosts) or `processPath` + `unlink` after re-verifying the sandbox root.
- **Operations are addressed by `opId`,** not array index: pruning shifts indices and could revert/accept the wrong block. Revert now also refuses already-handled hunks.
- **Hunk revert locates by position first and verifies surrounding context;** ambiguous or missing context is refused instead of editing the wrong occurrence (reproduced: removing an unrelated blank line while reporting success).
- **`/ops` without a `file` filter no longer dumps the session ledger;** results are filtered to allowed roots. `/events` carries no session id. SSE capped and keep-alive pinged.
- **User actions are persisted.** Accept/revert/clear used to be memory-only until the next agent write — a crash resurrected cleared records.
- **Ledger hardening:** `truncated` flag for oversized snapshots, strict validation on load (dropped records logged and backed up to `*.dropped-<ts>`).
- **Client:** all requests carry the trust header, `res.ok`/`{ok:false}` are checked, switching sessions resets the panel, stale responses are discarded by sequence number, and empty/error states have readable text.
- **Honesty fixes:** README no longer claims "another local process cannot reach the routes" (it can — this is not authentication), nor that `0600` guarantees file protection on Windows (Node's mode sets no DACL).

### 0.2.0 — desktop support

- **Fixed: the client half declared a package no 0.2.x host ships.** `dsh.client.inject` named `@deepseek-ai/dsh-client-runtime`, which does not exist in the desktop app's 71 client entries. The entry is removed. Honesty note: that list is loading/prefetch metadata, and a browser-side test was not available here, so "it was why the Studio tab never appeared" is a hypothesis, not a proven root cause.
- **Corrected the real host contracts** (found by the compatibility review, all verified against working plugins in `node_modules`): subagent lineage is `session.header.parentSession` (not `agent.owner`), event logs come from `session.snapshotEvents()` (not `session.events`), and the fs delete verb is the optional `fs.remove(target, policy)` (not `fs.unlink`). All three are implemented with defensive fallbacks.
- **Fixed a data-loss bug in whole-file revert**: `write` reports `before: null` both for `operation: 'create'` and for an `update` that carried no baseline. 0.1.0 treated both as "new file" and deleted it — reverting an overwriting write destroyed a pre-existing file. The operation is now recorded, and only `create` may delete.
- **`ctx.agents.get(id)`** is used when present (0.2.1+), with a fallback to `ctx.agents.store` — the fallback is defensive; the host gate refuses older hosts outright.
- **Declared `peerDependencies`** (`@deepseek-ai/cordis`, `react`) and **`engines.dsh >= 0.2.1-rc.5`**. Note which one is real: the host's compatibility gate reads `engines.dsh` (and DSH peer package names), so the peers are documentation — under the profile's `autoInstallPeers: false` they surface as pnpm warnings, not as an install gate.
- **Routes are registered inside `ctx.effect`** and now return a disposer, so hot reload / unload no longer leaves duplicate `/api/dsh-workspace-studio/*` registrations behind (the desktop app reloads plugins in place).
- **Declared `peerDependencies`** (`@deepseek-ai/cordis`, `react`) and **`engines.dsh >= 0.2.1-rc.5`** so an incompatible host is reported instead of failing quietly.
- **Tests runnable from a clean clone**: `tests/react-stub/` provides the React stub the client tests always assumed, and `tests/agents.test.ts` covers both `agents` accessor shapes. 82 tests, all passing.

### 0.2.0 — security and stability hardening

The first cut of 0.2.0 only fixed the client activation bug. An adversarial review of that cut (security / compatibility / stability) found the following; all of them are fixed here:

- **Reads were not confined to a workspace.** `?path=` went straight to `ctx.fs`, so any local process could read any file (for example `~/.dsh/.credentials.yaml`). Paths are now confined to registered workspaces, traversal is normalized first, and out-of-workspace requests get `403`.
- **Writes had no origin check.** `revert`/`accept`/`clear` were plain GET/POST with no trust decision. They are now POST-only and require the `x-dsh-workspace-studio` header plus a loopback, same-origin request.
- **Writes could fall back to the deployment default policy.** When the session `cwd` was unknown, `sandboxPolicyFor()` returned `undefined`, handing the write to whatever policy the deployment used (possibly full access). Writes and deletes are now fail-closed.
- **Deletion bypassed the sandbox entirely.** Whole-file revert called `ctx.fs.unlink` with no policy and no authorization; it now runs through the same workspace check as writes.
- **Hunk revert had no concurrency control.** It read the file, merged in memory and wrote the whole file back, discarding the version token `ctx.fs` offers. The version is now captured before the read and passed to `writeText`, so a concurrent agent write is rejected.
- **Request bodies were capped in characters, not bytes**, and the socket was not destroyed on overflow. The cap is now 256 KiB measured in bytes with a `Content-Length` pre-check and an immediate disconnect.
- **SSE connections leaked.** Unloading cleared the set without ending the responses (the browser's `EventSource` then stayed half-open and received nothing), and the client reconnected on every selected-file change. The server now caps clients at 32, keep-alive pings, ends them on unload; the client subscribes once per session.
- **Ledger growth and corruption.** Oversized operations skipped the per-file prune, so they could grow without bound; a corrupt state file was silently replaced with an empty ledger. Pruning now runs for every record, a global cap (2000) was added, and damaged files are quarantined (`*.corrupt-<ts>`) with writing disabled for the rest of the process.
- **Dirty ledger records could crash a route.** `ops`/`context`/`clear` had no `try/catch` and `load()` validated nothing; records are now shape-checked on load and the handlers return `500` instead of throwing into the host.

### 0.1.0 — first release

- Workspace tree, code viewer, line-level diff of `write`/`edit`, per-hunk revert and accept, live SSE updates.

## License

[MIT](LICENSE) © 2026 houlain
