/**
 * panel.js —— 侧边栏公共逻辑
 * Tab 切换、连接状态显示（轮询 + 广播互补）、重连与紧急停止。
 *
 * 端口无需配置：extension 自动扫描 12345-12350（与 bridge 抢占顺序一致）；
 * token 沿用 storage 中已存值（默认 local-dev-token）。
 */

const statusEl = document.getElementById('status');

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

// ------------------------- 连接状态 -------------------------

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
  // token 沿用已存储值（无输入项），保存动作即触发重连
  const cfg = await chrome.storage.local.get(['token']);
  await chrome.storage.local.set({ token: cfg.token ?? 'local-dev-token' });
  await chrome.runtime.sendMessage({ channel: 'control', action: 'reconnect' });
});

document.getElementById('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ channel: 'control', action: 'stop' });
  setStatus('stopped');
});

// 接收 background 广播（即时性优于轮询，两者互补）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.channel === 'status') {
    setStatus(msg.status, msg.port);
  }
});
