/**
 * chat.js —— 侧边栏「聊天」Tab（per-tab 面板实例）
 *
 * 面板通过 sidePanel.setOptions({ tabId }) 绑定到单个 tab：切走自动收起（文档销毁），
 * 切回自动展开（文档重建）。因此一个面板文档只服务一个 tab，状态无需内存快照，
 * 而是靠持久化恢复：URL -> sessionId 映射存 chrome.storage.local，
 * 同 URL 二次打开时自动复用之前的 CC 会话并回放历史；无映射则默认「新会话」。
 *
 * 唯一通道：消息经 background -> WS -> bridge，由 bridge spawn claude CLI headless 处理。
 * bridge 全局串行执行；忙时新消息在 bridge 侧排队（气泡带「排队中」标签），
 * 前一轮结束后自动续发（turn_start 事件到达即切换为处理中）。
 */

const NEW_SESSION_VALUE = '__new__';
const URL_SESSION_KEY = 'urlSessionMap'; // storage key：URL -> sessionId

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

// 本面板绑定的 tab（per-tab 模式下面板生命周期内不变）
let panelTabId = null;
let panelTabUrl = null; // 打开面板时的 URL（去 hash），用于会话复用查找

// ------------------------- URL -> 会话 绑定 -------------------------

/** 去掉 hash 的 URL 作为绑定 key（同页锚点变化视为同一页面） */
function normalizeUrl(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return null;
  return url.split('#')[0];
}

async function getUrlSessionMap() {
  const res = await chrome.storage.local.get([URL_SESSION_KEY]);
  return res[URL_SESSION_KEY] ?? {};
}

/** 把当前 tab 的最新 URL 绑定到 sessionId（导航后 URL 可能已变化，绑定时实时取） */
async function bindUrlSession(sessionId) {
  if (!sessionId || panelTabId == null) return;
  let url = panelTabUrl;
  try {
    const tab = await chrome.tabs.get(panelTabId);
    url = normalizeUrl(tab?.url) ?? url;
  } catch {
    // tab 可能已关闭，退回打开面板时的 URL
  }
  if (!url) return;
  const map = await getUrlSessionMap();
  map[url] = sessionId;
  await chrome.storage.local.set({ [URL_SESSION_KEY]: map });
}

// 自定义会话下拉（原生 select 无法美化下拉面板）
const picker = globalThis.SessionPicker.init({
  onChange: (value) => {
    chatState.newSessionId = null; // 切换目标后重置新会话续接状态
    syncProjectRow();
    void loadHistory(value);
    // 手动选中已有会话时也绑定到当前 URL：下次同 URL 打开直接复用
    if (value && value !== NEW_SESSION_VALUE) void bindUrlSession(value);
  },
});

const pendingRequests = new Map(); // id -> { resolve, reject }

// ------------------------- 与 background 的长连接 -------------------------

const PORT_RECONNECT_MS = 500; // SW 重启后长连接重建间隔

let port = null;

function handlePortMessage(msg) {
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
}

/** 建立与 background 的长连接；SW 被杀导致断开时自动重建（旧行为是提示用户重开侧边栏） */
function connectChatPort() {
  port = chrome.runtime.connect({ name: 'chat' });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    // 在途请求随旧 SW 一起丢失，立即失败避免挂死
    for (const [, pending] of pendingRequests) {
      pending.reject(new Error('扩展后台已重启，请重试'));
    }
    pendingRequests.clear();
    setTimeout(connectChatPort, PORT_RECONNECT_MS);
  });
}

connectChatPort();

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
    await renderSessionOptions();
  } catch (err) {
    picker.setPlaceholder(`加载失败：${err.message}`);
  }
}

async function renderSessionOptions() {
  const options = [
    { value: NEW_SESSION_VALUE, title: '＋ 新会话（选择项目）' },
    ...chatState.sessions.map((s) => ({
      value: s.sessionId,
      title: s.title,
      sub: `${projectName(s.cwd)} · ${formatTime(s.mtime)}`,
    })),
  ];
  picker.setOptions(options);
  // 默认选择：同 URL 之前绑定过会话则复用，否则默认「新会话」（每个 tab 独立起步）
  if (!picker.getValue()) {
    const map = await getUrlSessionMap();
    const bound = panelTabUrl ? map[panelTabUrl] : null;
    if (bound && chatState.sessions.some((s) => s.sessionId === bound)) {
      picker.setValue(bound);
      void loadHistory(bound);
    } else {
      picker.setValue(NEW_SESSION_VALUE);
    }
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
    if (entries.length > 0) {
      hideEmptyState();
      if (res.truncated) appendDivider('仅显示最近 100 条');
      for (const entry of entries) renderHistoryEntry(entry);
      appendDivider('以上为历史消息');
      scrollToBottom();
    }
    await adoptActiveTurns(value, entries, seq);
  } catch (err) {
    if (seq !== chatState.historySeq) return;
    loading.remove();
    appendMeta(`历史加载失败：${err.message}`, true);
  }
}

/**
 * 面板文档重建后接管该会话进行中/排队中的轮次：
 * 向 bridge 查询 get_status，把在跑的 turnId 注册进 turns，
 * 后续 chat_stream 事件即可正常渲染（流式增量从接管点开始，text 定稿事件会补全整块）。
 */
async function adoptActiveTurns(sessionId, historyEntries, seq) {
  let status;
  try {
    status = await chatRequest('get_status').promise;
  } catch {
    return; // 旧版 bridge 无此方法，静默跳过
  }
  if (seq !== chatState.historySeq) return; // 期间又切换了会话

  const running = status?.running;
  if (running && running.sessionId === sessionId && !chatState.turns.has(running.turnId)) {
    hideEmptyState();
    const turn = createTurn(running.turnId);
    chatState.turns.set(running.turnId, turn);
    // 历史里通常已含该轮的用户消息；没有才补气泡
    const lastUser = [...historyEntries].reverse().find((e) => e.role === 'user');
    if (lastUser?.text !== running.message) appendUserBubble(turn, running.message);
    appendMeta('⟳ 接续进行中的轮次…');
    showThinking(turn);
  }

  for (const [i, q] of (status?.queue ?? []).entries()) {
    if (q.sessionId !== sessionId || chatState.turns.has(q.turnId)) continue;
    const turn = createTurn(q.turnId);
    chatState.turns.set(q.turnId, turn);
    appendUserBubble(turn, q.message);
    addQueueTag(turn, i + 1);
  }
  updateComposer();
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
        // 新会话落地后绑定到当前 URL：同 URL 二次打开面板时复用
        void bindUrlSession(event.sessionId);
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
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 200)}px`;
}

chatSend.addEventListener('click', sendMessage);
chatStop.addEventListener('click', stopAll);
chatInput.addEventListener('input', autoresize);

settingsToggle.addEventListener('click', () => {
  settingsPop.classList.toggle('hidden');
});

permissionSelect.addEventListener('change', () => {
  bypassWarn.classList.toggle('hidden', permissionSelect.value !== 'bypassPermissions');
});

document.getElementById('refreshSessions').addEventListener('click', loadSessions);

// ------------------------- 斜杠命令 -------------------------

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '清空当前消息区' },
  { cmd: '/chrome', desc: '让 Claude 操作当前浏览器标签页' },
];

const slashMenu = document.getElementById('slashMenu');
let slashActiveIdx = -1;
let slashFiltered = [];

function renderSlashMenu(keyword) {
  const kw = keyword.toLowerCase();
  slashFiltered = SLASH_COMMANDS.filter((c) => c.cmd.includes(kw));
  if (slashFiltered.length === 0) {
    slashMenu.classList.add('hidden');
    return;
  }
  slashActiveIdx = 0;
  slashMenu.innerHTML = '';
  slashFiltered.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slash-menu__item' + (i === 0 ? ' slash-menu__item--active' : '');
    btn.innerHTML = `<span class="slash-menu__cmd">${c.cmd}</span><span class="slash-menu__desc">${c.desc}</span>`;
    btn.addEventListener('click', () => selectSlashCmd(c));
    slashMenu.appendChild(btn);
  });
  slashMenu.classList.remove('hidden');
}

function hideSlashMenu() {
  slashMenu.classList.add('hidden');
  slashActiveIdx = -1;
  slashFiltered = [];
}

function moveSlashActive(delta) {
  if (slashFiltered.length === 0) return;
  slashActiveIdx = (slashActiveIdx + delta + slashFiltered.length) % slashFiltered.length;
  const items = slashMenu.querySelectorAll('.slash-menu__item');
  items.forEach((el, i) => el.classList.toggle('slash-menu__item--active', i === slashActiveIdx));
}

function selectSlashCmd(c) {
  chatInput.value = c.cmd + ' ';
  hideSlashMenu();
  chatInput.focus();
  autoresize();
}

function isSlashMenuVisible() {
  return !slashMenu.classList.contains('hidden');
}

chatInput.addEventListener('input', () => {
  const text = chatInput.value;
  if (text.startsWith('/') && !text.includes('\n')) {
    renderSlashMenu(text);
  } else {
    hideSlashMenu();
  }
});

chatInput.addEventListener('keydown', (e) => {
  // 斜杠菜单可见时优先拦截方向键、Tab、Enter、Esc
  if (isSlashMenuVisible()) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSlashActive(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlashActive(-1);
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
      if (slashActiveIdx >= 0 && slashFiltered[slashActiveIdx]) {
        e.preventDefault();
        selectSlashCmd(slashFiltered[slashActiveIdx]);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideSlashMenu();
      return;
    }
  }
  // Enter 发送、Shift+Enter 换行；isComposing 保护中文输入法候选确认
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// ------------------------- 初始化 -------------------------

// per-tab 模式：面板打开时绑定当前活动 tab（面板生命周期内不变），再加载会话列表
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  panelTabId = tabs?.[0]?.id ?? null;
  panelTabUrl = normalizeUrl(tabs?.[0]?.url);
  void loadSessions();
});
