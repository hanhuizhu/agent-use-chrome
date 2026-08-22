#!/usr/bin/env node
/**
 * 入口：启动 MCP(stdio) + WS(localhost) 桥进程
 *
 * 配置来源（优先级：环境变量 > 默认值）：
 * - BRIDGE_PORT：指定固定 WS 端口（跳过端口段扫描）
 * - BRIDGE_TOKEN：连接鉴权 token，默认 'local-dev-token'
 *
 * 默认行为：在 12345-12350 端口段内从小到大抢占第一个空闲端口，
 * extension 侧按同一顺序扫描，双方无需手工对齐端口。
 *
 * 注意：stdout 被 MCP stdio 传输占用，所有日志必须走 stderr。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeWsServer } from './ws-server.js';
import { createMcpServer } from './mcp-server.js';
import { PORT_RANGE_START, PORT_RANGE_END } from './protocol.js';

const TOKEN = process.env.BRIDGE_TOKEN ?? 'local-dev-token';

/** 端口候选列表：BRIDGE_PORT 指定则只用它，否则用默认端口段（从小到大） */
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

async function main(): Promise<void> {
  const ws = await BridgeWsServer.create(candidatePorts(), TOKEN);
  ws.onEvent((event, payload) => log('extension event:', event, JSON.stringify(payload)));

  log(`WS server 监听 ws://127.0.0.1:${ws.port}（token=${TOKEN}）`);
  log('等待 Chrome 扩展连接…');

  const mcp = createMcpServer(ws);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('MCP server 已就绪（stdio）');
}

main().catch((err) => {
  log('启动失败：', err);
  process.exit(1);
});
