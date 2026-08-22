/**
 * WS server：对 Chrome 扩展开放的 localhost WebSocket 服务
 *
 * 职责：
 * - 只绑定 127.0.0.1，token 鉴权（拒绝非法连接）
 * - 端口段抢占：从候选端口从小到大尝试，绑定第一个空闲端口
 * - 维护唯一的扩展连接（单浏览器场景），新连接顶替旧连接
 * - 提供 request()：向扩展发起一次操作并等待响应（带超时）
 * - 心跳保活，转发扩展事件
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  BrowserMethod,
  ExtensionToBridge,
  RequestMessage,
  HEARTBEAT_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from './protocol.js';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type EventListener = (event: string, payload: Record<string, unknown>) => void;

export class BridgeWsServer {
  private wss: WebSocketServer;
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private heartbeat: NodeJS.Timeout | null = null;
  private eventListeners: EventListener[] = [];

  /** 实际绑定成功的端口 */
  readonly port: number;

  private constructor(
    wss: WebSocketServer,
    port: number,
    private readonly token: string,
  ) {
    this.wss = wss;
    this.port = port;
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url ?? ''));
  }

  /**
   * 在候选端口列表中从小到大抢占第一个空闲端口。
   * 全部被占用时抛错（附带各端口失败原因）。
   */
  static async create(ports: number[], token: string): Promise<BridgeWsServer> {
    const failures: string[] = [];
    for (const port of ports) {
      try {
        const wss = await BridgeWsServer.listen(port);
        return new BridgeWsServer(wss, port, token);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${port}: ${message}`);
      }
    }
    throw new Error(`候选端口全部不可用：\n${failures.join('\n')}`);
  }

  /** 尝试在指定端口启动 WS server；EADDRINUSE 等错误时 reject */
  private static listen(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      // 仅监听回环地址，避免暴露到局域网
      const wss = new WebSocketServer({ host: '127.0.0.1', port });
      const onError = (err: Error): void => {
        wss.removeAllListeners('listening');
        reject(err);
      };
      wss.once('error', onError);
      wss.once('listening', () => {
        wss.removeListener('error', onError);
        resolve(wss);
      });
    });
  }

  /** 扩展当前是否已连接 */
  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** 注册扩展事件监听（tab_changed / navigated / detached） */
  onEvent(listener: EventListener): void {
    this.eventListeners.push(listener);
  }

  private onConnection(ws: WebSocket, url: string): void {
    // 从 query 中取 token 校验：ws://127.0.0.1:port/?token=xxx
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    if (params.get('token') !== this.token) {
      ws.close(4001, 'invalid token');
      return;
    }

    // 顶替旧连接
    if (this.socket) {
      try {
        this.socket.close(4000, 'replaced by new connection');
      } catch {
        // ignore
      }
    }
    this.socket = ws;
    this.startHeartbeat();

    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = null;
        this.stopHeartbeat();
        // 断连时拒绝所有在途请求，避免 agent 侧挂死
        this.rejectAllPending(new Error('extension disconnected'));
      }
    });
    ws.on('error', () => {
      // 错误由 close 事件统一收尾
    });
  }

  private onMessage(raw: string): void {
    let msg: ExtensionToBridge;
    try {
      msg = JSON.parse(raw) as ExtensionToBridge;
    } catch {
      return; // 忽略非法 JSON
    }

    switch (msg.type) {
      case 'response': {
        const pending = this.pending.get(msg.id);
        if (!pending) {
          return;
        }
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error ?? 'unknown extension error'));
        }
        break;
      }
      case 'event': {
        for (const listener of this.eventListeners) {
          listener(msg.event, msg.payload);
        }
        break;
      }
      case 'ping': {
        this.send({ type: 'pong' });
        break;
      }
      case 'pong': {
        // 心跳回应，无需处理
        break;
      }
    }
  }

  /** 向扩展发起一次操作请求，返回结果（或抛出错误） */
  async request(method: BrowserMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new Error(
        'Chrome 扩展未连接。请确认：1) 扩展已加载并在侧边栏显示「已连接」；2) token/端口一致。',
      );
    }

    const id = randomUUID();
    const message: RequestMessage = { type: 'request', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`操作超时（${REQUEST_TIMEOUT_MS}ms）：${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify(message));
    });
  }

  private send(obj: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(obj));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
