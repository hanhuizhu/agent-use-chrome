/**
 * background.js —— service worker（扩展核心）
 *
 * 职责：
 * - WS 客户端：连接 bridge（重连 + 心跳保活 MV3 SW）
 * - 指令分发：把 bridge 的 request 路由到具体浏览器操作
 * - chrome.debugger(CDP) 管理：注入可信鼠标/键盘事件
 * - 截图：captureVisibleTab + 降采样到 CSS 像素（与快照坐标系一致）
 * - 标签页自动跟随：每次操作解析当前活动标签
 */

// 端口候选段：与 bridge 一致，从小到大扫描（bridge 抢占第一个空闲端口）
const PORT_RANGE = [12345, 12346, 12347, 12348, 12349, 12350];
const DEFAULT_CONFIG = { token: 'local-dev-token' };
const PORT_PROBE_TIMEOUT_MS = 500; // 单端口探测超时（localhost 无需 1.5s）
const RECONNECT_ALARM = 'ws-reconnect'; // chrome.alarms 名称，抗 SW 重启

let ws = null;
let currentPort = null; // 当前已连接的端口
let scanning = false; // 是否正在扫描端口段
let stopped = false; // 紧急停止后不再自动重连，直到用户点「保存并重连」
let reconnectDelay = 1000; // 指数退避起始
let reconnectTimer = null;
let heartbeatTimer = null;
const attachedTabs = new Set(); // 已 CDP attach 的 tabId

// ------------------------- 配置 -------------------------

async function getConfig() {
  const stored = await chrome.storage.local.get(['token']);
  return {
    token: stored.token ?? DEFAULT_CONFIG.token,
  };
}

/** 向侧边栏广播连接状态（携带当前端口） */
function broadcastStatus(status, detail) {
  chrome.runtime
    .sendMessage({ channel: 'status', status, detail, port: currentPort })
    .catch(() => {});
}

/** 向侧边栏广播一条动作日志 */
function log(text) {
  chrome.runtime.sendMessage({ channel: 'log', text, ts: Date.now() }).catch(() => {});
}

// ------------------------- WS 连接 -------------------------

/**
 * 依次扫描 12345-12350（从小到大），连上第一个可用的 bridge。
 * 全部失败则指数退避后重新扫描。
 */
async function connect() {
  if (stopped || scanning || (ws && ws.readyState === WebSocket.OPEN)) {
    return;
  }
  scanning = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});

  try {
    const { token } = await getConfig();
    for (const port of PORT_RANGE) {
      const opened = await tryPort(port, token);
      if (opened) {
        return;
      }
    }
    broadcastStatus('disconnected');
    scheduleReconnect();
  } finally {
    scanning = false;
  }
}

/** 探测单个端口：成功打开则接管该 socket 并返回 true */
function tryPort(port, token) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    let sock;
    let settled = false;

    try {
      sock = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          sock.close();
        } catch {}
        resolve(false);
      }
    }, PORT_PROBE_TIMEOUT_MS);

    sock.onopen = () => {
      if (settled) {
        try {
          sock.close();
        } catch {}
        return;
      }
      settled = true;
      clearTimeout(timer);
      adoptSocket(sock, port);
      resolve(true);
    };

    sock.onerror = () => {
      // 由 onclose 统一收尾
    };

    sock.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    };
  });
}

/** 接管已打开的 socket：绑定消息/断连处理，广播已连接状态 */
function adoptSocket(sock, port) {
  ws = sock;
  currentPort = port;
  reconnectDelay = 1000;
  broadcastStatus('connected', `ws://127.0.0.1:${port}`);
  log(`已连接 ws://127.0.0.1:${port}`);
  startHeartbeat();

  sock.onmessage = (ev) => handleMessage(ev.data);
  sock.onclose = () => {
    if (ws === sock) {
      ws = null;
      currentPort = null;
      stopHeartbeat();
      broadcastStatus('disconnected');
      scheduleReconnect();
    }
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  // chrome.alarms 最小粒度 ~1 分钟，短延迟仍用 setTimeout
  reconnectTimer = setTimeout(connect, reconnectDelay);
  // 同时设一个 alarm 兜底：SW 被杀后 setTimeout 丢失，alarm 能唤醒
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function startHeartbeat() {
  stopHeartbeat();
  // 主动 ping，兼作 SW 保活
  heartbeatTimer = setInterval(() => sendRaw({ type: 'ping' }), 20000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendRaw(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendEvent(event, payload) {
  sendRaw({ type: 'event', event, payload });
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === 'ping') {
    sendRaw({ type: 'pong' });
    return;
  }
  if (msg.type === 'pong') {
    return;
  }
  // 聊天应答/流事件：转发给侧边栏
  if (msg.type === 'chat_response' || msg.type === 'chat_stream') {
    broadcastToChatPorts(msg);
    return;
  }
  if (msg.type !== 'request') {
    return;
  }

  const { id, method, params } = msg;
  log(`▶ ${method} ${JSON.stringify(params ?? {})}`);
  try {
    const result = await dispatch(method, params ?? {});
    sendRaw({ type: 'response', id, ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`✖ ${method}: ${message}`);
    sendRaw({ type: 'response', id, ok: false, error: message });
  }
}

// ------------------------- 标签页 & CDP -------------------------

/** 解析当前活动标签（自动跟随） */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) {
    throw new Error('未找到活动标签页');
  }
  return tab;
}

/** 确保某 tab 已 CDP attach */
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) {
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already attached')) {
      // 可能被 DevTools 或本扩展占用
      if (message.includes('devtools')) {
        throw new Error('该标签已打开 DevTools，debugger 冲突。请关闭 DevTools 后重试。');
      }
      attachedTabs.add(tabId);
      return;
    }
    throw new Error(`CDP attach 失败：${message}`);
  }
}

/** 发送一条 CDP 命令 */
async function cdp(tabId, cmd, params) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, cmd, params ?? {});
}

/** 向 content script 发消息（必要时先注入） */
async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // content 未就绪，尝试注入后重试
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

/** 等待标签加载完成 */
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ------------------------- 指令实现 -------------------------

const BUTTON_MAP = { left: 'left', right: 'right', middle: 'middle' };

async function dispatch(method, params) {
  switch (method) {
    case 'navigate':
      return doNavigate(params);
    case 'snapshot':
      return doSnapshot();
    case 'screenshot':
      return doScreenshot();
    case 'click':
      return doClick(params);
    case 'type':
      return doType(params);
    case 'press_key':
      return doPressKey(params);
    case 'scroll':
      return doScroll(params);
    case 'wait':
      return doWait(params);
    case 'tabs':
      return doTabs(params);
    case 'get_state':
      return doGetState();
    default:
      throw new Error(`未知方法 ${method}`);
  }
}

async function doNavigate({ action, url }) {
  const tab = await getActiveTab();
  switch (action) {
    case 'goto':
      if (!url) throw new Error('goto 需要 url');
      await chrome.tabs.update(tab.id, { url });
      break;
    case 'back':
      await chrome.tabs.goBack(tab.id);
      break;
    case 'forward':
      await chrome.tabs.goForward(tab.id);
      break;
    case 'reload':
      await chrome.tabs.reload(tab.id);
      break;
    default:
      throw new Error(`未知导航动作 ${action}`);
  }
  await waitForTabComplete(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { ok: true, url: updated.url, title: updated.title };
}

async function doSnapshot() {
  const tab = await getActiveTab();
  const snap = await sendToContent(tab.id, { cmd: 'snapshot' });
  return snap.text;
}

/** 二进制 blob -> data URL（SW 环境无 FileReader 的稳妥实现） */
async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function doScreenshot() {
  const tab = await getActiveTab();
  // 读取 CSS 视口尺寸与 devicePixelRatio
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      dpr: window.devicePixelRatio || 1,
      w: window.innerWidth,
      h: window.innerHeight,
    }),
  });

  const rawDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  // 降采样到 CSS 像素，使截图坐标与快照/点击坐标同一坐标系
  const resp = await fetch(rawDataUrl);
  const bitmap = await createImageBitmap(await resp.blob());
  const canvas = new OffscreenCanvas(metrics.w, metrics.h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, metrics.w, metrics.h);
  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(outBlob);

  return {
    dataUrl,
    devicePixelRatio: metrics.dpr,
    cssWidth: metrics.w,
    cssHeight: metrics.h,
  };
}

async function doClick({ ref, x, y, button }) {
  const tab = await getActiveTab();
  let px = x;
  let py = y;
  if (ref) {
    const res = await sendToContent(tab.id, { cmd: 'resolveRef', ref });
    if (!res.ok) throw new Error(res.error);
    px = res.x;
    py = res.y;
  }
  if (typeof px !== 'number' || typeof py !== 'number') {
    throw new Error('click 需要 ref 或 x/y 坐标');
  }
  const cdpButton = BUTTON_MAP[button ?? 'left'] ?? 'left';
  await cdp(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: px,
    y: py,
    button: cdpButton,
    clickCount: 1,
  });
  await cdp(tab.id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: px,
    y: py,
    button: cdpButton,
    clickCount: 1,
  });
  return { ok: true, x: px, y: py };
}

async function doType({ ref, text, clear, submit }) {
  const tab = await getActiveTab();
  const res = await sendToContent(tab.id, { cmd: 'focusRef', ref, clear: clear !== false });
  if (!res.ok) throw new Error(res.error);
  // CDP insertText：作为可信输入，触发原生 input 事件
  await cdp(tab.id, 'Input.insertText', { text });
  if (submit) {
    await dispatchKey(tab.id, 'Enter');
  }
  return { ok: true };
}

// CDP 按键映射：key -> { code, keyCode }
const KEY_MAP = {
  Enter: { code: 'Enter', keyCode: 13 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};

async function dispatchKey(tabId, key) {
  const def = KEY_MAP[key];
  if (!def) {
    throw new Error(`不支持的按键：${key}（支持 ${Object.keys(KEY_MAP).join(', ')}）`);
  }
  const base = {
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  };
  if (def.text) {
    base.text = def.text;
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function doPressKey({ key }) {
  const tab = await getActiveTab();
  await dispatchKey(tab.id, key);
  return { ok: true, key };
}

async function doScroll({ direction, amount }) {
  const tab = await getActiveTab();
  const res = await sendToContent(tab.id, { cmd: 'scroll', direction, amount });
  return res;
}

function doWait({ ms, until }) {
  return new Promise(async (resolve) => {
    if (until === 'load') {
      const tab = await getActiveTab();
      await waitForTabComplete(tab.id);
      resolve({ ok: true, waited: 'load' });
      return;
    }
    const delay = typeof ms === 'number' ? ms : 1000;
    setTimeout(() => resolve({ ok: true, waited: `${delay}ms` }), delay);
  });
}

async function doTabs({ action, url, index }) {
  switch (action) {
    case 'list': {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      return tabs.map((t, i) => ({
        index: i,
        active: t.active,
        title: t.title,
        url: t.url,
      }));
    }
    case 'new': {
      const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true });
      await waitForTabComplete(tab.id);
      return { ok: true, url: tab.url };
    }
    case 'select': {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      const target = tabs[index];
      if (!target) throw new Error(`标签序号越界：${index}`);
      await chrome.tabs.update(target.id, { active: true });
      return { ok: true, url: target.url };
    }
    case 'close': {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      const target = tabs[index];
      if (!target) throw new Error(`标签序号越界：${index}`);
      await chrome.tabs.remove(target.id);
      return { ok: true };
    }
    default:
      throw new Error(`未知标签动作 ${action}`);
  }
}

async function doGetState() {
  const tab = await getActiveTab();
  return { url: tab.url, title: tab.title, status: tab.status };
}

// ------------------------- 侧边栏聊天中继 -------------------------

/** 已连接的侧边栏聊天端口（长连接，支持流式推送） */
const chatPorts = new Set();

function broadcastToChatPorts(msg) {
  for (const port of chatPorts) {
    try {
      port.postMessage(msg);
    } catch {
      chatPorts.delete(port);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat') {
    return;
  }
  chatPorts.add(port);
  port.onDisconnect.addListener(() => chatPorts.delete(port));
  // 面板 -> WS：透传 chat_request；bridge 未连接时立即回错误
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'chat_request') {
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      port.postMessage({
        type: 'chat_response',
        id: msg.id,
        ok: false,
        error: 'bridge 未连接，请先在「状态」页确认连接',
      });
      return;
    }
    sendRaw(msg);
  });
});

// ------------------------- 生命周期 & 清理 -------------------------

// tab 关闭时清理 attach 记录
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

// debugger 被外部 detach（如用户手动关闭）时清理
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attachedTabs.delete(source.tabId);
    sendEvent('detached', { tabId: source.tabId });
  }
});

// 活动标签切换时上报事件（自动跟随的可观测性）
chrome.tabs.onActivated.addListener((info) => {
  sendEvent('tab_changed', { tabId: info.tabId });
});

// ------------------------- Side Panel per-tab 模式 -------------------------

// 默认全局禁用面板：面板只在被显式打开过的 tab 上展示。
// Chrome 原生行为：切到未启用的 tab 面板自动收起，切回已启用的 tab 自动展开。
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

// 点击扩展图标：为当前 tab 单独启用并打开面板（不 await，保住用户手势上下文）
chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) return;
  chrome.sidePanel
    .setOptions({ tabId: tab.id, path: 'panel/panel.html', enabled: true })
    .catch(() => {});
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// 来自侧边栏的控制消息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.channel === 'control') {
    if (msg.action === 'reconnect') {
      stopped = false;
      // 先解除旧 socket 的 onclose 绑定，避免它触发 scheduleReconnect 覆盖本次重连
      const oldWs = ws;
      if (oldWs) {
        oldWs.onclose = null;
        oldWs.onerror = null;
        try { oldWs.close(); } catch {}
      }
      ws = null;
      currentPort = null;
      stopHeartbeat();
      reconnectDelay = 1000;
      connect();
      sendResponse({ ok: true });
    } else if (msg.action === 'stop') {
      // 紧急停止：断开 WS 并 detach 所有 tab，且不再自动重连
      stopped = true;
      try {
        ws?.close();
      } catch {}
      for (const tabId of attachedTabs) {
        chrome.debugger.detach({ tabId }).catch(() => {});
      }
      attachedTabs.clear();
      broadcastStatus('stopped');
      sendResponse({ ok: true });
    } else if (msg.action === 'queryStatus') {
      const connected = ws && ws.readyState === WebSocket.OPEN;
      sendResponse({ connected: !!connected, port: currentPort, stopped, scanning });
      // 只在无 pending 重连时才顺手触发扫描，避免覆盖指数退避
      if (!connected && !stopped && !scanning && !reconnectTimer) {
        connect();
      }
    }
    return true;
  }
  return false;
});

// alarm 兜底重连：SW 被杀后恢复时 setTimeout 已丢失，alarm 唤醒后重新扫描
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !stopped) {
    connect();
  }
});

// 启动即连接
connect();
