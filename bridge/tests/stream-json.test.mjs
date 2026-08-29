import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStreamJsonLine } from '../dist/session-manager.js';

test('assistant 文本块 -> text 事件', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '你好' }] },
  });
  assert.deepEqual(mapStreamJsonLine(line), [{ kind: 'text', text: '你好' }]);
});

test('stream_event 的 text_delta -> text_delta 事件', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '增' } },
  });
  assert.deepEqual(mapStreamJsonLine(line), [{ kind: 'text_delta', text: '增' }]);
});

test('stream_event 非文本增量忽略', () => {
  const line = JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{' },
    },
  });
  assert.equal(mapStreamJsonLine(line), null);
});

test('tool_use 摘要截断到 600', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { cmd: 'x'.repeat(700) } }] },
  });
  const [ev] = mapStreamJsonLine(line);
  assert.equal(ev.kind, 'tool_use');
  // 700 字符入参：应保留到 600（+ 省略号），而不是旧的 120
  assert.ok(ev.summary.length > 500 && ev.summary.length <= 601);
});

test('result 行', () => {
  const line = JSON.stringify({
    type: 'result',
    is_error: false,
    session_id: 's1',
    total_cost_usd: 0.01,
    duration_ms: 1200,
  });
  assert.deepEqual(mapStreamJsonLine(line), [
    { kind: 'result', ok: true, sessionId: 's1', costUsd: 0.01, durationMs: 1200 },
  ]);
});

test('空行与脏行返回 null', () => {
  assert.equal(mapStreamJsonLine(''), null);
  assert.equal(mapStreamJsonLine('not json'), null);
});
