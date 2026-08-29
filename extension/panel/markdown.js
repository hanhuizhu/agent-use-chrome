/**
 * markdown.js —— 面板用 mini markdown 渲染器（零依赖）
 *
 * 安全策略：所有文本先整体 HTML 转义，再做标记替换；链接仅允许 http(s)。
 * 支持：标题、粗体、斜体、行内代码、围栏代码块、无序/有序列表、引用、段落。
 */
(function () {
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }

  /** 行内标记（输入已转义）：行内代码 -> 粗体 -> 斜体 -> 链接 */
  function inline(s) {
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
    return s;
  }

  /** 非代码块区域按行解析块级结构 */
  function renderBlocks(md) {
    let html = '';
    let list = null; // 当前打开的列表标签：'ul' | 'ol' | null
    const closeList = () => {
      if (list) {
        html += `</${list}>`;
        list = null;
      }
    };
    for (const line of md.split('\n')) {
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        closeList();
        const level = Math.min(m[1].length + 2, 6); // 面板空间小：h1 从 h3 起步
        html += `<h${level}>${inline(escapeHtml(m[2]))}</h${level}>`;
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        closeList();
        html += `<blockquote>${inline(escapeHtml(m[1]))}</blockquote>`;
      } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
        if (list !== 'ul') {
          closeList();
          html += '<ul>';
          list = 'ul';
        }
        html += `<li>${inline(escapeHtml(m[1]))}</li>`;
      } else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
        if (list !== 'ol') {
          closeList();
          html += '<ol>';
          list = 'ol';
        }
        html += `<li>${inline(escapeHtml(m[1]))}</li>`;
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        html += `<p>${inline(escapeHtml(line))}</p>`;
      }
    }
    closeList();
    return html;
  }

  function renderMarkdown(text) {
    // 按 ``` 围栏分段：奇数段是代码块（只转义，不做行内处理）
    const parts = String(text ?? '').split(/```/);
    let html = '';
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 2 === 1) {
        const nl = parts[i].indexOf('\n');
        const code = nl === -1 ? parts[i] : parts[i].slice(nl + 1); // 首行是语言标记
        html += `<pre class="md-code"><code>${escapeHtml(code)}</code></pre>`;
      } else {
        html += renderBlocks(parts[i]);
      }
    }
    return html;
  }

  globalThis.renderMarkdown = renderMarkdown;
})();
