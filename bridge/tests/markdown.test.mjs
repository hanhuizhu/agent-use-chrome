import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

before(async () => {
  // classic script：加载后挂到 globalThis
  await import(pathToFileURL(join(import.meta.dirname, '../../extension/panel/markdown.js')).href);
});

test('HTML 注入被转义', () => {
  const html = globalThis.renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('粗体/斜体/行内代码', () => {
  const html = globalThis.renderMarkdown('**加粗** *斜体* `code`');
  assert.ok(html.includes('<strong>加粗</strong>'));
  assert.ok(html.includes('<em>斜体</em>'));
  assert.ok(html.includes('<code>code</code>'));
});

test('围栏代码块内部不做行内处理', () => {
  const html = globalThis.renderMarkdown('```js\nconst a = "**x**";\n```');
  assert.ok(html.includes('<pre'));
  assert.ok(html.includes('**x**')); // 不转成 <strong>
});

test('列表与标题', () => {
  const html = globalThis.renderMarkdown('## 标题\n- 甲\n- 乙\n1. 一');
  assert.ok(/<h4>标题<\/h4>/.test(html));
  assert.ok(html.includes('<ul><li>甲</li><li>乙</li></ul>'));
  assert.ok(html.includes('<ol><li>一</li></ol>'));
});

test('仅允许 http(s) 链接', () => {
  const ok = globalThis.renderMarkdown('[a](https://example.com)');
  assert.ok(ok.includes('href="https://example.com"'));
  const bad = globalThis.renderMarkdown('[a](javascript:alert(1))');
  assert.ok(!bad.includes('href='));
});
