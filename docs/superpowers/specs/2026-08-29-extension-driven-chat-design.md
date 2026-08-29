# Extension 驱动的 CC 聊天 + 面板 UI 重设计 — 设计文档

日期：2026-08-29
状态：已确认
取代：`2026-08-29-panel-chat-design.md` 中的「在线会话（listen/reply）」部分

## 背景与目标

现状的在线会话模式要求用户先在 CC 里触发 chrome-chat skill 进入 `chat_listen` 长轮询循环，侧边栏才能对话——很不灵活，且监听循环持续消耗模型轮次。

目标：

1. **extension 驱动**：侧边栏发消息即触达 CC——bridge 直接 spawn `claude` CLI headless 处理消息；CC 忙碌（已有进行中轮次）时消息排队，面板提示等待，空闲后自动续发。
2. **彻底删除 MCP 轮询链路**（chat_listen / chat_reply / ChatHub / chrome-chat skill / 面板在线分组）。
3. **面板聊天 UI 重设计**：视觉重做 + markdown 渲染 + 流式打字效果。

## 非目标

- 不对接正开在终端里的交互式会话（无法注入，分叉风险照旧仅 UI 提示）
- 不做完整历史回放（面板只显示本次面板发起的轮次）
- 不引入第三方前端依赖（markdown 渲染自写，MV3 CSP 友好）

## 架构

唯一聊天通道（原「历史会话」通道升级为主通道）：

```
panel → background → WS → bridge ChatHandler → SessionManager
                                                 └─ spawn claude --resume <id> -p <msg>
                                                    --output-format stream-json --verbose
                                                    --include-partial-messages
                                                    --permission-mode <mode>
```

`browser_*` 10 个 MCP 工具与 IPC primary/proxy 架构完全不动。

### 删除清单

- `bridge/src/chat-hub.ts` 整文件
- `bridge/src/mcp-server.ts`：`chat_listen`、`chat_reply` 工具及 sessionKey/sessionLabel
- `bridge/src/protocol.ts`：`ChatBridgeMethod`、`ChatLiveListener`、`LISTEN_TIMEOUT_MS`、`list_live` 方法、`BridgeMethod` 中 chat 分支（回归 `BrowserMethod`）
- `bridge/src/chat-handler.ts`、`index.ts`、`ws-server.ts`：ChatHub 装配与 live 分流
- `skills/chrome-chat/` 整目录
- `extension/panel/chat.js`：live 前缀、在线分组、live 流事件分支
- `README.md`：在线会话章节改写

## 排队机制（SessionManager）

从「忙时抛错」改为「忙时入队」：

- 状态：`running`（当前轮次）+ `queue: PendingTurn[]`（FIFO）
  - `PendingTurn = { turnId, sessionId?, cwd, message, permissionMode, isNewSession }`
- `send`：空闲 → 立即执行，响应 `{ started: true }`；忙 → 入队，响应 `{ queued: true, position }`
- 轮次结束（child close）→ 自动取队首执行，先推 `{ kind: 'turn_start' }` 事件（面板把「排队中」标签切换为处理中）
- **新会话续接**：队列消息的目标是「新会话」且前序轮次已产生 sessionId 时，bridge 出队时自动补上该 sessionId（续接逻辑放 bridge，不依赖面板）
- **停止（cancel）**：kill 当前轮次并清空队列；被清队的每个 turnId 推 `{ kind: 'error', message: '已取消' }`
- 并发粒度：维持全局单轮次（侧边栏一次只聊一个目标，YAGNI）

## 流式协议

CLI 增加 `--include-partial-messages`，`mapStreamJsonLine` 扩展：

- `stream_event` 行中 `content_block_delta`（`text_delta`）→ 新事件 `{ kind: 'text_delta', text }`，面板逐段追加
- 整块 `assistant` 文本到达时**定稿**当前气泡（用整块覆盖累积增量），防丢失/重复
- `tool_use` 仍从 assistant 整块提取；`result` / `error` 事件不变

`ChatStreamEvent` 最终形态：

```ts
| { kind: 'text_delta'; text: string }   // 新增：流式文本增量
| { kind: 'text'; text: string }         // 整块定稿
| { kind: 'tool_use'; name: string; summary: string }
| { kind: 'turn_start' }                 // 新增：排队消息开始处理
| { kind: 'result'; ok; sessionId?; costUsd?; durationMs? }
| { kind: 'error'; message: string }
| { kind: 'system'; message: string }
```

## Markdown 渲染

新增 `extension/panel/markdown.js`：自写 mini 渲染器（约 100 行），支持标题、粗体/斜体、行内代码、围栏代码块、无序/有序列表、链接、引用。安全策略：**先对全文 HTML 转义，再做标记替换**；链接仅允许 `http(s)://`。流式期间每次 delta 对当前气泡整体重渲染（消息体量小，成本可忽略）。

## UI 重设计（保持暗色主题）

- **顶栏收纳**：会话下拉 + 刷新常驻一行；权限模式选择与分叉风险提示收进「⚙」弹出层
- **消息流**：
  - 用户消息：右侧主色圆角气泡
  - 助手消息：左侧无框文本块，带「✳」角色标识 + 小字时间戳，内容 markdown 渲染
  - 轮次 footer：`✓ 4.2s · $0.0123` 小字
  - 工具调用卡片：默认折叠一行 `▸ Bash · npm test`，点击展开完整入参
- **状态动效**：发送后「思考中」三点跳动，首个 delta 到达切流式渲染；排队消息带「⏳ 排队中」标签，`turn_start` 后移除
- **输入区**：textarea 自动增高；**Enter 发送 / Shift+Enter 换行**（保留 Cmd+Enter）；进行中按钮变「停止」
- **空状态**：无消息时显示引导文案
- 权限模式仍三档（default / acceptEdits / bypassPermissions），bypass 红色警示保留

## 错误处理

- claude CLI 缺失 / OAuth 过期：CLI 报错尾部透传面板，附提示「终端运行一次 claude 重新登录」
- WS 断开：面板禁用发送并提示（现有行为保留）
- 轮次异常退出（无 result）：stderr 尾部透传（现有行为保留）

## 测试

- bridge 单测（Node 22 内置 `node --test`，零新依赖）：
  - `mapStreamJsonLine`：text / tool_use / result / stream_event(text_delta) / 脏行
  - 队列状态机：忙时入队、结束自动出队、新会话续接 sessionId、cancel 清队
- 手动 e2e：发消息 → 流式渲染 → 忙时排队提示 → 自动续发 → 停止清队 → markdown / 工具卡片 / 空状态
