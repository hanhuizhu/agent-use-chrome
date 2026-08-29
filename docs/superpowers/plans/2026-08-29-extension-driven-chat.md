# Extension 驱动聊天 + 面板 UI 重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 MCP 轮询（chat_listen/chat_reply）链路，侧边栏消息全部由 bridge spawn claude CLI headless 处理（忙时排队自动续发），并重设计面板聊天 UI（markdown 渲染 + 流式打字）。

**Architecture:** panel → background → WS → bridge ChatHandler → SessionManager（spawn `claude --resume <id> -p <msg> --output-format stream-json --include-partial-messages`）。SessionManager 维持全局单轮次 + FIFO 队列；流式增量经 `text_delta` 事件推回面板逐段渲染，整块 `text` 事件定稿。

**Tech Stack:** Node 22 + TypeScript（bridge，零新依赖，测试用内置 `node --test`）；Chrome MV3 扩展原生 JS/CSS（无第三方库，markdown 渲染自写）。

**Spec:** `docs/superpowers/specs/2026-08-29-extension-driven-chat-design.md`

## Global Constraints

- 注释、面板文案一律简体中文；bridge 所有日志走 stderr（stdout 被 MCP stdio 占用）
- 不新增任何 npm 依赖、不引入 CDN 资源（MV3 CSP）
- 单文件上限：TS ≤ 600 行、JS ≤ 600 行、单函数 ≤ 50 行
- markdown 渲染必须「先整体 HTML 转义、再做标记替换」，链接仅允许 `http(s)://`
- 权限模式仍只透传三档：`default` / `acceptEdits` / `bypassPermissions`（`plan` 保留在校验集合中即可）
- 每个任务完成即 commit，消息用 `feat:`/`refactor:`/`test:`/`docs:` 前缀
- 构建命令：`cd bridge && npm run build`；测试命令：`cd bridge && npm test`（Task 2 起可用）

---

### Task 1: 删除 MCP 轮询链路（bridge + skill）

**Files:**
- Delete: `bridge/src/chat-hub.ts`
- Delete: `skills/chrome-chat/`（整目录）
- Modify: `bridge/src/protocol.ts`
- Modify: `bridge/src/mcp-server.ts:168-193`（chat 工具段）
- Modify: `bridge/src/index.ts:20-88`
- Modify: `bridge/src/chat-handler.ts`
- Modify: `bridge/src/ws-server.ts:16,190,198-199`
- Modify: `bridge/src/ipc-proxy.ts:12,72`

**Interfaces:**
- Consumes: 现有代码
- Produces: `protocol.ts` 中 `BridgeMethod`/`ChatBridgeMethod`/`ChatLiveListener`/`LISTEN_TIMEOUT_MS` 消失；`BridgeBackend.request(method: BrowserMethod, ...)`；`ChatMethod = 'list_sessions' | 'send' | 'cancel'`；`ChatHandler` 构造函数变为 `constructor(push: PushFn)`。后续任务以此为准。

- [ ] **Step 1: 删除文件**

```bash
git rm bridge/src/chat-hub.ts
git rm -r skills/chrome-chat
```

- [ ] **Step 2: protocol.ts 清理**

删除以下内容：
- 59 行 `ChatMethod` 中的 `'list_live'`（改为 `export type ChatMethod = 'list_sessions' | 'send' | 'cancel';`）
- 61-69 行：`ChatBridgeMethod` 类型、`BridgeMethod` 类型及其注释块
- 71-72 行：`LISTEN_TIMEOUT_MS` 及注释
- 74-78 行：`ChatLiveListener` 接口及注释

修改：
- `BridgeBackend.request` 签名与注释（原 168-169 行）改为：

```ts
  /** 发起一次浏览器操作请求，转发给 extension 执行 */
  request(method: BrowserMethod, params?: Record<string, unknown>): Promise<unknown>;
```

- `IpcRequest.method`（原 180 行）类型 `BridgeMethod` → `BrowserMethod`

- [ ] **Step 3: mcp-server.ts 清理**

删除 168-193 行（`// ---------------- 侧边栏在线聊天（listen/reply） ----------------` 注释、sessionKey/sessionLabel、`chat_listen` 与 `chat_reply` 两个 `server.tool(...)`），并删除第 10 行 `import { basename } from 'node:path';`（不再使用）。

- [ ] **Step 4: index.ts 去掉 ChatHub 装配**

- 删除 `import { ChatHub } from './chat-hub.js';`
- import 行的 `BridgeMethod` 改为不再导入（`BridgeBackend` 仍需要）
- `startPrimaryMode` 中 63-74 行的 hub 与 backend 包装整体替换为：

```ts
  const backend: BridgeBackend = ws;
```

- 81 行 `new ChatHandler((msg) => ws.pushChat(msg), hub)` 改为 `new ChatHandler((msg) => ws.pushChat(msg))`

- [ ] **Step 5: chat-handler.ts 去掉 live 分流**

文件头注释改为「唯一通道：headless spawn claude CLI」；删除 `ChatHub` import 与构造参数；`dispatch` 中删除 `case 'list_live'` 与 `send` 里的 `mode === 'live'` 分支。改后 `dispatch`：

```ts
  private async dispatch(msg: ChatRequestMessage): Promise<unknown> {
    switch (msg.method) {
      case 'list_sessions':
        return this.sessions.listSessions();
      case 'send': {
        const params = msg.params as unknown as RunTurnParams;
        this.sessions.runTurn(msg.id, params, (event) => {
          this.push({ type: 'chat_stream', turnId: msg.id, event });
        });
        return { started: true };
      }
      case 'cancel':
        return { cancelled: this.sessions.cancel() };
      default:
        throw new Error(`未知聊天方法 ${(msg as ChatRequestMessage).method}`);
    }
  }
```

（`runTurn` 在 Task 3 重构为 `send`，此处先保持编译通过。）

- [ ] **Step 6: ws-server.ts / ipc-proxy.ts 类型替换**

两文件 import 与 `request(method: ...)` 签名中 `BridgeMethod` → `BrowserMethod`；删除 ws-server.ts 198-199 行「chat_* 由 ChatHub 处理」注释及 `method as BrowserMethod` 断言（直接用 `method`）。

- [ ] **Step 7: 构建验证**

Run: `cd bridge && npm run build`
Expected: 编译通过，无残留引用报错。再跑 `grep -rn "chat_listen\|chat_reply\|ChatHub\|list_live" bridge/src/` 确认为空。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: 删除 MCP 轮询聊天链路（chat_listen/chat_reply/ChatHub/chrome-chat skill）"
```

---

### Task 2: 测试基建 + mapStreamJsonLine 支持流式增量

**Files:**
- Modify: `bridge/package.json`（scripts 加 test）
- Create: `bridge/tests/stream-json.test.mjs`
- Modify: `bridge/src/session-manager.ts:254-295`（mapStreamJsonLine）
- Modify: `bridge/src/protocol.ts`（ChatStreamEvent 加 `text_delta`、`turn_start`）

**Interfaces:**
- Consumes: Task 1 后的 protocol.ts
- Produces: `ChatStreamEvent` 新增 `{ kind: 'text_delta'; text: string }` 与 `{ kind: 'turn_start' }`；`mapStreamJsonLine` 支持 `stream_event` 行；tool_use `summary` 截断上限从 120 提到 600（面板展开用）

- [ ] **Step 1: 加 test script**

`bridge/package.json` scripts 增加：

```json
    "test": "npm run build && node --test tests/"
```

- [ ] **Step 2: protocol.ts 扩展事件类型**

`ChatStreamEvent` 联合类型（原 98-109 行）改为：

```ts
export type ChatStreamEvent =
  | { kind: 'text_delta'; text: string } // 流式文本增量（--include-partial-messages）
  | { kind: 'text'; text: string } // assistant 整块文本（对增量「定稿」）
  | { kind: 'tool_use'; name: string; summary: string } // 工具调用（面板折叠卡片）
  | { kind: 'turn_start' } // 排队消息开始执行
  | {
      kind: 'result'; // 轮次结束
      ok: boolean;
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
    }
  | { kind: 'error'; message: string } // 失败/取消
  | { kind: 'system'; message: string }; // 系统提示
```

- [ ] **Step 3: 写失败的测试**

`bridge/tests/stream-json.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStreamJsonLine } from '../dist/session-manager.js';

test('assistant 文本块 -> text 事件', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '你好' }] },
  });
  assert.deepEqual(mapStreamJsonLine(line), [{ kind: 'text', text: '你好' }]);
});

test('stream_event 的 text_delta -> text_delta 事件', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '增' } },
  });
  assert.deepEqual(mapStreamJsonLine(line), [{ kind: 'text_delta', text: '增' }]);
});

test('stream_event 非文本增量忽略', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } },
  });
  assert.equal(mapStreamJsonLine(line), null);
});

test('tool_use 摘要截断到 600', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { cmd: 'x'.repeat(700) } }] },
  });
  const [ev] = mapStreamJsonLine(line);
  assert.equal(ev.kind, 'tool_use');
  assert.ok(ev.summary.length <= 601); // 600 + '…'
});

test('result 行', () => {
  const line = JSON.stringify({ type: 'result', is_error: false, session_id: 's1', total_cost_usd: 0.01, duration_ms: 1200 });
  assert.deepEqual(mapStreamJsonLine(line), [
    { kind: 'result', ok: true, sessionId: 's1', costUsd: 0.01, durationMs: 1200 },
  ]);
});

test('空行与脏行返回 null', () => {
  assert.equal(mapStreamJsonLine(''), null);
  assert.equal(mapStreamJsonLine('not json'), null);
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd bridge && npm test`
Expected: `text_delta` 与「截断到 600」两个用例 FAIL，其余 PASS。

- [ ] **Step 5: 实现 mapStreamJsonLine 扩展**

`session-manager.ts` 中：tool_use 分支截断阈值 120 → 600（两处数字）；`if (obj.type === 'result')` 之前插入：

```ts
  // --include-partial-messages 产生的流式增量：只关心文本 delta
  if (obj.type === 'stream_event') {
    const ev = obj.event as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    if (
      ev?.type === 'content_block_delta' &&
      ev.delta?.type === 'text_delta' &&
      typeof ev.delta.text === 'string'
    ) {
      return [{ kind: 'text_delta', text: ev.delta.text }];
    }
    return null;
  }
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `cd bridge && npm test`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: stream-json 解析支持流式文本增量（text_delta）并建立单测基建"
```

---

### Task 3: SessionManager 队列 + chat-handler 接入

**Files:**
- Modify: `bridge/src/session-manager.ts`（runTurn → send + 队列）
- Modify: `bridge/src/chat-handler.ts`（send 分支返回值）
- Create: `bridge/tests/session-queue.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `ChatStreamEvent`（`turn_start`）
- Produces: `SessionManager.send(turnId: string, params: RunTurnParams, emit: (ev: ChatStreamEvent) => void): SendResult`，其中 `export type SendResult = { started: true } | { queued: true; position: number }`；`cancel(): boolean`（终止当前轮次并清空队列）；构造函数 `constructor(opts?: { spawnImpl?: typeof spawn; claudeBin?: string | null })`（测试注入用）。面板 `send` 响应可能是 `{ queued: true, position }`。

- [ ] **Step 1: 写失败的队列测试**

`bridge/tests/session-queue.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SessionManager } from '../dist/session-manager.js';

/** 伪造 claude 子进程：可控地写 stdout / 触发 close */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  return child;
}

function setup() {
  const spawned = []; // { child, args }
  const spawnImpl = (_bin, args) => {
    const child = fakeChild();
    spawned.push({ child, args });
    return child;
  };
  const sm = new SessionManager({ spawnImpl, claudeBin: '/usr/bin/true' });
  return { sm, spawned };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('空闲立即执行，参数含 --include-partial-messages', () => {
  const { sm, spawned } = setup();
  const res = sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, () => {});
  assert.deepEqual(res, { started: true });
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('--include-partial-messages'));
});

test('忙时入队，结束后自动续发并推 turn_start', async () => {
  const { sm, spawned } = setup();
  const ev2 = [];
  sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, () => {});
  const res2 = sm.send('t2', { cwd: '/tmp', message: 'b', permissionMode: 'default' }, (e) => ev2.push(e));
  assert.deepEqual(res2, { queued: true, position: 1 });
  assert.equal(spawned.length, 1); // 第二条尚未执行

  spawned[0].child.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-1' }) + '\n',
  );
  await tick();
  spawned[0].child.emit('close', 0, null);
  await tick();

  assert.equal(spawned.length, 2); // 自动续发
  assert.deepEqual(ev2[0], { kind: 'turn_start' });
});

test('排队的新会话消息续接前序轮次的 sessionId', async () => {
  const { sm, spawned } = setup();
  // 两条消息都不带 sessionId（新会话）
  sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, () => {});
  sm.send('t2', { cwd: '/tmp', message: 'b', permissionMode: 'default' }, () => {});
  spawned[0].child.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-new' }) + '\n',
  );
  await tick();
  spawned[0].child.emit('close', 0, null);
  await tick();
  const args2 = spawned[1].args;
  assert.ok(args2.includes('--resume'));
  assert.equal(args2[args2.indexOf('--resume') + 1], 'sess-new');
});

test('cancel 终止当前轮次并清空队列（排队消息推「已取消」）', async () => {
  const { sm, spawned } = setup();
  const ev1 = [], ev2 = [];
  sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, (e) => ev1.push(e));
  sm.send('t2', { cwd: '/tmp', message: 'b', permissionMode: 'default' }, (e) => ev2.push(e));
  assert.equal(sm.cancel(), true);
  await tick();
  assert.deepEqual(ev2, [{ kind: 'error', message: '已取消' }]);
  assert.ok(ev1.some((e) => e.kind === 'error' && e.message === '已取消'));
  assert.equal(spawned.length, 1); // 队列被清，未续发
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd bridge && npm test`
Expected: session-queue 全部 FAIL（`SessionManager` 构造签名 / `send` 不存在）。

- [ ] **Step 3: 重构 session-manager.ts**

头注释同步更新（队列语义）。核心改动：

```ts
export type SendResult = { started: true } | { queued: true; position: number };

interface PendingTurn {
  turnId: string;
  params: RunTurnParams;
  emit: (ev: ChatStreamEvent) => void;
}

export class SessionManager {
  private claudeBin: string | null;
  private spawnImpl: typeof spawn;
  private running: { turnId: string; child: ChildProcess } | null = null;
  private queue: PendingTurn[] = [];
  /** 本轮忙碌链中新会话产生的 id：排队的「新会话」消息出队时续接它；空闲后清空 */
  private chainSessionId: string | null = null;

  constructor(opts: { spawnImpl?: typeof spawn; claudeBin?: string | null } = {}) {
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.claudeBin = 'claudeBin' in opts ? (opts.claudeBin ?? null) : resolveClaudeBin();
  }

  /** 面板发消息：空闲立即执行，忙碌入队（轮次结束后自动续发） */
  send(turnId: string, params: RunTurnParams, emit: (ev: ChatStreamEvent) => void): SendResult {
    this.assertClaudeAvailable();
    if (!PERMISSION_MODES.has(params.permissionMode)) {
      throw new Error(`不支持的权限模式：${params.permissionMode}`);
    }
    if (!params.message?.trim()) {
      throw new Error('消息不能为空');
    }
    if (this.running) {
      this.queue.push({ turnId, params, emit });
      return { queued: true, position: this.queue.length };
    }
    this.runTurn({ turnId, params, emit });
    return { started: true };
  }

  private runTurn(turn: PendingTurn): void {
    // 新会话消息（无 sessionId）续接同一忙碌链中已产生的会话 id
    const sessionId = turn.params.sessionId ?? this.chainSessionId ?? undefined;
    const isNewSession = !turn.params.sessionId;
    const args = [
      ...(sessionId ? ['--resume', sessionId] : []),
      '-p', turn.params.message,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', turn.params.permissionMode,
    ];

    const child = this.spawnImpl(this.claudeBin as string, args, {
      cwd: turn.params.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.running = { turnId: turn.turnId, child };

    let gotResult = false;
    const stderrTail: string[] = [];

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const events = mapStreamJsonLine(line);
      if (!events) return;
      for (const ev of events) {
        if (ev.kind === 'result') {
          gotResult = true;
          if (isNewSession && ev.sessionId) this.chainSessionId = ev.sessionId;
        }
        turn.emit(ev);
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail.push(chunk.toString());
      if (stderrTail.length > 20) stderrTail.shift();
    });

    child.on('error', (err) => {
      this.running = null;
      turn.emit({ kind: 'error', message: `claude 进程启动失败：${err.message}` });
      this.drainQueue();
    });

    child.on('close', (code, signal) => {
      this.running = null;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        turn.emit({ kind: 'error', message: '已取消' });
      } else if (!gotResult) {
        const detail = stderrTail.join('').trim().slice(-500);
        turn.emit({
          kind: 'error',
          message: `claude 退出（code=${code}）未返回结果${detail ? `：${detail}` : ''}（若提示 OAuth 过期，请在终端运行一次 claude 重新登录）`,
        });
      }
      this.drainQueue();
    });
  }

  /** 取队首继续执行；队列空则结束忙碌链 */
  private drainQueue(): void {
    const next = this.queue.shift();
    if (!next) {
      this.chainSessionId = null;
      return;
    }
    next.emit({ kind: 'turn_start' });
    this.runTurn(next);
  }

  /** 停止：终止当前轮次并清空队列 */
  cancel(): boolean {
    const cleared = this.queue.splice(0);
    for (const t of cleared) {
      t.emit({ kind: 'error', message: '已取消' });
    }
    if (!this.running) {
      this.chainSessionId = null;
      return cleared.length > 0;
    }
    this.running.child.kill('SIGTERM');
    return true;
  }
  // assertClaudeAvailable / listSessions 等保持不变
}
```

注意：删除旧的 `runTurn(turnId, params, onEvent)` 公开签名与「已有进行中的对话轮次」抛错。

- [ ] **Step 4: chat-handler.ts 接入 send**

`dispatch` 的 `send` 分支改为（直接返回 SendResult，面板据此显示排队标签）：

```ts
      case 'send': {
        const params = msg.params as unknown as RunTurnParams;
        return this.sessions.send(msg.id, params, (event) => {
          this.push({ type: 'chat_stream', turnId: msg.id, event });
        });
      }
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `cd bridge && npm test`
Expected: 全部 PASS（含 Task 2 用例）

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: 会话轮次队列——忙时排队、结束自动续发、新会话续接、cancel 清队"
```

---

### Task 4: markdown mini 渲染器

**Files:**
- Create: `extension/panel/markdown.js`
- Create: `bridge/tests/markdown.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `globalThis.renderMarkdown(text: string): string`（返回安全 HTML；classic script，面板与 node 测试均可用）

- [ ] **Step 1: 写失败的测试**

`bridge/tests/markdown.test.mjs`：

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

before(async () => {
  // classic script：加载后挂到 globalThis
  await import(pathToFileURL(join(import.meta.dirname, '../../extension/panel/markdown.js')).href);
});

test('HTML 注入被转义', () => {
  const html = globalThis.renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('粗体/斜体/行内代码', () => {
  const html = globalThis.renderMarkdown('**加粗** *斜体* `code`');
  assert.ok(html.includes('<strong>加粗</strong>'));
  assert.ok(html.includes('<em>斜体</em>'));
  assert.ok(html.includes('<code>code</code>'));
});

test('围栏代码块内部不做行内处理', () => {
  const html = globalThis.renderMarkdown('```js\nconst a = "**x**";\n```');
  assert.ok(html.includes('<pre'));
  assert.ok(html.includes('**x**')); // 不转成 <strong>
});

test('列表与标题', () => {
  const html = globalThis.renderMarkdown('## 标题\n- 甲\n- 乙\n1. 一');
  assert.ok(/<h4>标题<\/h4>/.test(html));
  assert.ok(html.includes('<ul><li>甲</li><li>乙</li></ul>'));
  assert.ok(html.includes('<ol><li>一</li></ol>'));
});

test('仅允许 http(s) 链接', () => {
  const ok = globalThis.renderMarkdown('[a](https://example.com)');
  assert.ok(ok.includes('href="https://example.com"'));
  const bad = globalThis.renderMarkdown('[a](javascript:alert(1))');
  assert.ok(!bad.includes('href='));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd bridge && npm test`
Expected: markdown 用例全部 FAIL（文件不存在）。

- [ ] **Step 3: 实现 markdown.js**

```js
/**
 * markdown.js —— 面板用 mini markdown 渲染器（零依赖）
 *
 * 安全策略：所有文本先整体 HTML 转义，再做标记替换；链接仅允许 http(s)。
 * 支持：标题、粗体、斜体、行内代码、围栏代码块、无序/有序列表、引用、段落。
 */
(function () {
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }

  /** 行内标记（输入已转义）：行内代码 -> 粗体 -> 斜体 -> 链接 */
  function inline(s) {
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
    return s;
  }

  /** 非代码块区域按行解析块级结构 */
  function renderBlocks(md) {
    let html = '';
    let list = null; // 当前打开的列表标签：'ul' | 'ol' | null
    const closeList = () => {
      if (list) {
        html += `</${list}>`;
        list = null;
      }
    };
    for (const line of md.split('\n')) {
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        closeList();
        const level = Math.min(m[1].length + 2, 6); // 面板空间小：h1 从 h3 起步
        html += `<h${level}>${inline(escapeHtml(m[2]))}</h${level}>`;
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        closeList();
        html += `<blockquote>${inline(escapeHtml(m[1]))}</blockquote>`;
      } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
        if (list !== 'ul') {
          closeList();
          html += '<ul>';
          list = 'ul';
        }
        html += `<li>${inline(escapeHtml(m[1]))}</li>`;
      } else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
        if (list !== 'ol') {
          closeList();
          html += '<ol>';
          list = 'ol';
        }
        html += `<li>${inline(escapeHtml(m[1]))}</li>`;
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        html += `<p>${inline(escapeHtml(line))}</p>`;
      }
    }
    closeList();
    return html;
  }

  function renderMarkdown(text) {
    // 按 ``` 围栏分段：奇数段是代码块（只转义，不做行内处理）
    const parts = String(text ?? '').split(/```/);
    let html = '';
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 2 === 1) {
        const nl = parts[i].indexOf('\n');
        const code = nl === -1 ? parts[i] : parts[i].slice(nl + 1); // 首行是语言标记
        html += `<pre class="md-code"><code>${escapeHtml(code)}</code></pre>`;
      } else {
        html += renderBlocks(parts[i]);
      }
    }
    return html;
  }

  globalThis.renderMarkdown = renderMarkdown;
})();
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `cd bridge && npm test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: 面板 mini markdown 渲染器（转义优先，零依赖）"
```

---

### Task 5: 面板聊天状态机重构（chat.js + panel.html 结构）

**Files:**
- Modify: `extension/panel/chat.js`（重写）
- Modify: `extension/panel/panel.html`（聊天 Tab 结构 + 引入 markdown.js）

**Interfaces:**
- Consumes: Task 3 的 `send` 响应 `{started}|{queued,position}`、Task 2/3 的流事件（`text_delta`/`text`/`tool_use`/`turn_start`/`result`/`error`/`system`）、Task 4 的 `globalThis.renderMarkdown`
- Produces: 新 DOM 结构（Task 6 的 CSS 依赖这些类名）：`.chat-topbar`、`.settings-pop`、`.msg--user/.msg--assistant` + `.msg__role/.msg__time/.msg__body/.msg__tag`、`.tool-card(__head/__hint/__detail)`、`.thinking`、`.meta-line`、`.empty-state`、`#chatStop`

- [ ] **Step 1: panel.html 聊天 Tab 重构**

聊天 section（原 21-49 行）替换为：

```html
    <!-- ==================== 聊天 Tab ==================== -->
    <section id="tabChat" class="tab-page">
      <div class="chat-topbar">
        <select id="sessionSelect" class="select select--grow">
          <option value="">加载会话中…</option>
        </select>
        <button id="refreshSessions" class="icon-btn" title="刷新会话列表">⟳</button>
        <button id="settingsToggle" class="icon-btn" title="聊天设置">⚙</button>
      </div>
      <div id="projectRow" class="row hidden">
        <select id="projectSelect" class="select select--grow"></select>
      </div>
      <div id="settingsPop" class="settings-pop hidden">
        <label class="field">
          <span>权限模式（headless 执行）</span>
          <select id="permissionSelect" class="select">
            <option value="default">默认（沿用已授权工具）</option>
            <option value="acceptEdits">acceptEdits（自动批准编辑）</option>
            <option value="bypassPermissions">bypass（全部自动批准）</option>
          </select>
        </label>
        <p id="bypassWarn" class="warn hidden">⚠ bypass 模式下浏览器内容可触发任意命令执行，仅在可信环境使用</p>
        <p class="hint">对正在终端中使用的会话发消息，可能造成历史分叉</p>
      </div>

      <div id="messages" class="messages">
        <div id="emptyState" class="empty-state">
          选择一个 CC 会话，输入消息即可对话
          <span>会话忙碌时消息自动排队，空闲后继续处理</span>
        </div>
      </div>

      <div class="composer">
        <textarea id="chatInput" rows="1" placeholder="发消息…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button id="chatStop" class="btn btn--danger hidden" title="停止当前轮次并清空队列">■</button>
        <button id="chatSend" class="btn btn--primary">发送</button>
      </div>
    </section>
```

并在 `<script src="chat.js"></script>` 前加 `<script src="markdown.js"></script>`。

- [ ] **Step 2: 重写 chat.js**

保留原有的 port 连接 / `chatRequest` / `formatTime` / `projectName` / `loadSessions`（删除 `list_live` 请求与 live 分组渲染）。新增/改写核心如下：

```js
/**
 * chat.js —— 侧边栏「聊天」Tab
 *
 * 唯一通道：消息经 background -> WS -> bridge，由 bridge spawn claude CLI headless 处理。
 * bridge 全局串行执行；忙时新消息在 bridge 侧排队（气泡带「排队中」标签），
 * 前一轮结束后自动续发（turn_start 事件到达即切换为处理中）。
 */

const NEW_SESSION_VALUE = '__new__';

// …DOM 引用：新增 chatStop / settingsToggle / settingsPop / emptyState…

/** 单个轮次的渲染状态 */
function createTurn(turnId) {
  return {
    turnId,
    done: false,
    queueTag: null, // 「排队中」标签元素
    thinkingEl: null, // 思考中动画元素
    streamEl: null, // 当前流式助手内容元素
    streamText: '', // 已累积的流式文本
  };
}

const chatState = {
  sessions: [],
  newSessionId: null, // 「新会话」首轮返回的 session id
  turns: new Map(), // turnId -> turn
};

function activeTurnCount() {
  let n = 0;
  for (const t of chatState.turns.values()) if (!t.done) n += 1;
  return n;
}

function updateComposer() {
  chatStop.classList.toggle('hidden', activeTurnCount() === 0);
}

// ---------- 渲染 ----------

function hideEmptyState() {
  emptyState?.classList.add('hidden');
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function appendUserBubble(turn, text) {
  hideEmptyState();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--user';
  const body = document.createElement('div');
  body.className = 'msg__body';
  body.textContent = text;
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  turn.userEl = wrap;
  scrollToBottom();
}

function addQueueTag(turn, position) {
  const tag = document.createElement('div');
  tag.className = 'msg__tag';
  tag.textContent = `⏳ 排队中（第 ${position} 位）`;
  turn.userEl?.appendChild(tag);
  turn.queueTag = tag;
  scrollToBottom();
}

function removeQueueTag(turn) {
  turn.queueTag?.remove();
  turn.queueTag = null;
}

function appendAssistantBlock() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--assistant';
  const role = document.createElement('div');
  role.className = 'msg__role';
  role.innerHTML = `✳ Claude <span class="msg__time">${nowTime()}</span>`;
  const body = document.createElement('div');
  body.className = 'msg__body md';
  wrap.appendChild(role);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return body;
}

function renderAssistant(bodyEl, text) {
  bodyEl.innerHTML = globalThis.renderMarkdown(text);
  scrollToBottom();
}

function appendToolCard(name, summary) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  const head = document.createElement('button');
  head.className = 'tool-card__head';
  head.innerHTML = `<span class="tool-card__arrow">▸</span> ${escapeText(name)} <span class="tool-card__hint">${escapeText(summary)}</span>`;
  const detail = document.createElement('pre');
  detail.className = 'tool-card__detail hidden';
  detail.textContent = summary;
  head.addEventListener('click', () => {
    detail.classList.toggle('hidden');
    card.classList.toggle('tool-card--open');
  });
  card.appendChild(head);
  card.appendChild(detail);
  messagesEl.appendChild(card);
  scrollToBottom();
}

function appendMeta(text, isError = false) {
  const div = document.createElement('div');
  div.className = `meta-line${isError ? ' meta-line--error' : ''}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function showThinking(turn) {
  if (turn.thinkingEl) return;
  const el = document.createElement('div');
  el.className = 'thinking';
  el.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(el);
  turn.thinkingEl = el;
  scrollToBottom();
}

function clearThinking(turn) {
  turn.thinkingEl?.remove();
  turn.thinkingEl = null;
}

// ---------- 流事件 ----------

function handleStreamEvent(turnId, event) {
  if (event.kind === 'system') {
    appendMeta(event.message);
    return;
  }
  const turn = chatState.turns.get(turnId);
  if (!turn || turn.done) return;

  switch (event.kind) {
    case 'turn_start':
      removeQueueTag(turn);
      showThinking(turn);
      break;
    case 'text_delta':
      clearThinking(turn);
      if (!turn.streamEl) {
        turn.streamEl = appendAssistantBlock();
        turn.streamText = '';
      }
      turn.streamText += event.text;
      renderAssistant(turn.streamEl, turn.streamText);
      break;
    case 'text':
      // 整块文本对流式增量「定稿」：覆盖累积内容并结束当前块
      clearThinking(turn);
      if (!turn.streamEl) turn.streamEl = appendAssistantBlock();
      renderAssistant(turn.streamEl, event.text);
      turn.streamEl = null;
      turn.streamText = '';
      break;
    case 'tool_use':
      clearThinking(turn);
      turn.streamEl = null;
      turn.streamText = '';
      appendToolCard(event.name, event.summary);
      showThinking(turn); // 工具执行期间维持思考态
      break;
    case 'result': {
      finishTurn(turn);
      if (event.sessionId && sessionSelect.value === NEW_SESSION_VALUE) {
        chatState.newSessionId = event.sessionId;
      }
      const cost = typeof event.costUsd === 'number' ? ` · $${event.costUsd.toFixed(4)}` : '';
      const dur =
        typeof event.durationMs === 'number' ? ` ${(event.durationMs / 1000).toFixed(1)}s` : '';
      appendMeta(`${event.ok ? '✓ 完成' : '✗ 出错'}${dur}${cost}`, !event.ok);
      break;
    }
    case 'error':
      finishTurn(turn);
      appendMeta(`✗ ${event.message}`, true);
      break;
  }
}

function finishTurn(turn) {
  turn.done = true;
  clearThinking(turn);
  removeQueueTag(turn);
  turn.streamEl = null;
  updateComposer();
}

// ---------- 发送 / 停止 ----------

async function sendMessage() {
  const message = chatInput.value.trim();
  if (!message) return;
  const target = resolveSendTarget(); // 与旧版一致，但去掉 live 分支
  if (!target) return;

  const { id, promise } = chatRequest('send', {
    ...target,
    message,
    permissionMode: permissionSelect.value,
  });
  const turn = createTurn(id);
  chatState.turns.set(id, turn);
  appendUserBubble(turn, message);
  chatInput.value = '';
  autoresize();
  updateComposer();

  try {
    const res = await promise;
    if (res?.queued) {
      addQueueTag(turn, res.position);
    } else {
      showThinking(turn);
    }
  } catch (err) {
    finishTurn(turn);
    appendMeta(`✗ ${err.message}`, true);
  }
}

function stopAll() {
  chatRequest('cancel').promise.catch(() => {});
}

// ---------- 输入区 ----------

function autoresize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
}

chatSend.addEventListener('click', sendMessage);
chatStop.addEventListener('click', stopAll);
chatInput.addEventListener('input', autoresize);
chatInput.addEventListener('keydown', (e) => {
  // Enter 发送、Shift+Enter 换行；isComposing 保护中文输入法候选确认
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

settingsToggle.addEventListener('click', () => {
  settingsPop.classList.toggle('hidden');
});
```

其余保留项调整：
- `loadSessions` 只发 `list_sessions`；`renderSessionOptions` 删除 live 分组，默认选中最近会话
- `syncProjectRow` 删除 `isLive` 相关两行（权限选择常驻设置弹层）
- `resolveSendTarget` 删除 live 分支
- 删除 `LIVE_PREFIX` 常量与旧的 `appendBubble/appendToolUse/appendSystem/finishTurn` 中被替代的实现

- [ ] **Step 3: 构建与手动验证（功能通路）**

Run: `cd bridge && npm test`（bridge 无回归）
手动：Chrome 重载扩展 → 打开侧边栏 → 选历史会话发「只回复 ok」→ 依次出现：用户气泡 → 思考动画 → 流式文本 → `✓ 完成 xs · $x`；执行期间再发一条 → 第二条气泡带「⏳ 排队中」→ 第一轮结束后自动开始并去掉标签；点「■」→ 当前与排队全部标记「✗ 已取消」。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: 面板聊天状态机重构——多轮次排队、流式渲染、markdown、Enter 发送"
```

---

### Task 6: 面板视觉重设计（panel.css）

**Files:**
- Modify: `extension/panel/panel.css`（聊天区全部重写 + 新增组件样式）

**Interfaces:**
- Consumes: Task 5 的类名（`.chat-topbar`、`.settings-pop`、`.icon-btn`、`.msg__*`、`.tool-card*`、`.thinking`、`.meta-line`、`.empty-state`、`.md` 内容样式）
- Produces: 无（终端样式）

- [ ] **Step 1: 重写聊天区样式**

替换 panel.css 中「聊天 Tab」段（原 177 行至文件尾），全部新增如下（保留文件前半部分的通用样式与状态 Tab 样式）：

```css
/* ------------------------- 聊天 Tab ------------------------- */

#tabChat {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 96px);
}

.chat-topbar {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}

.icon-btn {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--muted);
  width: 30px;
  height: 30px;
  font-size: 14px;
  cursor: pointer;
  flex: none;
}

.icon-btn:hover {
  color: var(--text);
  border-color: var(--primary);
}

.settings-pop {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.chat-topbar + .row {
  margin-bottom: 8px;
}

/* 消息流 */

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 4px 2px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 8px;
}

.empty-state {
  margin: auto;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  line-height: 2;
}

.empty-state span {
  display: block;
  font-size: 11px;
  opacity: 0.7;
}

.msg--user {
  align-self: flex-end;
  max-width: 88%;
}

.msg--user .msg__body {
  background: var(--primary);
  color: #fff;
  border-radius: 14px 14px 4px 14px;
  padding: 8px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.55;
}

.msg__tag {
  text-align: right;
  color: var(--muted);
  font-size: 11px;
  margin-top: 3px;
}

.msg--assistant {
  align-self: stretch;
  max-width: 100%;
}

.msg__role {
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 3px;
}

.msg__time {
  opacity: 0.6;
  margin-left: 4px;
}

.msg--assistant .msg__body {
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

/* markdown 内容 */

.md p {
  margin: 0 0 6px;
}

.md h3, .md h4, .md h5, .md h6 {
  margin: 10px 0 4px;
  font-size: 13px;
}

.md ul, .md ol {
  margin: 0 0 6px;
  padding-left: 18px;
}

.md li {
  margin: 2px 0;
}

.md code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.md .md-code {
  background: #17171c;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  overflow-x: auto;
  margin: 4px 0 8px;
}

.md .md-code code {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  white-space: pre;
}

.md blockquote {
  margin: 4px 0;
  padding: 2px 10px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}

.md a {
  color: var(--primary);
}

/* 工具调用卡片 */

.tool-card {
  align-self: stretch;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}

.tool-card__head {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  background: none;
  border: none;
  color: var(--muted);
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 11px;
  padding: 5px 8px;
  cursor: pointer;
  text-align: left;
}

.tool-card__hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}

.tool-card--open .tool-card__arrow {
  display: inline-block;
  transform: rotate(90deg);
}

.tool-card__detail {
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  font-family: 'SF Mono', Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text);
  max-height: 200px;
  overflow-y: auto;
}

/* 状态行 / 思考动画 */

.meta-line {
  align-self: center;
  color: var(--muted);
  font-size: 11px;
}

.meta-line--error {
  color: var(--danger);
}

.thinking {
  display: flex;
  gap: 4px;
  padding: 4px 2px;
}

.thinking span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: thinking-bounce 1.2s infinite ease-in-out;
}

.thinking span:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes thinking-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* 输入区 */

.composer {
  display: flex;
  gap: 6px;
  align-items: flex-end;
}

.composer textarea {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  resize: none;
  min-height: 34px;
  max-height: 160px;
  line-height: 1.5;
}

.composer textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.composer .btn {
  border-radius: 10px;
  height: 34px;
  flex: none;
}
```

同时删除旧聊天段样式：`.chat-config`、旧 `.messages`（含 background/border）、旧 `.msg/.msg--user/.msg--assistant/.msg--tool/.msg--system`、旧 `.composer textarea`（被上面替代）。`.warn`、`.hint`、`.select` 保留。

- [ ] **Step 2: 手动视觉验证**

重载扩展检查：顶栏一行三控件；⚙ 弹层开合正常；空状态居中；用户气泡右对齐圆角；助手块带「✳ Claude 时间」；代码块/列表/粗体渲染正确；工具卡片折叠展开；三点思考动画；输入框 Enter 发送、自动增高、停止按钮仅忙时出现。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: 面板聊天视觉重设计——顶栏收纳、气泡体系、工具卡片、思考动画"
```

---

### Task 7: README 更新 + 全量验证

**Files:**
- Modify: `README.md`（142-177 行「侧边栏聊天」章节重写；193-207 行常见问题微调）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无

- [ ] **Step 1: 重写 README 聊天章节**

替换「## 侧边栏聊天（对接 CC 会话）」整节（含在线会话/历史会话/chrome-chat 安装三小节）为单一模式说明，要点：
- extension 驱动：面板选会话（最近 30 个，跨项目）或新建，直接发消息；bridge spawn `claude --resume <id> -p <消息> --output-format stream-json --include-partial-messages` headless 执行，流式回显（markdown 渲染、工具调用卡片）
- 忙时排队：同一时间全局一个轮次，新消息显示「排队中」，结束后自动续发；「■ 停止」终止当前并清空队列
- 权限模式在 ⚙ 设置里三档，bypass 红色警示
- 依赖 `claude` CLI 在 PATH 且登录态有效；OAuth 过期时面板会提示，在终端跑一次 `claude` 重新登录
- 对正开在终端的会话发消息可能分叉历史（提示保留）
- 删除「安装 chrome-chat skill」小节

常见问题表新增一行：

```
| 面板报「OAuth session expired」 | CLI 登录态过期，在终端运行一次 claude 重新登录 |
```

- [ ] **Step 2: 全量验证**

Run: `cd bridge && npm test`
Expected: 全部 PASS

手动 e2e 清单（对照 spec「测试」节）：
1. 选历史会话发消息 → 流式渲染 → result footer
2. 忙时发第二条 → 排队标签 → 自动续发
3. 新会话：选「＋新会话」连发两条 → 第二条续接同一会话（用 `claude --resume` 该 id 验证两条都在）
4. 停止：清空队列，标记已取消
5. markdown：让 CC 回复带代码块/列表的内容，检查渲染
6. 工具卡片：让 CC 跑一个 Bash 命令，检查折叠/展开
7. 让 CC 操作浏览器（browser_* 工具）确认 MCP 浏览器链路无回归

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: README 更新为 extension 驱动聊天模式"
```
