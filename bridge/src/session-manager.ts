/**
 * session-manager：Claude Code 会话发现 + headless 轮次执行（带队列）
 *
 * - listSessions()：扫描 ~/.claude/projects/<编码目录>/*.jsonl，解析会话元信息
 * - send()：spawn `claude --resume <id> -p <msg> --output-format stream-json
 *   --include-partial-messages` 执行一轮；忙碌时入队，轮次结束后自动续发
 * - cancel()：终止当前轮次并清空队列
 *
 * 注意：stdout 被 MCP stdio 占用，日志走 stderr。
 */

import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir, readFile, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ChatHistoryEntry,
  ChatHistoryResult,
  ChatSessionInfo,
  ChatStatusResult,
  ChatStreamEvent,
} from './protocol.js';

/** 会话列表默认返回条数 */
const MAX_SESSIONS = 30;
/** 解析单个会话文件时最多读取的字节数（元信息都在文件头部） */
const HEAD_READ_BYTES = 64 * 1024;
/** 标题最大长度 */
const TITLE_MAX_LEN = 60;

/** get_history 最多返回的条目数（超出取尾部） */
const MAX_HISTORY_ENTRIES = 100;

/** 支持的权限模式（透传给 claude CLI） */
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);

export interface RunTurnParams {
  sessionId?: string; // 省略则新建会话
  cwd: string; // 工作目录（决定新会话归属的项目）
  message: string;
  permissionMode: string;
}

/** send() 的即时返回：立即执行 or 排队 */
export type SendResult = { started: true } | { queued: true; position: number };

interface PendingTurn {
  turnId: string;
  params: RunTurnParams;
  emit: (ev: ChatStreamEvent) => void;
}

export class SessionManager {
  private claudeBin: string | null;
  private spawnImpl: typeof spawn;
  private running: {
    turnId: string;
    child: ChildProcess;
    sessionId: string | null; // 新会话轮次在 result 前为 null
    message: string;
  } | null = null;
  private queue: PendingTurn[] = [];
  /** 本轮忙碌链中新会话产生的 id：排队的「新会话」消息出队时续接它；空闲后清空 */
  private chainSessionId: string | null = null;

  constructor(opts: { spawnImpl?: typeof spawn; claudeBin?: string | null } = {}) {
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.claudeBin = 'claudeBin' in opts ? (opts.claudeBin ?? null) : resolveClaudeBin();
  }

  /** 列出最近的 CC 会话（按最后活跃时间倒序） */
  async listSessions(): Promise<ChatSessionInfo[]> {
    this.assertClaudeAvailable();
    const projectsDir = join(homedir(), '.claude', 'projects');
    let projectDirs: string[];
    try {
      projectDirs = await readdir(projectsDir);
    } catch {
      return [];
    }

    const candidates: { file: string; mtime: number }[] = [];
    for (const dir of projectDirs) {
      const abs = join(projectsDir, dir);
      let files: string[];
      try {
        files = await readdir(abs);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const st = await stat(join(abs, f));
          candidates.push({ file: join(abs, f), mtime: st.mtimeMs });
        } catch {
          // 忽略读取失败的文件
        }
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    const sessions: ChatSessionInfo[] = [];
    for (const c of candidates) {
      if (sessions.length >= MAX_SESSIONS) break;
      const info = await parseSessionHead(c.file, c.mtime);
      if (info) sessions.push(info);
    }
    return sessions;
  }

  /** 面板发消息：空闲立即执行，忙碌入队（轮次结束后自动续发） */
  send(turnId: string, params: RunTurnParams, emit: (ev: ChatStreamEvent) => void): SendResult {
    this.assertClaudeAvailable();
    if (!PERMISSION_MODES.has(params.permissionMode)) {
      throw new Error(`不支持的权限模式：${params.permissionMode}`);
    }
    if (!params.message?.trim()) {
      throw new Error('消息不能为空');
    }
    if (this.running) {
      this.queue.push({ turnId, params, emit });
      return { queued: true, position: this.queue.length };
    }
    this.runTurn({ turnId, params, emit });
    return { started: true };
  }

  /** 执行一次 headless 轮次，流式事件通过 turn.emit 回调 */
  private runTurn(turn: PendingTurn): void {
    // 新会话消息（无 sessionId）续接同一忙碌链中已产生的会话 id
    const sessionId = turn.params.sessionId ?? this.chainSessionId ?? undefined;
    const isNewSession = !turn.params.sessionId;
    const args = [
      ...(sessionId ? ['--resume', sessionId] : []),
      '-p',
      turn.params.message,
      '--output-format',
      'stream-json',
      '--verbose', // stream-json + --print 必需
      '--include-partial-messages', // 文本增量流式推送
      '--permission-mode',
      turn.params.permissionMode,
    ];

    const child = this.spawnImpl(this.claudeBin as string, args, {
      cwd: turn.params.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.running = {
      turnId: turn.turnId,
      child,
      sessionId: sessionId ?? null,
      message: turn.params.message,
    };

    let gotResult = false;
    const stderrTail: string[] = [];

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const events = mapStreamJsonLine(line);
      if (!events) return;
      for (const ev of events) {
        if (ev.kind === 'result') {
          gotResult = true;
          if (isNewSession && ev.sessionId) this.chainSessionId = ev.sessionId;
        }
        turn.emit(ev);
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail.push(chunk.toString());
      if (stderrTail.length > 20) stderrTail.shift();
    });

    child.on('error', (err) => {
      this.running = null;
      turn.emit({ kind: 'error', message: `claude 进程启动失败：${err.message}` });
      this.drainQueue();
    });

    child.on('close', (code, signal) => {
      this.running = null;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        turn.emit({ kind: 'error', message: '已取消' });
      } else if (!gotResult) {
        const detail = stderrTail.join('').trim().slice(-500);
        turn.emit({
          kind: 'error',
          message: `claude 退出（code=${code}）未返回结果${
            detail ? `：${detail}` : ''
          }（若提示 OAuth 过期，请在终端运行一次 claude 重新登录）`,
        });
      }
      this.drainQueue();
    });
  }

  /** 取队首继续执行；队列空则结束忙碌链 */
  private drainQueue(): void {
    const next = this.queue.shift();
    if (!next) {
      this.chainSessionId = null;
      return;
    }
    next.emit({ kind: 'turn_start' });
    this.runTurn(next);
  }

  /** 停止：终止当前轮次并清空队列 */
  cancel(): boolean {
    const cleared = this.queue.splice(0);
    for (const t of cleared) {
      t.emit({ kind: 'error', message: '已取消' });
    }
    if (!this.running) {
      this.chainSessionId = null;
      return cleared.length > 0;
    }
    this.running.child.kill('SIGTERM');
    return true;
  }

  /** 查询进行中/排队中的轮次（面板文档重建后据此接管显示） */
  getStatus(): ChatStatusResult {
    return {
      running: this.running
        ? {
            turnId: this.running.turnId,
            sessionId: this.running.sessionId,
            message: this.running.message,
          }
        : null,
      queue: this.queue.map((t) => ({
        turnId: t.turnId,
        sessionId: t.params.sessionId ?? this.chainSessionId ?? null,
        message: t.params.message,
      })),
    };
  }

  /** 读取指定会话的历史消息（面板切换会话时回放），超过上限只取尾部 */
  async getHistory(sessionId: string): Promise<ChatHistoryResult> {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      throw new Error('无效的会话 id');
    }
    const projectsDir = join(homedir(), '.claude', 'projects');
    let projectDirs: string[];
    try {
      projectDirs = await readdir(projectsDir);
    } catch {
      throw new Error('未找到 CC 会话目录（~/.claude/projects）');
    }

    // 会话文件按 <sessionId>.jsonl 命名，逐项目目录查找
    let content: string | null = null;
    for (const dir of projectDirs) {
      try {
        content = await readFile(join(projectsDir, dir, `${sessionId}.jsonl`), 'utf8');
        break;
      } catch {
        continue;
      }
    }
    if (content === null) {
      throw new Error('未找到该会话的历史文件（可能已被清理）');
    }

    const entries: ChatHistoryEntry[] = [];
    for (const line of content.split('\n')) {
      const mapped = mapHistoryLine(line);
      if (mapped) entries.push(...mapped);
    }
    const truncated = entries.length > MAX_HISTORY_ENTRIES;
    return {
      entries: truncated ? entries.slice(-MAX_HISTORY_ENTRIES) : entries,
      truncated,
    };
  }

  private assertClaudeAvailable(): void {
    if (!this.claudeBin) {
      throw new Error('未找到 claude CLI（which claude 失败），请确认已安装并在 PATH 中');
    }
  }
}

/** 元信息文本（斜杠命令、system-reminder 等）不作为历史消息展示 */
function isMetaText(text: string): boolean {
  return /^<(command-|local-command|system-reminder)/.test(text.trim());
}

/**
 * 把会话 jsonl 的一行映射为 0~N 条历史条目。
 * 只关心 user 文本与 assistant 文本/工具调用；tool_result、元信息行忽略。
 */
export function mapHistoryLine(line: string): ChatHistoryEntry[] | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (obj.type === 'user') {
    const text = extractUserText(obj);
    if (!text.trim() || isMetaText(text)) return null;
    return [{ role: 'user', text }];
  }

  if (obj.type === 'assistant') {
    const message = obj.message as { content?: unknown[] } | undefined;
    if (!Array.isArray(message?.content)) return null;
    const entries: ChatHistoryEntry[] = [];
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        entries.push({ role: 'assistant', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input ? JSON.stringify(block.input) : '';
        entries.push({
          role: 'tool',
          name: block.name,
          summary: input.length > 600 ? `${input.slice(0, 600)}…` : input,
        });
      }
    }
    return entries.length ? entries : null;
  }

  return null;
}

/** 探测 claude 可执行文件路径 */
function resolveClaudeBin(): string | null {
  try {
    const res = spawnSync('which', ['claude'], { encoding: 'utf8' });
    const bin = res.stdout?.trim();
    return res.status === 0 && bin ? bin : null;
  } catch {
    return null;
  }
}

/**
 * 解析会话文件头部，提取 cwd 与标题。
 * cwd 直接读 jsonl 行内的 cwd 字段（比目录名反解码可靠：路径本身可能含 '-'）。
 */
async function parseSessionHead(file: string, mtime: number): Promise<ChatSessionInfo | null> {
  let head: string;
  try {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_READ_BYTES, 0);
      head = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  const sessionId = file.split('/').pop()!.replace(/\.jsonl$/, '');
  let cwd = '';
  let title = '';
  let summary = '';

  for (const line of head.split('\n')) {
    if (cwd && title) break;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 尾部可能是被截断的半行
    }
    if (!cwd && typeof obj.cwd === 'string') {
      cwd = obj.cwd;
    }
    if (!summary && obj.type === 'summary' && typeof obj.summary === 'string') {
      summary = obj.summary;
    }
    if (!title && obj.type === 'user') {
      title = extractUserText(obj);
    }
    // queue-operation 行也携带首条用户输入
    if (!title && obj.type === 'queue-operation' && typeof obj.content === 'string') {
      title = obj.content;
    }
  }

  const finalTitle = (title || summary || sessionId.slice(0, 8)).replace(/\s+/g, ' ').trim();
  return {
    sessionId,
    cwd,
    title: finalTitle.length > TITLE_MAX_LEN ? `${finalTitle.slice(0, TITLE_MAX_LEN)}…` : finalTitle,
    mtime,
  };
}

/** 从 user 类型的 jsonl 行提取纯文本 */
function extractUserText(obj: Record<string, unknown>): string {
  const message = obj.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    }
  }
  return '';
}

/**
 * 把 claude CLI 的一行 stream-json 映射为 0~N 个精简事件。
 * 关注三类：assistant（文本/工具调用）、result（轮次结束）；其余忽略。
 */
export function mapStreamJsonLine(line: string): ChatStreamEvent[] | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (obj.type === 'assistant') {
    const message = obj.message as { content?: unknown[] } | undefined;
    if (!Array.isArray(message?.content)) return null;
    const events: ChatStreamEvent[] = [];
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input ? JSON.stringify(block.input) : '';
        events.push({
          kind: 'tool_use',
          name: block.name,
          summary: input.length > 600 ? `${input.slice(0, 600)}…` : input,
        });
      }
    }
    return events.length ? events : null;
  }

  // --include-partial-messages 产生的流式增量：只关心文本 delta
  if (obj.type === 'stream_event') {
    const ev = obj.event as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    if (
      ev?.type === 'content_block_delta' &&
      ev.delta?.type === 'text_delta' &&
      typeof ev.delta.text === 'string'
    ) {
      return [{ kind: 'text_delta', text: ev.delta.text }];
    }
    return null;
  }

  if (obj.type === 'result') {
    return [
      {
        kind: 'result',
        ok: obj.is_error !== true,
        sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      },
    ];
  }

  return null;
}
