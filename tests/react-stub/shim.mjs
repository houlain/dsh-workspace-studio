// 测试专用的 React 桩（仅测试用，不参与构建）。
//
// 这里的客户端测试没有渲染器，所以桩必须自己把"渲染"这件事做出来。为了能表达
// **错误边界**语义（子组件渲染抛错 → 最近一层 `getDerivedStateFromError` 被调用 →
// 渲染降级文案），渲染必须是独立的一遍（不能像早期版本那样在 createElement 里
// 当场 `new + render()`）：
//
//   1. `createElement` 只造**惰性元素**（`{type, props}`），不执行任何组件；
//   2. `renderTree(el)` 才真正渲染：函数组件直接调用、类组件实例化后 `render()`，
//      并把产出继续递归渲染下去；
//   3. 任一层抛错都沿调用栈向上冒泡，直到最近的"错误边界"类组件接住它——和 React
//      的 fiber 回溯一致；边界接住后调用 `getDerivedStateFromError`、合并 state、
//      再渲染一次（此时应产出降级界面）。
//
// hooks 退化为「返回初值 + 不重渲染」，与"桩只验结构、不验调度"的定位一致。

export const Fragment = Symbol.for('react.fragment');

/** React 会把嵌套的 children 数组摊平，并丢掉 null/undefined/布尔值；这里照做。 */
function flatten(kids, out = []) {
  if (Array.isArray(kids)) {
    for (const k of kids) flatten(k, out);
    return out;
  }
  if (kids === null || kids === undefined || typeof kids === 'boolean') return out;
  out.push(kids);
  return out;
}

function isClassComponent(type) {
  return typeof type === 'function' && !!(type.prototype && type.prototype.isReactComponent);
}

/**
 * 元素构造：只造节点，不渲染。
 * - 宿主元素（type 是字符串）、函数组件、类组件、Fragment 一律惰性表示；
 * - children 摊平成数组（测试里的遍历代码依赖它是数组）。
 */
export function createElement(type, props, ...children) {
  const given = props && Object.prototype.hasOwnProperty.call(props, 'children');
  const raw = given ? props.children : children.length <= 1 ? children[0] : children;
  const finalProps = { ...(props ?? {}), children: flatten(raw) };
  return { type, props: finalProps };
}

// ── 渲染统计：边界是否真的接住了错误（测试可直接断言） ─────────────────
const renderStats = { boundaryCatches: 0, rendered: 0 };

export function resetRenderState() {
  renderStats.boundaryCatches = 0;
  renderStats.rendered = 0;
}

export function getRenderStats() {
  return { ...renderStats };
}

/**
 * 渲染入口：把惰性元素树展开成一棵**只含宿主元素**的树。
 * 测试用它替代真实渲染器（`collect` / `collectText` 都基于它的产出）。
 */
export function renderTree(node) {
  return resolve(node);
}

function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      const r = resolve(item);
      if (r === null || r === undefined) continue;
      if (Array.isArray(r)) out.push(...r);
      else out.push(r);
    }
    return out;
  }
  if (typeof node !== 'object') return node;

  const type = node.type;
  const props = node.props ?? {};

  if (type === Fragment) return resolve(props.children);
  if (isClassComponent(type)) return resolveClass(type, props);
  if (typeof type === 'function') {
    renderStats.rendered += 1;
    // 函数组件抛错不在这里接：交给上层最近的边界（与 React 一致）
    return resolve(type(props));
  }
  // 宿主元素：渲染 children
  return { ...node, type, props: { ...props, children: flatten(resolve(props.children)) } };
}

/**
 * 类组件：渲染一次；抛错时若本类声明了 `getDerivedStateFromError`（或
 * `componentDidCatch`），就按边界语义接住——调用静态方法、合并 state、重渲染，
 * 二次渲染通常给出降级界面。二次仍抛错则继续向上冒泡。
 */
function resolveClass(type, props) {
  const instance = new type(props);
  instance.props = props;
  if (instance.state === null || typeof instance.state !== 'object') instance.state = {};

  const hasDerived = typeof type.getDerivedStateFromError === 'function';
  const hasDidCatch = typeof instance.componentDidCatch === 'function';
  renderStats.rendered += 1;

  // 注意：`render()` 自己抛错不会被**自己**接住（与 React 一致）——边界只负责子树，
  // 所以只有"渲染子树"这一步在 try 里。
  const output = instance.render();
  try {
    return resolve(output);
  } catch (error) {
    if (!hasDerived && !hasDidCatch) throw error;
    if (hasDerived) {
      const patch = type.getDerivedStateFromError(error);
      if (patch && typeof patch === 'object') instance.state = { ...instance.state, ...patch };
    }
    if (hasDidCatch) {
      try {
        instance.componentDidCatch(error, { componentStack: '' });
      } catch {
        // 边界自身的 componentDidCatch 抛错不影响降级渲染
      }
    }
    renderStats.boundaryCatches += 1;
    // 注意：这一次渲染**不在** try 里——降级界面自己再抛错就继续往上冒泡。
    return resolve(instance.render());
  }
}

/** 最小的类组件基类：错误边界等类组件要 `extends React.Component`。 */
export class Component {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    if (next && typeof next === 'object') this.state = { ...this.state, ...next };
  }
}
Component.prototype.isReactComponent = {};

/** 返回初值；不重渲染（直接调用组件时不存在调度器）。 */
export function useState(initial) {
  const value = typeof initial === 'function' ? initial() : initial;
  return [value, () => {}];
}

export function useReducer(reducer, initialArg) {
  const value = typeof initialArg === 'function' ? initialArg(initialArg) : initialArg;
  return [value, () => {}];
}

/** 直接调用组件时不执行副作用：避免测试里出现未预期的异步 fetch/订阅。 */
export function useEffect() {}
export function useLayoutEffect() {}
export function useInsertionEffect() {}

export function useMemo(fn) {
  return fn();
}

export function useRef(value) {
  return { current: value };
}

export function useCallback(fn) {
  return fn;
}

export function useContext(context) {
  return context ? context._currentValue : undefined;
}

export function createContext(defaultValue) {
  return { Provider: Fragment, Consumer: Fragment, _currentValue: defaultValue };
}

export function isValidElement(value) {
  return !!value && typeof value === 'object' && 'type' in value && 'props' in value;
}

/** 兼容旧测试桩：清空模块级状态。 */
export function resetState() {
  resetRenderState();
}

export const version = '18.0.0-test-stub';

export default {
  Fragment,
  createElement,
  renderTree,
  resetRenderState,
  getRenderStats,
  Component,
  useState,
  useReducer,
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useCallback,
  useContext,
  createContext,
  isValidElement,
  resetState,
  version,
};
