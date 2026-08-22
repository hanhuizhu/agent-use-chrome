/**
 * content.js —— 页面侧脚本
 *
 * 职责：
 * - 生成结构化文本快照：标题、正文摘要、编号的可交互元素（每个带 ref + CSS 像素几何）
 * - 维护 ref -> 元素 的注册表，供 background 按 ref 定位坐标 / 聚焦 / 清空
 * - 提供页面滚动、状态读取
 *
 * 与 background 通过 chrome.runtime.onMessage 通信。坐标一律使用 CSS 像素、
 * 相对视口（getBoundingClientRect），与 CDP Input 事件坐标系一致。
 */

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'textarea',
  'select',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=checkbox]',
  '[role=menuitem]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const MAX_ELEMENTS = 200; // 上限，避免超大页面爆炸
const MAX_BODY_CHARS = 3000; // 正文摘要上限
const MAX_LABEL_CHARS = 120;

/** ref -> HTMLElement，每次快照刷新 */
let refRegistry = new Map();

/** 元素是否可见（有面积、未隐藏） */
function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
    return false;
  }
  return true;
}

/** 是否在当前视口内（用于标注可见性，不影响入选） */
function isInViewport(rect) {
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** 提取元素的可读标签 */
function elementLabel(el) {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type');
  const aria = el.getAttribute('aria-label');
  const placeholder = el.getAttribute('placeholder');
  const value = el.value;
  let name =
    aria ||
    (el.innerText || '').trim() ||
    placeholder ||
    (typeof value === 'string' ? value : '') ||
    el.getAttribute('title') ||
    el.getAttribute('name') ||
    '';
  name = name.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
  const kind = type ? `${tag}[${type}]` : tag;
  return { kind, name };
}

/** 生成快照，返回 { title, url, text, elements: [{ref,kind,name,rect,inViewport}] } */
function buildSnapshot() {
  refRegistry = new Map();
  const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const elements = [];
  let counter = 0;

  for (const el of nodes) {
    if (counter >= MAX_ELEMENTS) {
      break;
    }
    if (!isVisible(el)) {
      continue;
    }
    counter += 1;
    const ref = `e${counter}`;
    refRegistry.set(ref, el);
    const rect = el.getBoundingClientRect();
    const { kind, name } = elementLabel(el);
    elements.push({
      ref,
      kind,
      name,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      inViewport: isInViewport(rect),
    });
  }

  const bodyText = (document.body?.innerText || '').replace(/\s+\n/g, '\n').trim().slice(0, MAX_BODY_CHARS);

  const lines = [];
  lines.push(`# ${document.title}`);
  lines.push(`URL: ${location.href}`);
  lines.push('');
  lines.push('## 可交互元素');
  for (const e of elements) {
    const vp = e.inViewport ? '' : ' (视口外)';
    lines.push(`[${e.ref}] ${e.kind} "${e.name}"${vp}`);
  }
  lines.push('');
  lines.push('## 正文摘要');
  lines.push(bodyText);

  return {
    title: document.title,
    url: location.href,
    text: lines.join('\n'),
    elements,
  };
}

/** 按 ref 返回元素中心坐标（CSS 像素，相对视口）；必要时先滚入视口 */
function resolveRef(ref, scrollIntoView) {
  const el = refRegistry.get(ref);
  if (!el) {
    return { ok: false, error: `未找到 ref=${ref}，请先调用 browser_snapshot 刷新页面元素` };
  }
  if (scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

/** 聚焦并（可选）清空一个输入元素 */
function focusRef(ref, clear) {
  const el = refRegistry.get(ref);
  if (!el) {
    return { ok: false, error: `未找到 ref=${ref}` };
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  if (clear && ('value' in el)) {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

/** 滚动页面 */
function scrollPage(direction, amount) {
  const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' in window ? 'instant' : 'auto' });
  return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.cmd) {
    case 'snapshot':
      sendResponse(buildSnapshot());
      break;
    case 'resolveRef':
      sendResponse(resolveRef(msg.ref, msg.scrollIntoView !== false));
      break;
    case 'focusRef':
      sendResponse(focusRef(msg.ref, msg.clear !== false));
      break;
    case 'scroll': {
      const amount = typeof msg.amount === 'number' ? msg.amount : Math.round(window.innerHeight * 0.8);
      sendResponse(scrollPage(msg.direction, amount));
      break;
    }
    case 'getState':
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        readyState: document.readyState,
      });
      break;
    default:
      sendResponse({ ok: false, error: `未知指令 ${msg?.cmd}` });
  }
  return true; // 保持异步响应通道
});
