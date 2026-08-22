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

export type ExtensionToBridge = ResponseMessage | EventMessage | PingMessage | PongMessage;
export type BridgeToExtension = RequestMessage | PingMessage | PongMessage;

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
