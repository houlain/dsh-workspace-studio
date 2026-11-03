// 测试专用 ESM loader：把 `react` 解析到 tests/react-stub/shim.mjs。
// 只在 `npm test`（--import 本目录的 register.mjs）时生效；
// 构建（esbuild，react 为 external）与运行时都不受影响。

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'react') {
    return {
      url: new URL('./shim.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
