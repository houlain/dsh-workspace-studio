// 浏览器半侧插件入口：注册 Studio 视图标签。
// 构建后由 __ModuleLoader__ 装载；React 由 DSH shell 提供。

import * as React from 'react';
import { StudioView } from './view.ts';

export const inject = ['slots'];

interface SlotsLike {
  inject(name: string, fn: () => unknown): unknown;
  register(desc: unknown, render?: (props: { sessionId?: string }) => unknown): unknown;
}

interface CtxLike {
  effect(fn: () => (() => void) | void, label?: string): unknown;
  slots: SlotsLike;
}

/**
 * 槽位错误边界。
 *
 * 宿主的会话标签栏没有为插件视图兜底：一个插件组件抛错会把**整条标签栏**渲染成空白
 * （Studio 标签没了，其它标签也一起没了）。所以这里像 crossfire 那样自己包一层边界，
 * 只让本插件的视图降级，不影响宿主和其它插件。
 */
class SlotBoundary extends React.Component<{ children?: unknown }, { failed: boolean }> {
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  constructor(props: { children?: unknown }) {
    super(props);
    this.state = { failed: false };
  }

  render(): unknown {
    if (this.state.failed) {
      return React.createElement(
        'div',
        { className: 'wss-empty' },
        'Studio 渲染失败（插件已隔离，不影响其它标签）。请把日志反馈给插件作者。',
      );
    }
    return this.props.children;
  }
}

/** 注册时统一套上边界。 */
function withSlotBoundary(Inner: (props: { sessionId?: string }) => unknown) {
  const Wrapped = (props: { sessionId?: string }) =>
    React.createElement(SlotBoundary, null, React.createElement(Inner, props));
  Wrapped.displayName = 'WorkspaceStudioBoundary';
  return Wrapped;
}

const CSS = `
.wss-view { flex:1 1 0; min-height:0; overflow:hidden; display:flex; flex-direction:column; padding:10px 12px; box-sizing:border-box; font-size:13px; }
.wss-head { display:flex; align-items:center; gap:8px; padding:2px 0 8px; border-bottom:1px solid rgba(128,128,128,0.3); }
.wss-title { font-weight:600; }
.wss-root { opacity:0.6; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:40%; }
.wss-spacer { flex:1; }
.wss-btn { border:none; background:rgba(128,128,128,0.12); color:inherit; cursor:pointer; border-radius:6px; padding:3px 8px; font-size:12px; }
.wss-btn:hover { background:rgba(128,128,128,0.25); }
.wss-btn:disabled { opacity:0.45; cursor:default; }
.wss-btn-danger { color:#cf222e; }
.wss-notice { font-size:12px; color:#1a7f37; background:rgba(46,160,67,0.15); border-radius:6px; padding:2px 8px; }
.wss-error { font-size:12px; color:#cf222e; background:rgba(207,34,46,0.12); border-radius:6px; padding:2px 8px; }
.wss-body { flex:1; display:flex; min-height:0; margin-top:8px; gap:8px; }
.wss-pane { border:1px solid rgba(128,128,128,0.3); border-radius:8px; overflow:hidden; min-height:0; }
.wss-pane-tree { width:230px; flex-shrink:0; overflow:auto; padding:4px 0; }
.wss-pane-main { flex:1; display:flex; flex-direction:column; min-width:0; }
.wss-tree-dir { font-weight:600; padding:3px 8px; opacity:0.85; font-size:12px; }
.wss-tree-file { display:block; width:100%; text-align:left; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:12.5px; padding:3px 8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wss-tree-file:hover { background:rgba(128,128,128,0.12); }
.wss-tree-file.wss-selected { background:rgba(80,120,255,0.2); }
.wss-modified { color:#ff7fae; font-weight:600; }
.wss-dot { margin-left:6px; font-size:9px; color:#ff5c8a; }
.wss-tab-label { display:inline-flex; align-items:center; gap:6px; }
.wss-tab-badge { display:inline-block; border-radius:8px; padding:0 5px; font-size:10px; line-height:14px; font-weight:600; min-width:16px; text-align:center; background:rgba(255,92,138,0.25); color:#ff5c8a; }
.wss-tree-dir { font-weight:600; font-size:12px; }
.wss-tree-dir-head { display:flex; align-items:center; gap:4px; width:100%; text-align:left; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:12.5px; padding:3px 8px; }
.wss-tree-dir-head:hover { background:rgba(128,128,128,0.12); }
.wss-chevron { width:12px; flex-shrink:0; opacity:0.7; font-size:10px; }
.wss-dir-badge { margin-left:6px; font-size:10px; line-height:14px; padding:0 5px; border-radius:8px; background:rgba(255,92,138,0.22); color:#ff5c8a; font-weight:600; }
.wss-empty { padding:18px; text-align:center; opacity:0.6; font-size:12px; }
.wss-viewer { flex:0 0 45%; min-height:0; display:flex; flex-direction:column; border-bottom:1px solid rgba(128,128,128,0.3); }
.wss-viewer-head { display:flex; gap:8px; align-items:center; padding:6px 10px; border-bottom:1px solid rgba(128,128,128,0.2); }
.wss-path { font-size:11.5px; opacity:0.8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wss-hint { font-size:11px; opacity:0.6; }
.wss-viewer-body { flex:1; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
.wss-code-line { display:flex; line-height:1.55; white-space:pre; }
.wss-code-line:hover { background:rgba(128,128,128,0.08); }
.wss-gutter { flex:0 0 40px; text-align:right; padding:0 6px; user-select:none; opacity:0.8; }
.wss-text { flex:1; padding:0 6px; }
.wss-diff { flex:1; min-height:0; overflow:auto; padding:8px 10px; }
.wss-diff-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.wss-op { margin-bottom:10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px; overflow:hidden; }
.wss-op-head { display:flex; gap:8px; align-items:center; padding:5px 10px; background:rgba(128,128,128,0.1); font-weight:600; }
.wss-op-meta { font-weight:400; opacity:0.7; font-size:11px; }
.wss-hunk { border-top:1px solid rgba(128,128,128,0.2); }
.wss-hunk-head { display:flex; gap:8px; align-items:center; padding:4px 10px; font-size:11px; opacity:0.85; }
.wss-hunk-done { color:#1a7f37; }
.wss-hunk-accepted { color:#0969da; }
.wss-btn-accept { color:#0969da; }
.wss-hunk-resolved { opacity:0.75; }
.wss-hunk-resolved .wss-hunk-head { background:rgba(128,128,128,0.06); }
.wss-row { display:flex; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.55; white-space:pre-wrap; word-break:break-all; }
.wss-add { background:rgba(46,160,67,0.18); }
.wss-del { background:rgba(207,34,46,0.16); }
.wss-ctx { background:transparent; }
.wss-sign { flex-basis:18px; text-align:center; }
`;

export function apply(ctx: CtxLike): void {
  ctx.effect(() => {
    if (typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.textContent = CSS;
    document.head.appendChild(el);
    return () => el.remove();
  }, 'ws-studio: styles');
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'studio',
        order: 6,
        // label 必须是**字符串**：返回 React 元素会让宿主标签栏渲染失败（实测会把整条
        // 标签栏渲染成空白，其它标签一起消失）。对照 crossfire 的可用实现也是返回字符串。
        label: () => 'Studio',
      },
      withSlotBoundary((props) => React.createElement(StudioView, props)),
    ),
  );
}
