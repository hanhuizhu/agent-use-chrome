/**
 * MCP server：对 agent（Claude Code / Codex）侧暴露浏览器操作工具
 *
 * 每个工具调用 -> BridgeWsServer.request() -> 扩展执行 -> 返回结果。
 * 文本类结果转成 text content，截图转成 image content。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseDataUrl } from './image.js';
import { BridgeBackend, ScreenshotResult } from './protocol.js';

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

/** 把任意结果包装成 MCP 文本返回 */
function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** 统一错误处理：把扩展/桥错误透传给 agent，不抛异常挂死 */
async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `错误：${message}` }], isError: true };
  }
}

export function createMcpServer(ws: BridgeBackend): McpServer {
  const server = new McpServer({
    name: 'agent-use-chrome',
    version: '0.1.0',
  });

  // 打开 URL / 前进后退 / 刷新
  server.tool(
    'browser_navigate',
    '在当前标签页导航：打开 URL，或执行 back/forward/reload。',
    {
      action: z.enum(['goto', 'back', 'forward', 'reload']).describe('导航动作'),
      url: z.string().optional().describe('action=goto 时的目标 URL'),
    },
    async ({ action, url }) =>
      run(async () => textResult(await ws.request('navigate', { action, url }))),
  );

  // 结构化文本快照
  server.tool(
    'browser_snapshot',
    '获取当前页面的结构化文本快照：标题、可见正文，以及编号的可交互元素（每个带 ref，供 browser_click/browser_type 使用）。优先用它理解页面，成本远低于截图。',
    {},
    async () => run(async () => textResult(await ws.request('snapshot', {}))),
  );

  // 截图（返回 image block）
  server.tool(
    'browser_screenshot',
    '对当前可视区截图。当需要理解视觉布局、验证操作结果、或页面是 canvas/复杂图形时使用。坐标系与快照一致（CSS 像素）。',
    {},
    async () =>
      run(async () => {
        const shot = (await ws.request('screenshot', {})) as ScreenshotResult;
        const { base64, mimeType } = parseDataUrl(shot.dataUrl);
        return {
          content: [
            {
              type: 'text',
              text: `视口 ${shot.cssWidth}x${shot.cssHeight} CSS px（devicePixelRatio=${shot.devicePixelRatio}）`,
            },
            { type: 'image', data: base64, mimeType },
          ],
        };
      }),
  );

  // 点击：ref 优先，退化为坐标
  server.tool(
    'browser_click',
    '点击一个元素。优先用 browser_snapshot 返回的 ref；也可用 x/y 坐标（CSS 像素，配合截图）。',
    {
      ref: z.string().optional().describe('快照中元素的 ref'),
      x: z.number().optional().describe('CSS 像素 X（无 ref 时使用）'),
      y: z.number().optional().describe('CSS 像素 Y（无 ref 时使用）'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('鼠标键，默认 left'),
    },
    async ({ ref, x, y, button }) =>
      run(async () => textResult(await ws.request('click', { ref, x, y, button }))),
  );

  // 输入文本
  server.tool(
    'browser_type',
    '向输入框输入文本。指定 ref 定位元素；submit=true 时输入后回车。',
    {
      ref: z.string().describe('目标输入元素的 ref'),
      text: z.string().describe('要输入的文本'),
      clear: z.boolean().optional().describe('输入前是否清空，默认 true'),
      submit: z.boolean().optional().describe('输入后是否回车，默认 false'),
    },
    async ({ ref, text, clear, submit }) =>
      run(async () => textResult(await ws.request('type', { ref, text, clear, submit }))),
  );

  // 按键
  server.tool(
    'browser_press_key',
    '发送一个按键，如 Enter、Tab、Escape、ArrowDown、PageDown 等。',
    {
      key: z.string().describe('按键名（CDP key，如 Enter / Tab / Escape / ArrowDown）'),
    },
    async ({ key }) => run(async () => textResult(await ws.request('press_key', { key }))),
  );

  // 滚动
  server.tool(
    'browser_scroll',
    '滚动页面。direction 指定方向，amount 为像素（默认一屏）。',
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('滚动方向'),
      amount: z.number().optional().describe('滚动像素，默认约一屏'),
    },
    async ({ direction, amount }) =>
      run(async () => textResult(await ws.request('scroll', { direction, amount }))),
  );

  // 等待
  server.tool(
    'browser_wait',
    '等待：ms 指定固定毫秒；until=load 时等待页面加载完成。',
    {
      ms: z.number().optional().describe('固定等待毫秒'),
      until: z.enum(['load']).optional().describe('等待条件'),
    },
    async ({ ms, until }) =>
      run(async () => textResult(await ws.request('wait', { ms, until }))),
  );

  // 标签页管理
  server.tool(
    'browser_tabs',
    '标签页管理：list 列出所有标签；new 新建（可带 url）；select 切换（by index）；close 关闭（by index）。切换/新建后续操作自动跟随到该标签。',
    {
      action: z.enum(['list', 'new', 'select', 'close']).describe('标签页动作'),
      url: z.string().optional().describe('action=new 时的 URL'),
      index: z.number().optional().describe('action=select/close 时的标签序号（来自 list）'),
    },
    async ({ action, url, index }) =>
      run(async () => textResult(await ws.request('tabs', { action, url, index }))),
  );

  // 当前状态
  server.tool(
    'browser_get_state',
    '获取当前活动标签的 URL、标题、加载状态。',
    {},
    async () => run(async () => textResult(await ws.request('get_state', {}))),
  );

  return server;
}
