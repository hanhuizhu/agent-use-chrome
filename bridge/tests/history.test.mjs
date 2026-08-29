import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapHistoryLine } from '../dist/session-manager.js';

test('user 文本行 -> user 条目', () => {
  const line = JSON.stringify({ type: 'user', message: { content: '帮我看看这个页面' } });
  assert.deepEqual(mapHistoryLine(line), [{ role: 'user', text: '帮我看看这个页面' }]);
});

test('user 的 content 数组取 text 块', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'text', text: '数组形式' }] },
  });
  assert.deepEqual(mapHistoryLine(line), [{ role: 'user', text: '数组形式' }]);
});

test('user 的 tool_result 行（无文本）忽略', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
  });
  assert.equal(mapHistoryLine(line), null);
});

test('user 的元信息行（command/system-reminder）忽略', () => {
  const cmd = JSON.stringify({
    type: 'user',
    message: { content: '<command-name>/clear</command-name>' },
  });
  const reminder = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] },
  });
  assert.equal(mapHistoryLine(cmd), null);
  assert.equal(mapHistoryLine(reminder), null);
});

test('assistant 行 -> 文本与工具条目', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: '我来处理' },
        { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
      ],
    },
  });
  assert.deepEqual(mapHistoryLine(line), [
    { role: 'assistant', text: '我来处理' },
    { role: 'tool', name: 'Bash', summary: '{"cmd":"ls"}' },
  ]);
});

test('其他类型与脏行忽略', () => {
  assert.equal(mapHistoryLine(JSON.stringify({ type: 'summary', summary: 'x' })), null);
  assert.equal(mapHistoryLine('not json'), null);
  assert.equal(mapHistoryLine(''), null);
});
