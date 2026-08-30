/**
 * BackendManager：可热切换的 BridgeBackend 代理
 *
 * MCP server / IPC server 持有本对象；底层 backend（Primary 的 WS server
 * 或 Proxy 的 IPC 连接）在「重新选主」时被替换，上层无感知。
 * 事件监听注册在 manager 上，切换 backend 时自动转挂到新 backend。
 */

import { BridgeBackend, BrowserMethod } from './protocol.js';

type EventListener = (event: string, payload: Record<string, unknown>) => void;

export class BackendManager implements BridgeBackend {
  private current: BridgeBackend | null = null;
  private listeners: EventListener[] = [];
  private electing = false; // 是否处于重新选主过程中

  /** 替换底层 backend，并把已注册的事件监听转挂过去 */
  setBackend(backend: BridgeBackend): void {
    this.current = backend;
    this.electing = false;
    for (const listener of this.listeners) {
      backend.onEvent(listener);
    }
  }

  /** 标记进入选主状态：期间的请求返回更明确的错误提示 */
  markElecting(): void {
    this.electing = true;
  }

  async request(method: BrowserMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.current || this.electing) {
      throw new Error('bridge 正在重新选主（原 Primary 已退出），请稍后重试');
    }
    return this.current.request(method, params);
  }

  get connected(): boolean {
    return this.current?.connected ?? false;
  }

  onEvent(listener: EventListener): void {
    this.listeners.push(listener);
    this.current?.onEvent(listener);
  }
}
