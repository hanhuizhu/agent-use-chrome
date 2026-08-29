/**
 * IPC server：Primary 模式下对其他 bridge 进程（Proxy）开放的 Unix socket 服务
 *
 * 职责：
 * - 监听 IPC_SOCKET_PATH，接受 Proxy 连接
 * - 把 Proxy 的 request 转发给 BridgeWsServer -> extension，回传结果
 * - 转发 extension 事件到所有 Proxy
 * - 进程退出时清理 socket 文件
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import {
  BridgeBackend,
  IpcToPrimary,
  IpcResponse,
  IpcEvent,
  IpcStatusResponse,
  IPC_SOCKET_PATH,
} from './protocol.js';

export class IpcServer {
  private server: net.Server;
  private clients = new Set<net.Socket>();

  constructor(private readonly backend: BridgeBackend) {
    this.server = net.createServer((socket) => this.onConnection(socket));

    // 转发 extension 事件到所有 Proxy
    this.backend.onEvent((event, payload) => {
      this.broadcast({ type: 'ipc_event', event, payload });
    });
  }

  async start(): Promise<void> {
    // 清理可能残留的 sock 文件
    try {
      fs.unlinkSync(IPC_SOCKET_PATH);
    } catch {
      // 不存在则忽略
    }

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(IPC_SOCKET_PATH, () => {
        this.server.removeListener('error', reject);
        this.setupCleanup();
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    this.clients.add(socket);
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      // 按换行分割消息（每条消息一行 JSON）
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(socket, line.trim());
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
    });

    socket.on('error', () => {
      this.clients.delete(socket);
    });
  }

  private async handleMessage(socket: net.Socket, raw: string): Promise<void> {
    let msg: IpcToPrimary;
    try {
      msg = JSON.parse(raw) as IpcToPrimary;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ipc_request': {
        try {
          const result = await this.backend.request(msg.method, msg.params);
          this.send(socket, {
            type: 'ipc_response',
            id: msg.id,
            ok: true,
            result,
          } satisfies IpcResponse);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.send(socket, {
            type: 'ipc_response',
            id: msg.id,
            ok: false,
            error,
          } satisfies IpcResponse);
        }
        break;
      }
      case 'ipc_status_query': {
        this.send(socket, {
          type: 'ipc_status_response',
          id: msg.id,
          connected: this.backend.connected,
        } satisfies IpcStatusResponse);
        break;
      }
    }
  }

  private send(socket: net.Socket, msg: IpcResponse | IpcStatusResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + '\n');
    }
  }

  private broadcast(msg: IpcEvent): void {
    const data = JSON.stringify(msg) + '\n';
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(data);
      }
    }
  }

  /** 注册进程退出清理 */
  private setupCleanup(): void {
    const cleanup = (): void => {
      try {
        this.server.close();
      } catch { /* ignore */ }
      try {
        fs.unlinkSync(IPC_SOCKET_PATH);
      } catch { /* ignore */ }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  }
}
