#!/usr/bin/env node
/**
 * 入口：启动 MCP(stdio) + WS/IPC 桥进程（单例模式 + 失效接管）
 *
 * 启动逻辑：
 * 1. 尝试连接 IPC_SOCKET_PATH → 成功则进入 Proxy 模式（复用 Primary 的 WS 连接）
 * 2. 连接失败 → 进入 Primary 模式（创建 IPC server + WS server）
 *
 * 失效接管（re-election）：
 * Proxy 检测到 Primary 退出（IPC 断开）后自动重新选主——
 * 先尝试连接新 Primary，连不上则自己接管为 Primary。
 * IPC socket 充当选主锁（EADDRINUSE + 活体探测防止双主/误删）。
 * MCP 侧经 BackendManager 无感切换。
 *
 * 配置来源（优先级：环境变量 > 默认值）：
 * - BRIDGE_PORT：覆盖默认 WS 端口 12345（测试隔离用，仅 Primary 模式有效）
 * - BRIDGE_TOKEN：连接鉴权 token，默认 'local-dev-token'
 * - BRIDGE_IPC_PATH：IPC socket 路径（测试隔离用）
 *
 * 注意：stdout 被 MCP stdio 传输占用，所有日志必须走 stderr。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeWsServer } from './ws-server.js';
import { IpcServer } from './ipc-server.js';
import { IpcProxy } from './ipc-proxy.js';
import { ChatHandler } from './chat-handler.js';
import { createMcpServer } from './mcp-server.js';
import { BackendManager } from './backend-manager.js';
import { WS_PORT } from './protocol.js';

const TOKEN = process.env.BRIDGE_TOKEN ?? 'local-dev-token';

/** 选主失败后的重试间隔（毫秒） */
const REELECT_RETRY_MS = 1000;

/** WS 端口：BRIDGE_PORT 可覆盖（测试隔离用），默认固定 12345 */
function wsPort(): number {
  const fixed = process.env.BRIDGE_PORT;
  return fixed ? Number(fixed) : WS_PORT;
}

/** 日志走 stderr，避免污染 MCP stdio 通道 */
function log(...args: unknown[]): void {
  console.error('[bridge]', ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尝试以 Proxy 模式启动：连接已有的 Primary */
async function tryProxyMode(): Promise<IpcProxy | null> {
  try {
    return await IpcProxy.connect();
  } catch {
    return null;
  }
}

/**
 * 以 Primary 模式启动：先抢 IPC socket（选主锁），再创建 WS server。
 * IPC 抢锁失败（已有存活 Primary）或 WS 端口全占时抛错并回滚。
 */
async function startPrimaryMode(manager: BackendManager): Promise<BridgeWsServer> {
  const ipc = new IpcServer(manager);
  await ipc.start();

  let ws: BridgeWsServer;
  try {
    ws = await BridgeWsServer.create(wsPort(), TOKEN);
  } catch (err) {
    await ipc.stop(); // 释放选主锁，让其他进程有机会接管
    throw err;
  }

  ws.onEvent((event, payload) => log('extension event:', event, JSON.stringify(payload)));
  log(`Primary 模式：WS server 监听 ws://127.0.0.1:${ws.port}（token=${TOKEN}）`);

  // 侧边栏聊天：仅 Primary 处理（chat_request 经 WS 反向到达）
  const chat = new ChatHandler((msg) => ws.pushChat(msg));
  ws.onChatRequest((msg) => {
    void chat.handle(msg);
  });
  log('IPC server / Chat handler 已就绪');

  return ws;
}

/** 采纳 Proxy backend，并挂断线重选监听 */
function adoptProxy(manager: BackendManager, proxy: IpcProxy): void {
  manager.setBackend(proxy);
  proxy.onDisconnect(() => {
    void reelect(manager);
  });
}

/**
 * 重新选主：Primary 退出后由存活的 Proxy 竞选。
 * 随机抖动降低多个 Proxy 同时竞选的碰撞概率；
 * 竞选失败（别人赢了）则转为连接新 Primary。
 */
async function reelect(manager: BackendManager): Promise<void> {
  manager.markElecting();
  log('Primary 已退出，开始重新选主…');
  // 无限重试：期间 MCP 请求返回「正在重新选主」错误
  for (;;) {
    await sleep(100 + Math.random() * 400);

    const proxy = await tryProxyMode();
    if (proxy) {
      adoptProxy(manager, proxy);
      log('Proxy 模式：已连接到新 Primary');
      return;
    }

    try {
      const ws = await startPrimaryMode(manager);
      manager.setBackend(ws);
      log('已接管为 Primary');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`接管 Primary 未成功（${message}），稍后重试`);
    }
    await sleep(REELECT_RETRY_MS);
  }
}

async function main(): Promise<void> {
  const manager = new BackendManager();

  // 优先尝试 Proxy 模式
  const proxy = await tryProxyMode();
  if (proxy) {
    adoptProxy(manager, proxy);
    log('Proxy 模式：已连接到 Primary 进程');
  } else {
    const ws = await startPrimaryMode(manager);
    manager.setBackend(ws);
    log('等待 Chrome 扩展连接…');
  }

  const mcp = createMcpServer(manager);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('MCP server 已就绪（stdio）');
}

main().catch((err) => {
  log('启动失败：', err);
  process.exit(1);
});
