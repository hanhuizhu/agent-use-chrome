/**
 * WebSocket 消息协议
 *
 * bridge <-> extension 之间的双向 JSON 消息定义。
 * - 请求（bridge -> extension）：{ type: 'request', id, method, params }
 * - 响应（extension -> bridge）：{ type: 'response', id, ok, result?, error? }
 * - 事件（extension -> bridge）：{ type: 'event', event, payload }
 * - 心跳（双向）：{ type: 'ping' } / { type: 'pong' }
 */

/** 浏览器操作方法名（与 MCP 工具一一对应） */
export type BrowserMethod =
  | 'navigate'
  | 'snapshot'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'press_key'
  | 'scroll'
  | 'wait'
  | 'tabs'
  | 'get_state';

/** bridge -> extension：一次操作请求 */
export interface RequestMessage {
  type: 'request';
  id: string; // 请求唯一标识，用于匹配响应
  method: BrowserMethod;
  params: Record<string, unknown>;
}

/** extension -> bridge：操作响应 */
export interface ResponseMessage {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown; // 成功时的结果数据
  error?: string; // 失败时的错误信息
}

/** extension -> bridge：主动上报的事件 */
export interface EventMessage {
  type: 'event';
  event: 'tab_changed' | 'navigated' | 'detached';
  payload: Record<string, unknown>;
}

/** 心跳消息 */
export interface PingMessage {
  type: 'ping';
}
export interface PongMessage {
  type: 'pong';
}

// ------------------------- 侧边栏 Chat（extension -> bridge 反向请求） -------------------------

/** 侧边栏聊天操作方法名 */
export type ChatMethod = 'list_sessions' | 'send' | 'cancel' | 'get_history' | 'get_status';

/** 进行中/排队轮次的概要（get_status 返回，面板重建后接管显示用） */
export interface ChatTurnStatus {
  turnId: string;
  sessionId: string | null; // 新会话轮次在 result 前无法归属，为 null
  message: string; // 该轮次的用户消息（面板补渲染气泡用）
}

/** get_status 返回结构 */
export interface ChatStatusResult {
  running: ChatTurnStatus | null;
  queue: ChatTurnStatus[]; // 按排队顺序
}

/** 会话历史条目（get_history 返回，供面板回放） */
export type ChatHistoryEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string; summary: string };

/** get_history 返回结构 */
export interface ChatHistoryResult {
  entries: ChatHistoryEntry[];
  truncated: boolean; // 超过上限时只返回尾部
}

/** extension -> bridge：侧边栏发起的聊天请求 */
export interface ChatRequestMessage {
  type: 'chat_request';
  id: string;
  method: ChatMethod;
  params: Record<string, unknown>;
}

/** bridge -> extension：聊天请求的应答 */
export interface ChatResponseMessage {
  type: 'chat_response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 聊天轮次的流式事件（由 claude CLI stream-json 精简而来） */
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

/** bridge -> extension：聊天轮次的流式推送 */
export interface ChatStreamMessage {
  type: 'chat_stream';
  turnId: string;
  event: ChatStreamEvent;
}

/** 会话列表条目（list_sessions 返回） */
export interface ChatSessionInfo {
  sessionId: string;
  cwd: string; // 会话所属项目目录
  title: string; // 首条用户消息/摘要，截断
  mtime: number; // 最后活跃时间戳（毫秒）
}

export type ExtensionToBridge =
  | ResponseMessage
  | EventMessage
  | ChatRequestMessage
  | PingMessage
  | PongMessage;
export type BridgeToExtension =
  | RequestMessage
  | ChatResponseMessage
  | ChatStreamMessage
  | PingMessage
  | PongMessage;

/** 截图结果结构（extension 回传） */
export interface ScreenshotResult {
  dataUrl: string; // data:image/png;base64,...（可视区截图）
  devicePixelRatio: number; // 用于把 device 像素换算到 CSS 像素
  cssWidth: number; // 可视区 CSS 像素宽
  cssHeight: number; // 可视区 CSS 像素高
}

/** WS 端口候选段：bridge 从小到大抢占第一个空闲端口；extension 按同一顺序扫描连接 */
export const PORT_RANGE_START = 12345;
export const PORT_RANGE_END = 12350;

/** 心跳间隔（毫秒）；需 < 30s 以保活 MV3 service worker */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** 单次操作请求的默认超时（毫秒） */
export const REQUEST_TIMEOUT_MS = 30_000;

/** IPC Unix socket 路径：Primary 监听，Proxy 连接 */
export const IPC_SOCKET_PATH = '/tmp/agent-use-chrome-bridge.sock';

/**
 * Bridge 后端统一接口
 *
 * Primary 模式由 BridgeWsServer 实现（直连 extension），
 * Proxy 模式由 IpcProxy 实现（通过 IPC 转发到 Primary）。
 * MCP server 不感知自身运行模式。
 */
export interface BridgeBackend {
  /** 发起一次浏览器操作请求，转发给 extension 执行 */
  request(method: BrowserMethod, params?: Record<string, unknown>): Promise<unknown>;
  /** extension 是否已连接（Proxy 模式下反映 Primary 的连接状态） */
  readonly connected: boolean;
  /** 注册 extension 事件监听 */
  onEvent(listener: (event: string, payload: Record<string, unknown>) => void): void;
}

/** IPC 消息类型：Proxy -> Primary */
export interface IpcRequest {
  type: 'ipc_request';
  id: string;
  method: BrowserMethod;
  params: Record<string, unknown>;
}

/** IPC 消息类型：Primary -> Proxy */
export interface IpcResponse {
  type: 'ipc_response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** IPC 消息类型：Primary -> Proxy（extension 事件转发） */
export interface IpcEvent {
  type: 'ipc_event';
  event: string;
  payload: Record<string, unknown>;
}

/** IPC 消息类型：Proxy -> Primary（查询连接状态） */
export interface IpcStatusQuery {
  type: 'ipc_status_query';
  id: string;
}

/** IPC 消息类型：Primary -> Proxy（连接状态回复） */
export interface IpcStatusResponse {
  type: 'ipc_status_response';
  id: string;
  connected: boolean;
}

export type IpcToPrimary = IpcRequest | IpcStatusQuery;
export type IpcToProxy = IpcResponse | IpcEvent | IpcStatusResponse;
