/**
 * chat.js —— 侧边栏「聊天」Tab（per-tab 面板实例）
 *
 * 会话策略：不提供手动选会话，会话自动跟随页面 URL。
 * URL -> sessionId 映射存 chrome.storage.local；同 URL 二次打开面板时
 * 自动复用之前的 CC 会话并回放历史，无映射则本轮自动新建会话（首轮结束后落地绑定）。
 *
 * 新会话的工作目录默认 DEFAULT_CWD，可在设置面板里修改（存 storage，全局生效）。
 *
 * 唯一通道：消息经 background -> WS -> bridge，由 bridge spawn claude CLI headless 处理。
 * bridge 全局串行执行；忙时新消息在 bridge 侧排队（气泡带「排队中」标签），
 * 前一轮结束后自动续发（turn_start 事件到达即切换为处理中）。
 */

const URL_SESSION_KEY = 'urlSessionMap'; // storage key：URL -> sessionId
const CWD_KEY = 'defaultCwd'; // storage key：新会话工作目录
const DEFAULT_CWD = '/Users/zhuhanhui/code/claude-code/browser-extensions'; // 默认工作目录

const cwdInput = document.getElementById('cwdInput');
const permissionSelect = document.getElementById('permissionSelect');
const bypassWarn = document.getElementById('bypassWarn');
const settingsToggle = document.getElementById('settingsToggle');
const settingsPop = document.getElementById('settingsPop');
const sessionBadge = document.getElementById('sessionBadge');
const sessionBadgeText = document.getElementById('sessionBadgeText');
const newSessionBtn = document.getElementById('newSessionBtn');
const messagesEl = document.getElementById('messages');
const emptyState = document.getElementById('emptyState');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatStop = document.getElementById('chatStop');
const quickSummarize = document.getElementById('quickSummarize');

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
  sessionId: null, // 当前 URL 绑定的会话 id；null 表示尚无会话（发消息时自动新建）
  cwd: DEFAULT_CWD, // 当前会话/新会话的工作目录
  turns: new Map(), // turnId -> turn
  historySeq: 0, // 历史加载序号：快速切换时丢弃过期结果
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

/** 解绑当前 URL 的会话（「新开会话」按钮用） */
async function unbindUrlSession() {
  if (!panelTabUrl) return;
  const map = await getUrlSessionMap();
  delete map[panelTabUrl];
  await chrome.storage.local.set({ [URL_SESSION_KEY]: map });
}

// ------------------------- 会话状态徽标 -------------------------

/**
 * 顶栏徽标显示当前会话状态
 * @param {'ready'|'new'|'busy'} mode
 */
function setSessionBadge(mode, text) {
  sessionBadge.className = `session-badge session-badge--${mode}`;
  sessionBadgeText.textContent = text;
}

function refreshBadge() {
  if (chatState.sessionId) {
    setSessionBadge('ready', `会话已绑定 · ${projectName(chatState.cwd)}`);
  } else {
    setSessionBadge('new', `新会话 · ${projectName(chatState.cwd)}`);
  }
}

// ------------------------- 工作目录设置 -------------------------

async function loadCwdSetting() {
  const res = await chrome.storage.local.get([CWD_KEY]);
  const cwd = res[CWD_KEY] || DEFAULT_CWD;
  cwdInput.value = cwd;
  // 已绑定会话时 cwd 以会话自身为准，这里只影响新会话
  if (!chatState.sessionId) chatState.cwd = cwd;
  return cwd;
}

async function saveCwdSetting() {
  const cwd = cwdInput.value.trim() || DEFAULT_CWD;
  cwdInput.value = cwd;
  await chrome.storage.local.set({ [CWD_KEY]: cwd });
  if (!chatState.sessionId) {
    chatState.cwd = cwd;
    refreshBadge();
  }
}

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

/** 建立与 background 的长连接；SW 被杀导致断开时自动重建 */
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

// ------------------------- 会话解析 -------------------------

function projectName(cwd) {
  return cwd ? cwd.split('/').filter(Boolean).pop() : '(未知项目)';
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * 面板打开时解析当前 URL 应使用的会话：
 * 有绑定且会话仍存在 -> 复用并回放历史；否则清理失效绑定，等首条消息自动新建。
 */
async function resolveSession() {
  await loadCwdSetting();
  setSessionBadge('busy', '查找会话…');

  let bound = null;
  if (panelTabUrl) {
    const map = await getUrlSessionMap();
    bound = map[panelTabUrl] ?? null;
  }

  if (bound) {
    try {
      const sessions = (await chatRequest('list_sessions').promise) ?? [];
      const session = sessions.find((s) => s.sessionId === bound);
      if (session) {
        chatState.sessionId = session.sessionId;
        chatState.cwd = session.cwd || chatState.cwd;
        refreshBadge();
        void loadHistory(session.sessionId);
        return;
      }
      // 绑定的会话已被删除：清理失效映射
      await unbindUrlSession();
    } catch {
      // bridge 未连上时保持绑定不动，乐观按已绑定处理（发消息时再报错）
      chatState.sessionId = bound;
      refreshBadge();
      void loadHistory(bound);
      return;
    }
  }
  refreshBadge();
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
  role.innerHTML = `<span class="msg__avatar">✳</span> Claude${time ? ` <span class="msg__time">${time}</span>` : ''}`;
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

/** 工具图标映射：常见工具给个易识别的 emoji */
const TOOL_ICONS = {
  Bash: '💻',
  Read: '📖',
  Write: '✏️',
  Edit: '✏️',
  Grep: '🔍',
  Glob: '🔍',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Task: '🤖',
  Agent: '🤖',
};

function toolIcon(name) {
  return TOOL_ICONS[name] ?? '🔧';
}

function appendToolCard(name, summary) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  const head = document.createElement('button');
  head.className = 'tool-card__head';
  head.innerHTML =
    `<span class="tool-card__arrow">▸</span>` +
    `<span class="tool-card__icon">${toolIcon(name)}</span>` +
    `<span class="tool-card__name">${escapeText(name)}</span>` +
    `<span class="tool-card__hint">${escapeText(summary)}</span>`;
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

/** 回放会话的历史消息（最近 100 条） */
async function loadHistory(sessionId) {
  const seq = ++chatState.historySeq;
  clearMessages();
  if (!sessionId) return;

  const loading = appendMeta('加载历史消息…');
  try {
    const res = await chatRequest('get_history', { sessionId }).promise;
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
    await adoptActiveTurns(sessionId, entries, seq);
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
      // headless resume 每轮可能派生新 session id：始终跟踪最新 id 并回写 URL 绑定，
      // 保证同 URL 下次打开面板时接到含最新历史的会话文件
      if (event.sessionId && event.sessionId !== chatState.sessionId) {
        chatState.sessionId = event.sessionId;
        refreshBadge();
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

/** 发送一条指定文本的消息（输入框发送与快捷指令共用） */
async function sendText(message) {
  if (!message) return;

  // 已绑定会话则续接；未绑定则首轮不带 sessionId，由 CLI 新建（result 事件里落地绑定）
  const { id, promise } = chatRequest('send', {
    sessionId: chatState.sessionId ?? undefined,
    cwd: chatState.cwd,
    message,
    permissionMode: permissionSelect.value,
  });
  const turn = createTurn(id);
  chatState.turns.set(id, turn);
  appendUserBubble(turn, message);
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

async function sendMessage() {
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = '';
  autoresize();
  await sendText(message);
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

// 「总结当前页面」快捷指令：带上当前 tab 的实时 URL，走 /chrome 让 CLI 读取页面内容
async function sendSummarizePage() {
  quickSummarize.disabled = true; // 防重复点击，请求受理后恢复
  try {
    let url = panelTabUrl;
    try {
      const tab = await chrome.tabs.get(panelTabId);
      url = normalizeUrl(tab?.url) ?? url;
    } catch {
      // tab 可能已关闭，退回打开面板时的 URL
    }
    const target = url ? `（${url}）` : '';
    await sendText(`/chrome 总结一下当前打开的页面${target}：读取页面主要内容，用中文输出核心要点。`);
  } finally {
    quickSummarize.disabled = false;
  }
}

chatSend.addEventListener('click', sendMessage);
chatStop.addEventListener('click', stopAll);
quickSummarize.addEventListener('click', () => void sendSummarizePage());
chatInput.addEventListener('input', autoresize);

settingsToggle.addEventListener('click', () => {
  settingsPop.classList.toggle('hidden');
});

permissionSelect.addEventListener('change', () => {
  bypassWarn.classList.toggle('hidden', permissionSelect.value !== 'bypassPermissions');
});

cwdInput.addEventListener('change', () => void saveCwdSetting());

// 「新开会话」：解绑当前 URL，清空消息区，下一条消息自动新建会话
newSessionBtn.addEventListener('click', async () => {
  await unbindUrlSession();
  chatState.sessionId = null;
  chatState.cwd = cwdInput.value.trim() || DEFAULT_CWD;
  clearMessages();
  refreshBadge();
});

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

// per-tab 模式：面板打开时绑定当前活动 tab（面板生命周期内不变），再解析 URL 对应会话
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  panelTabId = tabs?.[0]?.id ?? null;
  panelTabUrl = normalizeUrl(tabs?.[0]?.url);
  void resolveSession();
});
