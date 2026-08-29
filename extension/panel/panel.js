/**
 * panel.js —— 侧边栏逻辑
 * 显示连接状态（轮询保证准确）、配置 token、动作日志、重连与紧急停止。
 *
 * 端口无需配置：extension 自动扫描 12345-12350（与 bridge 抢占顺序一致）。
 */

const statusEl = document.getElementById('status');
const tokenEl = document.getElementById('token');
const logList = document.getElementById('logList');

// ------------------------- Tab 切换 -------------------------

const tabBtnChat = document.getElementById('tabBtnChat');
const tabBtnStatus = document.getElementById('tabBtnStatus');
const tabChat = document.getElementById('tabChat');
const tabStatus = document.getElementById('tabStatus');

function switchTab(target) {
  const isChat = target === 'chat';
  tabBtnChat.classList.toggle('tab--active', isChat);
  tabBtnStatus.classList.toggle('tab--active', !isChat);
  tabChat.classList.toggle('hidden', !isChat);
  tabStatus.classList.toggle('hidden', isChat);
}

tabBtnChat.addEventListener('click', () => switchTab('chat'));
tabBtnStatus.addEventListener('click', () => switchTab('status'));

const MAX_LOG = 200;
const STATUS_POLL_MS = 2000; // 状态轮询间隔：避免打开瞬间的竞态导致长期误显示「未连接」

const STATUS_TEXT = {
  connected: '已连接',
  disconnected: '未连接',
  stopped: '已停止',
  unknown: '未知',
};

function setStatus(status, port) {
  statusEl.className = `status status--${status}`;
  const label = STATUS_TEXT[status] ?? status;
  statusEl.textContent = status === 'connected' && port ? `${label} :${port}` : label;
}

function addLog(text, ts) {
  const li = document.createElement('li');
  const time = new Date(ts ?? Date.now()).toLocaleTimeString();
  li.innerHTML = `<span class="ts">${time}</span>${escapeHtml(text)}`;
  logList.prepend(li);
  while (logList.children.length > MAX_LOG) {
    logList.removeChild(logList.lastChild);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// 载入已保存配置
chrome.storage.local.get(['token']).then((cfg) => {
  tokenEl.value = cfg.token ?? 'local-dev-token';
});

/** 向 background 查询真实连接状态并刷新显示 */
async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ channel: 'control', action: 'queryStatus' });
    if (res?.stopped) {
      setStatus('stopped');
    } else {
      setStatus(res?.connected ? 'connected' : 'disconnected', res?.port);
    }
  } catch {
    // background 未就绪（SW 冷启动中），下一轮再试
    setStatus('unknown');
  }
}

// 打开即查一次 + 定时轮询，杜绝「实际在干活但显示未连接」
refreshStatus();
setInterval(refreshStatus, STATUS_POLL_MS);

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenEl.value || 'local-dev-token';
  await chrome.storage.local.set({ token });
  await chrome.runtime.sendMessage({ channel: 'control', action: 'reconnect' });
  addLog('配置已保存，扫描端口 12345-12350 重连中…');
});

document.getElementById('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ channel: 'control', action: 'stop' });
  addLog('已紧急停止：断开连接并 detach 所有标签');
  setStatus('stopped');
});

document.getElementById('clear').addEventListener('click', () => {
  logList.innerHTML = '';
});

// 接收 background 广播（即时性优于轮询，两者互补）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.channel === 'status') {
    setStatus(msg.status, msg.port);
    if (msg.detail) {
      addLog(`状态：${STATUS_TEXT[msg.status] ?? msg.status} ${msg.detail}`);
    }
  } else if (msg?.channel === 'log') {
    addLog(msg.text, msg.ts);
  }
});
