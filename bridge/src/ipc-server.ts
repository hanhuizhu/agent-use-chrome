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

  /**
   * 绑定 IPC socket（同时充当「选主锁」）：
   * - 直接尝试 listen；EADDRINUSE 时探测残留 socket 是否有存活 Primary
   * - 有存活 Primary 则抛错（调用方应转为 Proxy 模式），绝不误删活体的 socket 文件
   * - 探测被拒绝（进程已死的残留文件）才 unlink 后重试绑定
   */
  async start(): Promise<void> {
    try {
      await this.listen();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        throw err;
      }
      const alive = await IpcServer.probeSocketAlive();
      if (alive) {
        throw new Error('已有存活的 Primary 占用 IPC socket');
      }
      // 残留的死文件：清理后重新绑定
      try {
        fs.unlinkSync(IPC_SOCKET_PATH);
      } catch {
        // 已被别人清理则忽略
      }
      await this.listen();
    }
    this.setupCleanup();
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(IPC_SOCKET_PATH);
    });
  }

  /** 探测 IPC socket 是否有存活进程在监听（能建连即视为存活） */
  private static probeSocketAlive(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.createConnection(IPC_SOCKET_PATH);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(false);
      }, 1000);
      probe.once('connect', () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /** 停止监听并清理 socket 文件（选主失败回滚时使用） */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      for (const client of this.clients) {
        client.destroy();
      }
      this.clients.clear();
    });
    try {
      fs.unlinkSync(IPC_SOCKET_PATH);
    } catch {
      // ignore
    }
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
