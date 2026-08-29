/**
 * chat-handler：侧边栏聊天请求的处理器（仅 Primary 模式）
 *
 * 接收 extension 经 WS 转来的 chat_request，按目标分流：
 * - 在线会话（mode=live）：投递给 ChatHub，由挂起的 chat_listen 取走
 * - 历史会话（默认）：SessionManager headless spawn claude CLI 执行
 * 通过注入的 push 函数把 chat_response / chat_stream 发回扩展。
 */

import { ChatRequestMessage, ChatResponseMessage, ChatStreamMessage } from './protocol.js';
import { ChatHub } from './chat-hub.js';
import { SessionManager, RunTurnParams } from './session-manager.js';

type PushFn = (msg: ChatResponseMessage | ChatStreamMessage) => void;

export class ChatHandler {
  private sessions = new SessionManager();

  constructor(
    private readonly push: PushFn,
    private readonly hub: ChatHub,
  ) {}

  async handle(msg: ChatRequestMessage): Promise<void> {
    try {
      const result = await this.dispatch(msg);
      this.push({ type: 'chat_response', id: msg.id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.push({ type: 'chat_response', id: msg.id, ok: false, error: message });
    }
  }

  private async dispatch(msg: ChatRequestMessage): Promise<unknown> {
    switch (msg.method) {
      case 'list_sessions':
        return this.sessions.listSessions();
      case 'list_live':
        return this.hub.listLive();
      case 'send': {
        // 在线会话：直接投递，无轮次生命周期
        if (msg.params.mode === 'live') {
          return this.hub.enqueue(String(msg.params.key ?? ''), String(msg.params.message ?? ''));
        }
        // 历史会话：headless CLI 轮次，turnId 用请求 id
        const params = msg.params as unknown as RunTurnParams;
        this.sessions.runTurn(msg.id, params, (event) => {
          this.push({ type: 'chat_stream', turnId: msg.id, event });
        });
        return { started: true };
      }
      case 'cancel':
        return { cancelled: this.sessions.cancel() };
      default:
        throw new Error(`未知聊天方法 ${(msg as ChatRequestMessage).method}`);
    }
  }
}
