#!/usr/bin/env node
/**
 * 入口：启动 MCP(stdio) + WS/IPC 桥进程（单例模式）
 *
 * 启动逻辑：
 * 1. 尝试连接 IPC_SOCKET_PATH → 成功则进入 Proxy 模式（复用 Primary 的 WS 连接）
 * 2. 连接失败 → 进入 Primary 模式（创建 WS server + IPC server）
 *
 * 配置来源（优先级：环境变量 > 默认值）：
 * - BRIDGE_PORT：指定固定 WS 端口（跳过端口段扫描，仅 Primary 模式有效）
 * - BRIDGE_TOKEN：连接鉴权 token，默认 'local-dev-token'
 *
 * 注意：stdout 被 MCP stdio 传输占用，所有日志必须走 stderr。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeWsServer } from './ws-server.js';
import { IpcServer } from './ipc-server.js';
import { IpcProxy } from './ipc-proxy.js';
import { ChatHandler } from './chat-handler.js';
import { ChatHub } from './chat-hub.js';
import { createMcpServer } from './mcp-server.js';
import { BridgeBackend, BridgeMethod, PORT_RANGE_START, PORT_RANGE_END } from './protocol.js';

const TOKEN = process.env.BRIDGE_TOKEN ?? 'local-dev-token';

/** 端口候选列表：BRIDGE_PORT 指定则只用它，否则用默认端口段 */
function candidatePorts(): number[] {
  const fixed = process.env.BRIDGE_PORT;
  if (fixed) {
    return [Number(fixed)];
  }
  const ports: number[] = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p += 1) {
    ports.push(p);
  }
  return ports;
}

/** 日志走 stderr，避免污染 MCP stdio 通道 */
function log(...args: unknown[]): void {
  console.error('[bridge]', ...args);
}

/** 尝试以 Proxy 模式启动：连接已有的 Primary */
async function tryProxyMode(): Promise<BridgeBackend | null> {
  try {
    const proxy = await IpcProxy.connect();
    log('Proxy 模式：已连接到 Primary 进程');
    return proxy;
  } catch {
    return null;
  }
}

/** 以 Primary 模式启动：创建 WS server + IPC server + 聊天中枢 */
async function startPrimaryMode(): Promise<BridgeBackend> {
  const ws = await BridgeWsServer.create(candidatePorts(), TOKEN);
  ws.onEvent((event, payload) => log('extension event:', event, JSON.stringify(payload)));
  log(`Primary 模式：WS server 监听 ws://127.0.0.1:${ws.port}（token=${TOKEN}）`);
  log('等待 Chrome 扩展连接…');

  // 在线会话中枢：chat_listen/chat_reply 在 Primary 本地处理，不经 extension
  const hub = new ChatHub((msg) => ws.pushChat(msg));
  const backend: BridgeBackend = {
    request: (method: BridgeMethod, params: Record<string, unknown> = {}) =>
      method === 'chat_listen' || method === 'chat_reply'
        ? hub.handle(method, params)
        : ws.request(method, params),
    get connected() {
      return ws.connected;
    },
    onEvent: (listener) => ws.onEvent(listener),
  };

  const ipc = new IpcServer(backend);
  await ipc.start();
  log('IPC server 已就绪，等待 Proxy 连接');

  // 侧边栏聊天：仅 Primary 处理（chat_request 经 WS 反向到达）
  const chat = new ChatHandler((msg) => ws.pushChat(msg), hub);
  ws.onChatRequest((msg) => {
    void chat.handle(msg);
  });
  log('Chat handler 已就绪（侧边栏可对接 CC 会话）');

  return backend;
}

async function main(): Promise<void> {
  // 优先尝试 Proxy 模式
  const backend: BridgeBackend = (await tryProxyMode()) ?? (await startPrimaryMode());

  const mcp = createMcpServer(backend);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('MCP server 已就绪（stdio）');
}

main().catch((err) => {
  log('启动失败：', err);
  process.exit(1);
});
