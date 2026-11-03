// host 侧 agents 适配层测试：0.2.1 的 get(id) 与旧版 store 两种形状都要能工作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentOf, currentTurnOf, newTurnCursor, resolveRootId } from '../src/host/agents.ts';
import type { AgentEntryLike, AgentsLike } from '../src/host/types.ts';

const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

test('agents.agentOf: 优先用新访问器 get(id)', () => {
  const direct = agent('s1', { session: { header: { cwd: '/w1' } } });
  const legacy = { agent: agent('s1', { session: { header: { cwd: '/w0' } } }) };
  const agents: AgentsLike = {
    get: (id) => (id === 's1' ? direct : undefined),
    store: new Map([['s1', legacy as AgentEntryLike]]),
  };
  assert.equal(agentOf(agents, 's1')?.session?.header?.cwd, '/w1');
});

test('agents.agentOf: 没有 get() 时回退 store 条目里的 agent（旧宿主）', () => {
  const agents: AgentsLike = {
    store: new Map([['s1', { agent: agent('s1', { session: { header: { cwd: '/legacy' } } }) } as AgentEntryLike]]),
  };
  assert.equal(agentOf(agents, 's1')?.session?.header?.cwd, '/legacy');
  assert.equal(agentOf(agents, 'missing'), undefined);
});

test('agents.agentOf: get() 抛错时不影响回退', () => {
  const agents: AgentsLike = {
    get: () => {
      throw new Error('no inject');
    },
    store: new Map([['s1', { agent: agent('s1', { session: { header: { cwd: '/fallback' } } }) } as AgentEntryLike]]),
  };
  assert.equal(agentOf(agents, 's1')?.session?.header?.cwd, '/fallback');
});

test('agents.resolveRootId: 沿 store 的 owner 链归到根会话（子代理改动归父会话）', () => {
  const store = new Map<string, AgentEntryLike>([
    ['root', { agent: agent('root') }],
    ['child', { owner: { id: 'root' }, agent: agent('child') }],
    ['grand', { owner: { id: 'child' }, agent: agent('grand') }],
  ]);
  assert.equal(resolveRootId({ store }, 'grand'), 'root');
  assert.equal(resolveRootId({ store }, 'root'), 'root');
  assert.equal(resolveRootId({ store }, 'unknown'), 'unknown');
});

test('agents.resolveRootId: 只有 get(id) 时用 agent.owner 链', () => {
  const table: Record<string, ReturnType<typeof agent>> = {
    root: agent('root'),
    child: agent('child', { owner: { id: 'root' } }),
  };
  assert.equal(resolveRootId({ get: (id) => table[id] }, 'child'), 'root');
});

test('agents.resolveRootId: owner 链成环时不死循环', () => {
  const store = new Map<string, AgentEntryLike>([
    ['a', { owner: { id: 'b' }, agent: agent('a') }],
    ['b', { owner: { id: 'a' }, agent: agent('b') }],
  ]);
  const root = resolveRootId({ store }, 'a');
  assert.ok(root === 'a' || root === 'b');
});

test('agents.currentTurnOf: 增量扫描 turn/start 与 turn/end', () => {
  const events: Array<{ type: string; data?: { turn?: number } }> = [{ type: 'turn/start', data: { turn: 3 } }];
  const agents: AgentsLike = { get: () => agent('s1', { session: { events } }) };
  const cursor = newTurnCursor();

  assert.equal(currentTurnOf(agents, 's1', cursor), 3);

  events.push({ type: 'turn/end' });
  assert.equal(currentTurnOf(agents, 's1', cursor), null);
});

test('agents.currentTurnOf: 会话不可读时返回上一次的值而不是抛错', () => {
  const cursor = newTurnCursor();
  cursor.turn = 7;
  cursor.scanSeq = 0;
  assert.equal(currentTurnOf({ store: new Map() }, 'nope', cursor), 7);
});

// ── 0.2.1 真实形状：header.parentSession + snapshotEvents() ─────────────

test('agents.resolveRootId: 0.2.1 用 session.header.parentSession 走父链', () => {
  const table: Record<string, ReturnType<typeof agent>> = {
    root: agent('root', { session: { header: { cwd: '/w' } } }),
    child: agent('child', { session: { header: { parentSession: 'root', delegationDepth: 1 } } }),
    grand: agent('grand', { session: { header: { parentSession: 'child', delegationDepth: 2 } } }),
  };
  const agents: AgentsLike = { get: (id) => table[id] };
  assert.equal(resolveRootId(agents, 'grand'), 'root');
  assert.equal(resolveRootId(agents, 'root'), 'root');
});

test('agents.currentTurnOf: 0.2.1 用 session.snapshotEvents()', () => {
  const events: Array<{ type: string; data?: { turn?: number } }> = [{ type: 'turn/start', data: { turn: 5 } }];
  const agents: AgentsLike = {
    get: () => agent('s1', { session: { snapshotEvents: () => events } }),
  };
  const cursor = newTurnCursor();
  assert.equal(currentTurnOf(agents, 's1', cursor), 5);

  events.push({ type: 'turn/end' });
  assert.equal(currentTurnOf(agents, 's1', cursor), null);
});

test('agents.currentTurnOf: 日志变短（会话压缩/恢复）后游标会重置而不是永久陈旧', () => {
  let events: Array<{ type: string; data?: { turn?: number } }> = [{ type: 'turn/start', data: { turn: 9 } }];
  const agents: AgentsLike = { get: () => agent('s1', { session: { snapshotEvents: () => events } }) };
  const cursor = newTurnCursor();
  assert.equal(currentTurnOf(agents, 's1', cursor), 9);

  // 人为制造失配：游标指向的序号超过当前日志长度
  cursor.scanSeq = 10;
  events = [{ type: 'turn/start', data: { turn: 1 } }];
  assert.equal(currentTurnOf(agents, 's1', cursor), 9, '失配的那一次仍返回旧值');
  assert.equal(cursor.scanSeq, 0, '失配后游标被重置');
  assert.equal(currentTurnOf(agents, 's1', cursor), 1, '下一次重扫后拿到新轮次');
});
