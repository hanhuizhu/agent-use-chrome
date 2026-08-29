/**
 * chat-hub：在线会话消息中枢（仅 Primary 模式）
 *
 * agent 侧（任意 CC 会话，含 Proxy 模式）经 MCP 工具走 BridgeBackend 到达这里：
 * - chat_listen：长轮询。面板有新消息立即返回；无消息挂起至超时返回空数组
 * - chat_reply：把回复推送到侧边栏面板
 *
 * 面板侧经 ChatHandler 调用：
 * - enqueue：向指定在线会话投递消息（有挂起的 listen 则立即唤醒）
 * - listLive：列出在线会话（有挂起 listen 或近期活跃）
 */

import { ChatLiveListener, ChatStreamMessage, LISTEN_TIMEOUT_MS } from './protocol.js';

/** listen 超时后多久仍视为在线（容忍 agent 处理消息的间隙） */
const ONLINE_GRACE_MS = 90_000;

interface Waiter {
  resolve: (messages: string[]) => void;
  timer: NodeJS.Timeout;
}

interface Listener {
  label: string;
  queue: string[]; // 待取走的面板消息
  waiter: Waiter | null; // 挂起中的 chat_listen
  lastSeen: number; // 最近一次 listen 的时间戳
}

type PushFn = (msg: ChatStreamMessage) => void;

export class ChatHub {
  private listeners = new Map<string, Listener>();

  constructor(private readonly push: PushFn) {}

  /** 处理 agent 侧经 BridgeBackend 转来的 chat_* 方法 */
  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    const key = String(params.key ?? '');
    if (!key) {
      throw new Error('缺少会话标识 key');
    }
    switch (method) {
      case 'chat_listen':
        return this.listen(key, String(params.label ?? key));
      case 'chat_reply':
        return this.reply(key, String(params.text ?? ''));
      default:
        throw new Error(`未知聊天方法 ${method}`);
    }
  }

  /** 长轮询：有消息立即返回，否则挂起至超时 */
  private listen(key: string, label: string): Promise<{ messages: string[] }> {
    let listener = this.listeners.get(key);
    if (!listener) {
      listener = { label, queue: [], waiter: null, lastSeen: Date.now() };
      this.listeners.set(key, listener);
      this.pushSystem(key, `已连接：${label}`);
    }
    listener.label = label;
    listener.lastSeen = Date.now();

    // 同一会话重复 listen：先把旧的空手放行
    if (listener.waiter) {
      clearTimeout(listener.waiter.timer);
      listener.waiter.resolve([]);
      listener.waiter = null;
    }

    if (listener.queue.length > 0) {
      const messages = listener.queue.splice(0);
      return Promise.resolve({ messages });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (listener!.waiter) {
          listener!.waiter = null;
          resolve({ messages: [] });
        }
      }, LISTEN_TIMEOUT_MS);
      listener!.waiter = { resolve: (messages) => resolve({ messages }), timer };
    });
  }

  /** agent 回复 -> 推送到面板 */
  private reply(key: string, text: string): { ok: true } {
    if (!text.trim()) {
      throw new Error('回复内容不能为空');
    }
    const listener = this.listeners.get(key);
    if (listener) {
      listener.lastSeen = Date.now();
    }
    this.push({
      type: 'chat_stream',
      turnId: `live:${key}`,
      event: { kind: 'text', text },
    });
    return { ok: true };
  }

  /** 面板向在线会话投递消息 */
  enqueue(key: string, message: string): { delivered: boolean } {
    const listener = this.listeners.get(key);
    if (!listener || !this.isOnline(listener)) {
      throw new Error('该会话已离线（agent 侧的监听循环可能已停止），请刷新会话列表');
    }
    if (listener.waiter) {
      const waiter = listener.waiter;
      listener.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve([message]);
      return { delivered: true };
    }
    listener.queue.push(message);
    return { delivered: true };
  }

  /** 在线会话列表 */
  listLive(): ChatLiveListener[] {
    const result: ChatLiveListener[] = [];
    for (const [key, listener] of this.listeners) {
      if (this.isOnline(listener)) {
        result.push({ key, label: listener.label });
      } else {
        this.listeners.delete(key); // 顺手清理离线会话
      }
    }
    return result;
  }

  private isOnline(listener: Listener): boolean {
    return listener.waiter !== null || Date.now() - listener.lastSeen < ONLINE_GRACE_MS;
  }

  /** 面板系统提示（连接/断开等） */
  private pushSystem(key: string, text: string): void {
    this.push({
      type: 'chat_stream',
      turnId: `live:${key}`,
      event: { kind: 'system', message: text },
    });
  }
}
