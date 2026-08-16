// 构建脚本：host 半侧 → lib/index.js（ESM/node）；client 半侧 → lib/client.js
// （CJS，包装为 window.__ModuleLoader__.load({id, factory}) 格式，React 保持外部）。
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('lib', { recursive: true });

const CLIENT_ID = 'dsh-workspace-studio';

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'info',
});

// client：factory 内需自行定义 module/exports（浏览器无 CommonJS 全局）
const banner = `window.__ModuleLoader__.load({
\tid: "${CLIENT_ID}",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\t"use strict";`;

const footer = `\t\treturn module.exports;
\t}
});`;

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react'],
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
});

console.log('build ok → lib/index.js (host) + lib/client.js (client)');
