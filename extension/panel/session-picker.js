/**
 * session-picker.js —— 自定义会话下拉组件
 *
 * 原生 select 的下拉面板由操作系统渲染无法美化，这里用自绘面板替代：
 * 两行式选项（标题 / 项目名·时间）、顶部过滤输入、键盘上下选择 + Enter 确认。
 * 通过 globalThis.SessionPicker.init(...) 初始化，返回 { setOptions, setValue, getValue }。
 */
(function () {
  /**
   * @param {{ onChange: (value: string) => void }} opts
   */
  function init(opts) {
    const trigger = document.getElementById('pickerTrigger');
    const labelEl = document.getElementById('pickerLabel');
    const menu = document.getElementById('pickerMenu');
    const filterInput = document.getElementById('pickerFilter');
    const listEl = document.getElementById('pickerList');

    let options = []; // { value, title, sub }：sub 为空表示置顶项（如「＋新会话」）
    let value = '';
    let activeIndex = -1; // 键盘高亮项（相对当前过滤结果）
    let filtered = [];

    function labelOf(v) {
      const opt = options.find((o) => o.value === v);
      return opt ? opt.title : '选择会话…';
    }

    function syncLabel() {
      labelEl.textContent = labelOf(value);
    }

    function open() {
      menu.classList.remove('hidden');
      filterInput.value = '';
      renderList('');
      filterInput.focus();
    }

    function close() {
      menu.classList.add('hidden');
      activeIndex = -1;
    }

    function isOpen() {
      return !menu.classList.contains('hidden');
    }

    function select(v) {
      const changed = v !== value;
      value = v;
      syncLabel();
      close();
      if (changed) opts.onChange(v);
    }

    function renderList(keyword) {
      const kw = keyword.trim().toLowerCase();
      filtered = kw
        ? options.filter((o) => `${o.title} ${o.sub ?? ''}`.toLowerCase().includes(kw))
        : options;
      activeIndex = filtered.length > 0 ? 0 : -1;
      listEl.innerHTML = '';
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'picker__empty';
        empty.textContent = '没有匹配的会话';
        listEl.appendChild(empty);
        return;
      }
      filtered.forEach((o, i) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker__item';
        if (o.value === value) item.classList.add('picker__item--selected');
        if (i === activeIndex) item.classList.add('picker__item--active');
        const title = document.createElement('span');
        title.className = 'picker__item-title';
        title.textContent = o.title;
        item.appendChild(title);
        if (o.sub) {
          const sub = document.createElement('span');
          sub.className = 'picker__item-sub';
          sub.textContent = o.sub;
          item.appendChild(sub);
        }
        item.addEventListener('click', () => select(o.value));
        listEl.appendChild(item);
      });
    }

    /** 键盘高亮移动后同步样式并滚动到可见 */
    function moveActive(delta) {
      if (filtered.length === 0) return;
      activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
      const items = listEl.querySelectorAll('.picker__item');
      items.forEach((el, i) => el.classList.toggle('picker__item--active', i === activeIndex));
      items[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    trigger.addEventListener('click', () => (isOpen() ? close() : open()));
    filterInput.addEventListener('input', () => renderList(filterInput.value));
    filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveActive(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && filtered[activeIndex]) select(filtered[activeIndex].value);
      } else if (e.key === 'Escape') {
        close();
      }
    });

    // 点击组件外部关闭
    document.addEventListener('click', (e) => {
      if (isOpen() && !trigger.contains(e.target) && !menu.contains(e.target)) {
        close();
      }
    });

    return {
      /** 设置选项列表：[{ value, title, sub? }] */
      setOptions(list) {
        options = list;
        syncLabel();
        if (isOpen()) renderList(filterInput.value);
      },
      /** 静默设置当前值（不触发 onChange） */
      setValue(v) {
        value = v;
        syncLabel();
      },
      getValue() {
        return value;
      },
      /** 显示加载/错误占位文案 */
      setPlaceholder(text) {
        labelEl.textContent = text;
      },
    };
  }

  globalThis.SessionPicker = { init };
})();
