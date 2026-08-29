# 侧边栏 Chat 对接 Claude Code 会话 — 设计文档

日期：2026-08-29
状态：已确认（方案 A：bridge 调用 claude CLI headless resume）

## 目标

扩展侧边栏新增「聊天」界面：用户选择一个已有的 Claude Code 会话（或新建），直接在浏览器侧边栏与其对话。聊天内容与结果都进入该 CC 会话的正式历史。插件自身不做任何 LLM 调度——Claude Code 就是大脑，密钥、agent 循环、工具执行全部复用 CC 现成能力。

## 非目标

- 不支持对接 Anthropic API / OpenAI 兼容接口等直连 LLM
- 不做会话内容的完整历史回放（面板只显示本次面板发起的轮次）
- 不检测目标会话是否正开在某个终端（不可靠），仅 UI 提示分叉风险

## 整体架构

```
panel(chat UI) ⇄ chrome.runtime ⇄ background.js ⇄ WS ⇄ bridge(primary) ⇄ spawn `claude` CLI
```

- 复用现有 WS 通道，方向反转：新增 extension→bridge 的请求通道
- Chat 仅由 primary bridge 处理（持有 WS server 的实例）；proxy 实例不参与，IPC 层不改
- MCP 侧（mcp-server.ts、10 个 browser_* 工具）完全不动

## 协议扩展（protocol.ts）

新增消息类型：

```
// extension -> bridge
ChatRequestMessage  { type: 'chat_request', id, method: 'list_sessions' | 'send' | 'cancel', params }

// bridge -> extension
ChatResponseMessage { type: 'chat_response', id, ok, result?, error? }
ChatStreamMessage   { type: 'chat_stream', turnId, event }
```

`chat_stream.event` 由 stream-json 事件精简而来：

- `{ kind: 'text', text }` — assistant 文本增量/块
- `{ kind: 'tool_use', name, summary }` — 工具调用（面板折叠显示一行）
- `{ kind: 'result', ok, sessionId, costUsd?, durationMs? }` — 轮次结束（含新会话的 session id）
- `{ kind: 'error', message }` — 失败

## bridge 侧：新增 session-manager.ts

### 会话发现（list_sessions）

- 扫描 `~/.claude/projects/<编码目录>/*.jsonl`
- 编码目录反解码为项目路径（`-Users-zhuhanhui-code-...` → `/Users/zhuhanhui/code/...`）
- 每个会话解析：sessionId（文件名）、项目路径、标题（首条 `type:"user"` 消息或 `type:"summary"` 摘要，截断 60 字符）、mtime
- 按 mtime 倒序，默认返回最近 30 条；解析单文件只读前若干 KB，避免大文件拖慢

### 执行轮次（send）

```
spawn('claude', [
  '--resume', sessionId,        // 新会话则省略
  '-p', message,
  '--output-format', 'stream-json',
  '--verbose',                  // stream-json + --print 必需
  '--permission-mode', mode,    // default | acceptEdits | bypassPermissions
], { cwd: 会话对应项目目录 })
```

- 逐行解析 stdout 的 stream-json，转成 `chat_stream` 事件推送
- 新会话：从 init 事件取 session_id，随 result 事件回传面板，面板据此续聊
- 同一时间全局只允许一个进行中轮次（首版从简）；进行中再 send 返回错误
- cancel：kill 子进程，推 `{ kind: 'error', message: '已取消' }`
- `claude` 二进制：启动时 `which claude` 探测；找不到则 list_sessions/send 报错给面板

## 面板 UI：拆成两个 Tab

### 「聊天」Tab（新，默认）

- 顶部：会话下拉框（最近 30 条 + 「＋新会话（选择项目目录）」+ 刷新按钮）；权限模式下拉（默认权限 / acceptEdits / bypassPermissions，选 bypass 时红色警示文案）
- 中部：消息流。用户/助手气泡；工具调用折叠为一行灰字（如 `▸ Bash: npm test`）；轮次结束显示耗时
- 底部：多行输入框 + 发送按钮（进行中变「停止」）
- 会话若可能开在终端中，下拉旁固定灰字提示：「对正在终端使用的会话发消息可能造成历史分叉」

### 「状态」Tab

现有内容原样迁移：连接状态、token 配置、保存并重连、紧急停止、动作日志。

### background.js

- panel ⇄ background 走 `chrome.runtime.connect` 长连接 port（流式推送需要）
- background 把 chat_request 写入现有 WS，把 chat_response / chat_stream 按 port 转发回面板
- WS 断开时面板聊天区显示「bridge 未连接」并禁用发送

## 安全

- 权限模式默认停在「默认权限」；bypassPermissions 需手动选择且带红色警示
- 网页内容可能含注入指令，经 CC 读取时由 CC 的安全机制兜底；面板不额外转发页面内容
- WS 仍仅绑定 127.0.0.1 + token 鉴权，不新增暴露面

## 已知限制

- 每条消息一次 CLI 冷启动，数秒延迟；后续可用 `--input-format stream-json` 常驻进程优化
- headless 下未预授权的工具会被拒绝（default 模式），CC 会绕过或说明做不了
- 对正开在终端的会话 resume 可能分叉历史

## 测试

- 单测：会话目录编码反解码、jsonl 标题解析、stream-json 事件转换（bridge 侧纯函数）
- 手动 e2e：列会话 → 选会话发消息 → 流式回显 → 工具调用折叠显示 → cancel → 新会话创建后续聊
