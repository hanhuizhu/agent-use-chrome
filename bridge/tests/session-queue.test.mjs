import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SessionManager } from '../dist/session-manager.js';

/** 伪造 claude 子进程：可控地写 stdout / 触发 close */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  return child;
}

function setup() {
  const spawned = []; // { child, args }
  const spawnImpl = (_bin, args) => {
    const child = fakeChild();
    spawned.push({ child, args });
    return child;
  };
  const sm = new SessionManager({ spawnImpl, claudeBin: '/usr/bin/true' });
  return { sm, spawned };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('空闲立即执行，参数含 --include-partial-messages', () => {
  const { sm, spawned } = setup();
  const res = sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, () => {});
  assert.deepEqual(res, { started: true });
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('--include-partial-messages'));
});

test('忙时入队，结束后自动续发并推 turn_start', async () => {
  const { sm, spawned } = setup();
  const ev2 = [];
  sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, () => {});
  const res2 = sm.send(
    't2',
    { cwd: '/tmp', message: 'b', permissionMode: 'default' },
    (e) => ev2.push(e),
  );
  assert.deepEqual(res2, { queued: true, position: 1 });
  assert.equal(spawned.length, 1); // 第二条尚未执行

  spawned[0].child.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-1' }) + '\n',
  );
  await tick();
  spawned[0].child.emit('close', 0, null);
  await tick();

  assert.equal(spawned.length, 2); // 自动续发
  assert.deepEqual(ev2[0], { kind: 'turn_start' });
});

test('排队的新会话消息续接前序轮次的 sessionId', async () => {
  const { sm, spawned } = setup();
  // 两条消息都不带 sessionId（新会话）
  sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, () => {});
  sm.send('t2', { cwd: '/tmp', message: 'b', permissionMode: 'default' }, () => {});
  spawned[0].child.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-new' }) + '\n',
  );
  await tick();
  spawned[0].child.emit('close', 0, null);
  await tick();
  const args2 = spawned[1].args;
  assert.ok(args2.includes('--resume'));
  assert.equal(args2[args2.indexOf('--resume') + 1], 'sess-new');
});

test('cancel 终止当前轮次并清空队列（排队消息推「已取消」）', async () => {
  const { sm, spawned } = setup();
  const ev1 = [];
  const ev2 = [];
  sm.send('t1', { cwd: '/tmp', message: 'a', permissionMode: 'default' }, (e) => ev1.push(e));
  sm.send('t2', { cwd: '/tmp', message: 'b', permissionMode: 'default' }, (e) => ev2.push(e));
  assert.equal(sm.cancel(), true);
  await tick();
  assert.deepEqual(ev2, [{ kind: 'error', message: '已取消' }]);
  assert.ok(ev1.some((e) => e.kind === 'error' && e.message === '已取消'));
  assert.equal(spawned.length, 1); // 队列被清，未续发
});
