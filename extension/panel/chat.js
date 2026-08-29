/**
 * chat.js —— 侧边栏「聊天」Tab
 *
 * 唯一通道：消息经 background -> WS -> bridge，由 bridge spawn claude CLI headless 处理。
 * bridge 全局串行执行；忙时新消息在 bridge 侧排队（气泡带「排队中」标签），
 * 前一轮结束后自动续发（turn_start 事件到达即切换为处理中）。
 */

const NEW_SESSION_VALUE = '__new__';

const projectRow = document.getElementById('projectRow');
const projectSelect = document.getElementById('projectSelect');
const permissionSelect = document.getElementById('permissionSelect');
const bypassWarn = document.getElementById('bypassWarn');
const settingsToggle = document.getElementById('settingsToggle');
const settingsPop = document.getElementById('settingsPop');
const messagesEl = document.getElementById('messages');
const emptyState = document.getElementById('emptyState');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatStop = document.getElementById('chatStop');

/** 单个轮次（turnId）的渲染状态 */
function createTurn(turnId) {
  return {
    turnId,
    done: false,
    userEl: null, // 用户气泡（排队标签挂它下面）
    queueTag: null, // 「排队中」标签元素
    thinkingEl: null, // 思考中动画元素
    streamEl: null, // 当前流式助手内容元素
    streamText: '', // 已累积的流式文本
  };
}

const chatState = {
  sessions: [], // list_sessions 结果
  newSessionId: null, // 「新会话」首轮返回的 session id，后续消息续接它
  turns: new Map(), // turnId -> turn
  historySeq: 0, // 历史加载序号：快速切换会话时丢弃过期结果
};

// 自定义会话下拉（原生 select 无法美化下拉面板）
const picker = globalThis.SessionPicker.init({
  onChange: (value) => {
    chatState.newSessionId = null; // 切换目标后重置新会话续接状态
    syncProjectRow();
    void loadHistory(value);
  },
});

const pendingRequests = new Map(); // id -> { resolve, reject }

// ------------------------- 与 background 的长连接 -------------------------

const port = chrome.runtime.connect({ name: 'chat' });

port.onMessage.addListener((msg) => {
  if (msg?.type === 'chat_response') {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error ?? '未知错误'));
    }
  } else if (msg?.type === 'chat_stream') {
    handleStreamEvent(msg.turnId, msg.event);
  }
});

port.onDisconnect.addListener(() => {
  appendMeta('与扩展后台断开，请重新打开侧边栏', true);
});

/** 发起一次聊天请求（Promise 化） */
function chatRequest(method, params = {}) {
  const id = crypto.randomUUID();
  return {
    id,
    promise: new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      port.postMessage({ type: 'chat_request', id, method, params });
    }),
  };
}

// ------------------------- 会话列表 -------------------------

function formatTime(mtime) {
  const d = new Date(mtime);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return isToday ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

function projectName(cwd) {
  return cwd ? cwd.split('/').filter(Boolean).pop() : '(未知项目)';
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function loadSessions() {
  picker.setPlaceholder('加载会话中…');
  try {
    chatState.sessions = (await chatRequest('list_sessions').promise) ?? [];
    renderSessionOptions();
  } catch (err) {
    picker.setPlaceholder(`加载失败：${err.message}`);
  }
}

function renderSessionOptions() {
  const options = [
    { value: NEW_SESSION_VALUE, title: '＋ 新会话（选择项目）' },
    ...chatState.sessions.map((s) => ({
      value: s.sessionId,
      title: s.title,
      sub: `${projectName(s.cwd)} · ${formatTime(s.mtime)}`,
    })),
  ];
  picker.setOptions(options);
  // 默认选中最近会话并回放其历史
  if (!picker.getValue() && chatState.sessions.length > 0) {
    picker.setValue(chatState.sessions[0].sessionId);
    void loadHistory(picker.getValue());
  }
  syncProjectRow();
}

/** 新会话时显示项目选择（从已有会话的 cwd 去重而来） */
function syncProjectRow() {
  const isNew = picker.getValue() === NEW_SESSION_VALUE;
  projectRow.classList.toggle('hidden', !isNew);
  if (!isNew) return;

  const cwds = [...new Set(chatState.sessions.map((s) => s.cwd).filter(Boolean))];
  projectSelect.innerHTML = '';
  for (const cwd of cwds) {
    const opt = document.createElement('option');
    opt.value = cwd;
    opt.textContent = `${projectName(cwd)}（${cwd}）`;
    projectSelect.appendChild(opt);
  }
  if (cwds.length === 0) {
    projectSelect.innerHTML = '<option value="">无可用项目（先在终端里用过 CC）</option>';
  }
}

// ------------------------- 消息渲染 -------------------------

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideEmptyState() {
  emptyState?.classList.add('hidden');
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function appendPlainUserBubble(text) {
  hideEmptyState();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--user';
  const body = document.createElement('div');
  body.className = 'msg__body';
  body.textContent = text;
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function appendUserBubble(turn, text) {
  turn.userEl = appendPlainUserBubble(text);
}

function addQueueTag(turn, position) {
  const tag = document.createElement('div');
  tag.className = 'msg__tag';
  tag.textContent = `⏳ 排队中（第 ${position} 位）`;
  turn.userEl?.appendChild(tag);
  turn.queueTag = tag;
  scrollToBottom();
}

function removeQueueTag(turn) {
  turn.queueTag?.remove();
  turn.queueTag = null;
}

function appendAssistantBlock(time = nowTime()) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--assistant';
  const role = document.createElement('div');
  role.className = 'msg__role';
  role.innerHTML = `✳ Claude${time ? ` <span class="msg__time">${time}</span>` : ''}`;
  const body = document.createElement('div');
  body.className = 'msg__body md';
  wrap.appendChild(role);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return body;
}

function renderAssistant(bodyEl, text) {
  bodyEl.innerHTML = globalThis.renderMarkdown(text);
  scrollToBottom();
}

function appendToolCard(name, summary) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  const head = document.createElement('button');
  head.className = 'tool-card__head';
  head.innerHTML = `<span class="tool-card__arrow">▸</span> ${escapeText(name)} <span class="tool-card__hint">${escapeText(summary)}</span>`;
  const detail = document.createElement('pre');
  detail.className = 'tool-card__detail hidden';
  detail.textContent = summary;
  head.addEventListener('click', () => {
    detail.classList.toggle('hidden');
    card.classList.toggle('tool-card--open');
  });
  card.appendChild(head);
  card.appendChild(detail);
  messagesEl.appendChild(card);
  scrollToBottom();
}

function appendMeta(text, isError = false) {
  const div = document.createElement('div');
  div.className = `meta-line${isError ? ' meta-line--error' : ''}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function showThinking(turn) {
  if (turn.thinkingEl) return;
  const el = document.createElement('div');
  el.className = 'thinking';
  el.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(el);
  turn.thinkingEl = el;
  scrollToBottom();
}

function clearThinking(turn) {
  turn.thinkingEl?.remove();
  turn.thinkingEl = null;
}

// ------------------------- 历史消息回放 -------------------------

/** 清空消息区并保留空状态元素；进行中轮次的 DOM 引用一并作废（后续事件另起新块） */
function clearMessages() {
  messagesEl.innerHTML = '';
  emptyState.classList.remove('hidden');
  messagesEl.appendChild(emptyState);
  for (const turn of chatState.turns.values()) {
    turn.userEl = null;
    turn.queueTag = null;
    turn.thinkingEl = null;
    turn.streamEl = null;
  }
}

function appendDivider(text) {
  const div = document.createElement('div');
  div.className = 'divider';
  div.textContent = text;
  messagesEl.appendChild(div);
}

function renderHistoryEntry(entry) {
  if (entry.role === 'user') {
    appendPlainUserBubble(entry.text);
  } else if (entry.role === 'assistant') {
    renderAssistant(appendAssistantBlock(''), entry.text);
  } else if (entry.role === 'tool') {
    appendToolCard(entry.name, entry.summary);
  }
}

/** 切换会话时回放该会话的历史消息（最近 100 条） */
async function loadHistory(value) {
  const seq = ++chatState.historySeq;
  clearMessages();
  if (!value || value === NEW_SESSION_VALUE) return;

  const loading = appendMeta('加载历史消息…');
  try {
    const res = await chatRequest('get_history', { sessionId: value }).promise;
    if (seq !== chatState.historySeq) return; // 期间又切换了会话，丢弃
    loading.remove();
    const entries = res?.entries ?? [];
    if (entries.length === 0) return;
    hideEmptyState();
    if (res.truncated) appendDivider('仅显示最近 100 条');
    for (const entry of entries) renderHistoryEntry(entry);
    appendDivider('以上为历史消息');
    scrollToBottom();
  } catch (err) {
    if (seq !== chatState.historySeq) return;
    loading.remove();
    appendMeta(`历史加载失败：${err.message}`, true);
  }
}

// ------------------------- 流事件处理 -------------------------

function activeTurnCount() {
  let n = 0;
  for (const t of chatState.turns.values()) {
    if (!t.done) n += 1;
  }
  return n;
}

function updateComposer() {
  chatStop.classList.toggle('hidden', activeTurnCount() === 0);
}

function handleStreamEvent(turnId, event) {
  if (event.kind === 'system') {
    appendMeta(event.message);
    return;
  }
  const turn = chatState.turns.get(turnId);
  if (!turn || turn.done) return;

  switch (event.kind) {
    case 'turn_start':
      removeQueueTag(turn);
      showThinking(turn);
      break;
    case 'text_delta':
      clearThinking(turn);
      if (!turn.streamEl) {
        turn.streamEl = appendAssistantBlock();
        turn.streamText = '';
      }
      turn.streamText += event.text;
      renderAssistant(turn.streamEl, turn.streamText);
      break;
    case 'text':
      // 整块文本对流式增量「定稿」：覆盖累积内容并结束当前块
      clearThinking(turn);
      if (!turn.streamEl) turn.streamEl = appendAssistantBlock();
      renderAssistant(turn.streamEl, event.text);
      turn.streamEl = null;
      turn.streamText = '';
      break;
    case 'tool_use':
      clearThinking(turn);
      turn.streamEl = null;
      turn.streamText = '';
      appendToolCard(event.name, event.summary);
      showThinking(turn); // 工具执行期间维持思考态
      break;
    case 'result': {
      finishTurn(turn);
      if (event.sessionId && picker.getValue() === NEW_SESSION_VALUE) {
        chatState.newSessionId = event.sessionId;
      }
      const cost = typeof event.costUsd === 'number' ? ` · $${event.costUsd.toFixed(4)}` : '';
      const dur =
        typeof event.durationMs === 'number' ? ` ${(event.durationMs / 1000).toFixed(1)}s` : '';
      appendMeta(`${event.ok ? '✓ 完成' : '✗ 出错'}${dur}${cost}`, !event.ok);
      break;
    }
    case 'error':
      finishTurn(turn);
      appendMeta(`✗ ${event.message}`, true);
      break;
  }
}

function finishTurn(turn) {
  turn.done = true;
  clearThinking(turn);
  removeQueueTag(turn);
  turn.streamEl = null;
  updateComposer();
}

// ------------------------- 发送 / 停止 -------------------------

/** 解析当前选择，得到 send 参数；不合法时返回 null 并提示 */
function resolveSendTarget() {
  const selected = picker.getValue();
  if (selected === NEW_SESSION_VALUE) {
    // 新会话：首轮不带 sessionId；后续轮次续接返回的 id（bridge 侧也会为排队消息续接）
    const cwd = projectSelect.value;
    if (!cwd) {
      appendMeta('请先选择新会话所属的项目目录', true);
      return null;
    }
    return { sessionId: chatState.newSessionId ?? undefined, cwd };
  }
  const session = chatState.sessions.find((s) => s.sessionId === selected);
  if (!session) {
    appendMeta('请先选择一个会话', true);
    return null;
  }
  return { sessionId: session.sessionId, cwd: session.cwd };
}

async function sendMessage() {
  const message = chatInput.value.trim();
  if (!message) return;
  const target = resolveSendTarget();
  if (!target) return;

  const { id, promise } = chatRequest('send', {
    ...target,
    message,
    permissionMode: permissionSelect.value,
  });
  const turn = createTurn(id);
  chatState.turns.set(id, turn);
  appendUserBubble(turn, message);
  chatInput.value = '';
  autoresize();
  updateComposer();

  try {
    const res = await promise;
    if (res?.queued) {
      addQueueTag(turn, res.position);
    } else {
      showThinking(turn);
    }
  } catch (err) {
    finishTurn(turn);
    appendMeta(`✗ ${err.message}`, true);
  }
}

/** 停止当前轮次并清空队列（各轮次的「已取消」由流事件推回） */
function stopAll() {
  chatRequest('cancel').promise.catch(() => {});
}

// ------------------------- 输入区 -------------------------

function autoresize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
}

chatSend.addEventListener('click', sendMessage);
chatStop.addEventListener('click', stopAll);
chatInput.addEventListener('input', autoresize);
chatInput.addEventListener('keydown', (e) => {
  // Enter 发送、Shift+Enter 换行；isComposing 保护中文输入法候选确认
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

settingsToggle.addEventListener('click', () => {
  settingsPop.classList.toggle('hidden');
});

permissionSelect.addEventListener('change', () => {
  bypassWarn.classList.toggle('hidden', permissionSelect.value !== 'bypassPermissions');
});

document.getElementById('refreshSessions').addEventListener('click', loadSessions);

// 打开面板即加载会话列表
loadSessions();
