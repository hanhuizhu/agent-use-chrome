/**
 * chat.js —— 侧边栏「聊天」Tab
 *
 * 两种对接模式（消息都经 background -> WS -> bridge）：
 * - 在线会话（live）：投递给正在 chat_listen 监听的 CC 会话，回复实时推回
 * - 历史会话（CLI）：bridge spawn `claude` CLI headless 执行，流式结果推回
 */

const NEW_SESSION_VALUE = '__new__';
const LIVE_PREFIX = 'live:'; // 在线会话的 option value 前缀 / 流事件 turnId 前缀

const sessionSelect = document.getElementById('sessionSelect');
const projectRow = document.getElementById('projectRow');
const projectSelect = document.getElementById('projectSelect');
const permissionSelect = document.getElementById('permissionSelect');
const bypassWarn = document.getElementById('bypassWarn');
const messagesEl = document.getElementById('messages');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');

/** 面板聊天状态 */
const chatState = {
  sessions: [], // list_sessions 结果（历史会话）
  live: [], // list_live 结果（在线会话）
  running: false, // 是否有进行中的 CLI 轮次（live 模式无轮次概念）
  currentTurnId: null, // 进行中 CLI 轮次的 turnId
  newSessionId: null, // 「新会话」首轮返回的 session id，后续消息续接它
  assistantEl: null, // 当前轮次的助手气泡（文本块追加于此）
};

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
  appendSystem('与扩展后台断开，请重新打开侧边栏');
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

async function loadSessions() {
  sessionSelect.innerHTML = '<option value="">加载会话中…</option>';
  try {
    const liveReq = chatRequest('list_live');
    const histReq = chatRequest('list_sessions');
    chatState.live = (await liveReq.promise) ?? [];
    chatState.sessions = (await histReq.promise) ?? [];
    renderSessionOptions();
  } catch (err) {
    sessionSelect.innerHTML = `<option value="">加载失败：${escapeText(err.message)}</option>`;
  }
}

function renderSessionOptions() {
  sessionSelect.innerHTML = '';

  // 在线会话：实时对接正在监听的 CC 会话（无需 CLI 登录态）
  if (chatState.live.length > 0) {
    const liveGroup = document.createElement('optgroup');
    liveGroup.label = '🟢 在线会话（实时）';
    for (const l of chatState.live) {
      const opt = document.createElement('option');
      opt.value = `${LIVE_PREFIX}${l.key}`;
      opt.textContent = `🟢 ${l.label}`;
      liveGroup.appendChild(opt);
    }
    sessionSelect.appendChild(liveGroup);
  }

  const histGroup = document.createElement('optgroup');
  histGroup.label = '历史会话（headless CLI）';
  const newOpt = document.createElement('option');
  newOpt.value = NEW_SESSION_VALUE;
  newOpt.textContent = '＋ 新会话（选择项目）';
  histGroup.appendChild(newOpt);
  for (const s of chatState.sessions) {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = `[${projectName(s.cwd)}] ${s.title} · ${formatTime(s.mtime)}`;
    histGroup.appendChild(opt);
  }
  sessionSelect.appendChild(histGroup);

  // 默认选中：在线会话优先，其次最近历史会话
  if (chatState.live.length > 0) {
    sessionSelect.value = `${LIVE_PREFIX}${chatState.live[0].key}`;
  } else if (chatState.sessions.length > 0) {
    sessionSelect.value = chatState.sessions[0].sessionId;
  }
  syncProjectRow();
}

/** 新会话时显示项目选择（从已有会话的 cwd 去重而来）；在线会话隐藏权限选择 */
function syncProjectRow() {
  const isNew = sessionSelect.value === NEW_SESSION_VALUE;
  const isLive = sessionSelect.value.startsWith(LIVE_PREFIX);
  projectRow.classList.toggle('hidden', !isNew);
  // 在线会话的权限由该 CC 会话自身的交互确认机制管理，面板选择不生效
  permissionSelect.parentElement.classList.toggle('hidden', isLive);
  bypassWarn.classList.toggle(
    'hidden',
    isLive || permissionSelect.value !== 'bypassPermissions',
  );
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

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendBubble(role, text) {
  const div = document.createElement('div');
  div.className = `msg msg--${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function appendToolUse(name, summary) {
  const div = document.createElement('div');
  div.className = 'msg msg--tool';
  div.textContent = `▸ ${name} ${summary}`;
  div.title = summary;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function appendSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg msg--system';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

// ------------------------- 流事件处理 -------------------------

function handleStreamEvent(turnId, event) {
  // 在线会话的推送：无轮次生命周期，随时渲染（system 提示 / 回复文本）
  if (turnId.startsWith(LIVE_PREFIX)) {
    if (event.kind === 'system') {
      appendSystem(event.message);
    } else if (event.kind === 'text') {
      appendBubble('assistant', event.text);
    }
    return;
  }

  if (turnId !== chatState.currentTurnId) return; // 过期轮次的残留事件

  switch (event.kind) {
    case 'text': {
      // 同一轮次的多个文本块追加到同一个助手气泡
      if (!chatState.assistantEl) {
        chatState.assistantEl = appendBubble('assistant', event.text);
      } else {
        chatState.assistantEl.textContent += `\n\n${event.text}`;
      }
      // 工具调用之后的新文本另起气泡，视觉上区分阶段
      scrollToBottom();
      break;
    }
    case 'tool_use': {
      appendToolUse(event.name, event.summary);
      chatState.assistantEl = null; // 工具调用后文本另起气泡
      break;
    }
    case 'result': {
      finishTurn();
      if (event.sessionId && sessionSelect.value === NEW_SESSION_VALUE) {
        chatState.newSessionId = event.sessionId; // 新会话建立，后续消息续接
      }
      const cost = typeof event.costUsd === 'number' ? ` · $${event.costUsd.toFixed(4)}` : '';
      const dur =
        typeof event.durationMs === 'number' ? `${(event.durationMs / 1000).toFixed(1)}s` : '';
      appendSystem(`${event.ok ? '✓ 完成' : '✗ 出错'} ${dur}${cost}`);
      break;
    }
    case 'error': {
      finishTurn();
      appendSystem(`✗ ${event.message}`);
      break;
    }
  }
}

function finishTurn() {
  chatState.running = false;
  chatState.currentTurnId = null;
  chatState.assistantEl = null;
  chatSend.textContent = '发送';
  chatSend.classList.remove('btn--danger');
  chatSend.classList.add('btn--primary');
}

// ------------------------- 发送 / 取消 -------------------------

/** 解析当前选择，得到 send 参数；不合法时返回 null 并提示 */
function resolveSendTarget() {
  const selected = sessionSelect.value;
  if (selected.startsWith(LIVE_PREFIX)) {
    return { mode: 'live', key: selected.slice(LIVE_PREFIX.length) };
  }
  if (selected === NEW_SESSION_VALUE) {
    // 新会话：首轮不带 sessionId；后续轮次续接返回的 id
    const cwd = projectSelect.value;
    if (!cwd) {
      appendSystem('请先选择新会话所属的项目目录');
      return null;
    }
    return { sessionId: chatState.newSessionId ?? undefined, cwd };
  }
  const session = chatState.sessions.find((s) => s.sessionId === selected);
  if (!session) {
    appendSystem('请先选择一个会话');
    return null;
  }
  return { sessionId: session.sessionId, cwd: session.cwd };
}

async function sendMessage() {
  if (chatState.running) {
    // 进行中 -> 按钮是「停止」
    const { promise } = chatRequest('cancel');
    promise.catch(() => {});
    return;
  }

  const message = chatInput.value.trim();
  if (!message) return;
  const target = resolveSendTarget();
  if (!target) return;

  // 在线会话：投递即回，无轮次状态；回复由 live 流事件随时渲染
  if (target.mode === 'live') {
    const { promise } = chatRequest('send', { ...target, message });
    appendBubble('user', message);
    chatInput.value = '';
    try {
      await promise;
    } catch (err) {
      appendSystem(`✗ ${err.message}`);
    }
    return;
  }

  const { id, promise } = chatRequest('send', {
    ...target,
    message,
    permissionMode: permissionSelect.value,
  });

  chatState.running = true;
  chatState.currentTurnId = id;
  chatState.assistantEl = null;
  chatInput.value = '';
  appendBubble('user', message);
  chatSend.textContent = '停止';
  chatSend.classList.remove('btn--primary');
  chatSend.classList.add('btn--danger');

  try {
    await promise; // { started: true }，流事件随后到达
  } catch (err) {
    finishTurn();
    appendSystem(`✗ ${err.message}`);
  }
}

// ------------------------- 事件绑定 -------------------------

chatSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});

sessionSelect.addEventListener('change', () => {
  chatState.newSessionId = null; // 切换目标后重置新会话续接状态
  syncProjectRow();
});

permissionSelect.addEventListener('change', () => {
  bypassWarn.classList.toggle('hidden', permissionSelect.value !== 'bypassPermissions');
});

document.getElementById('refreshSessions').addEventListener('click', loadSessions);

// 打开面板即加载会话列表
loadSessions();
