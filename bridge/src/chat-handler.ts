/**
 * chat-handler：侧边栏聊天请求的处理器（仅 Primary 模式）
 *
 * 接收 extension 经 WS 转来的 chat_request，交给 SessionManager
 * headless spawn claude CLI 执行（唯一通道），
 * 通过注入的 push 函数把 chat_response / chat_stream 发回扩展。
 */

import { ChatRequestMessage, ChatResponseMessage, ChatStreamMessage } from './protocol.js';
import { SessionManager, RunTurnParams } from './session-manager.js';

type PushFn = (msg: ChatResponseMessage | ChatStreamMessage) => void;

export class ChatHandler {
  private sessions = new SessionManager();

  constructor(private readonly push: PushFn) {}

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
      case 'send': {
        // headless CLI 轮次，turnId 用请求 id；忙碌时排队（返回 queued + position）
        const params = msg.params as unknown as RunTurnParams;
        return this.sessions.send(msg.id, params, (event) => {
          this.push({ type: 'chat_stream', turnId: msg.id, event });
        });
      }
      case 'cancel':
        return { cancelled: this.sessions.cancel() };
      case 'get_history':
        // 面板切换会话时回放历史消息
        return this.sessions.getHistory(String(msg.params.sessionId ?? ''));
      case 'get_status':
        // 面板重建后查询进行中/排队轮次，接管流式显示
        return this.sessions.getStatus();
      default:
        throw new Error(`未知聊天方法 ${(msg as ChatRequestMessage).method}`);
    }
  }
}
