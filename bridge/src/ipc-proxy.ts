/**
 * IPC proxy：Proxy 模式下通过 Unix socket 连接 Primary，转发 MCP 工具调用
 *
 * 实现 BridgeBackend 接口，MCP server 无感知地使用。
 * 所有 request() 调用通过 IPC 发给 Primary，由 Primary 转发给 extension。
 */

import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  BridgeBackend,
  BrowserMethod,
  IpcRequest,
  IpcStatusQuery,
  IpcToProxy,
  IPC_SOCKET_PATH,
  REQUEST_TIMEOUT_MS,
} from './protocol.js';

interface PendingIpc {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type EventListener = (event: string, payload: Record<string, unknown>) => void;

export class IpcProxy implements BridgeBackend {
  private socket: net.Socket;
  private pending = new Map<string, PendingIpc>();
  private eventListeners: EventListener[] = [];
  private disconnectListeners: Array<() => void> = [];
  private disconnectNotified = false;
  private _connected = false;
  private buffer = '';

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.setupSocket();
  }

  /** 连接到 Primary 的 IPC server，失败则抛错 */
  static async connect(): Promise<IpcProxy> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(IPC_SOCKET_PATH);
      const onError = (err: Error): void => {
        socket.removeAllListeners();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        const proxy = new IpcProxy(socket);
        // 立即查询 Primary 的 extension 连接状态
        proxy.queryStatus().then(
          (connected) => {
            proxy._connected = connected;
            resolve(proxy);
          },
          () => resolve(proxy), // 查询失败也不阻塞启动
        );
      });
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  onEvent(listener: EventListener): void {
    this.eventListeners.push(listener);
  }

  /** 注册 IPC 断开监听（Primary 退出时触发，仅一次），用于上层重新选主 */
  onDisconnect(listener: () => void): void {
    this.disconnectListeners.push(listener);
    // 已经断开的情况下立即补触发，避免注册前断连导致监听丢失
    if (this.socket.destroyed && !this.disconnectNotified) {
      this.notifyDisconnect();
    }
  }

  async request(method: BrowserMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.socket.destroyed) {
      throw new Error('IPC 连接已断开（Primary 进程可能已退出）');
    }

    const id = randomUUID();
    const message: IpcRequest = { type: 'ipc_request', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC 操作超时（${REQUEST_TIMEOUT_MS}ms）：${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify(message) + '\n');
    });
  }

  private async queryStatus(): Promise<boolean> {
    const id = randomUUID();
    const message: IpcStatusQuery = { type: 'ipc_status_query', id };

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('状态查询超时'));
      }, 3000);

      this.pending.set(id, {
        resolve: (result) => resolve(result as boolean),
        reject,
        timer,
      });
      this.socket.write(JSON.stringify(message) + '\n');
    });
  }

  private setupSocket(): void {
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(line.trim());
        }
      }
    });

    this.socket.on('close', () => {
      this._connected = false;
      this.rejectAllPending(new Error('IPC 连接断开（Primary 进程已退出）'));
      this.notifyDisconnect();
    });

    this.socket.on('error', () => {
      // close 事件统一收尾
    });
  }

  private handleMessage(raw: string): void {
    let msg: IpcToProxy;
    try {
      msg = JSON.parse(raw) as IpcToProxy;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ipc_response': {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error ?? 'unknown error from primary'));
        }
        break;
      }
      case 'ipc_event': {
        for (const listener of this.eventListeners) {
          listener(msg.event, msg.payload);
        }
        break;
      }
      case 'ipc_status_response': {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        this._connected = msg.connected;
        pending.resolve(msg.connected);
        break;
      }
    }
  }

  private notifyDisconnect(): void {
    if (this.disconnectNotified) {
      return;
    }
    this.disconnectNotified = true;
    for (const listener of this.disconnectListeners) {
      listener();
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
