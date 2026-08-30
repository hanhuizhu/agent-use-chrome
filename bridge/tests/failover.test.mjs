/**
 * 失效接管（re-election）集成测试
 *
 * 用真实子进程验证：Primary 被 SIGKILL 后，存活的 Proxy 自动接管为
 * 新 Primary（重新监听 WS 端口），多个 Proxy 竞选时只产生一个新 Primary。
 *
 * 通过 BRIDGE_IPC_PATH / BRIDGE_PORT 环境变量隔离，不干扰本机真实 bridge。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';

const ENTRY = new URL('../dist/index.js', import.meta.url).pathname;
const TOKEN = 'failover-test-token';
const WS_PORT = 12399; // 避开真实端口段 12345-12350，防止本机扩展连上测试进程

/** 启动一个 bridge 子进程，返回 { child, waitLog }，日志按行缓存供断言 */
function spawnBridge(ipcPath) {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      BRIDGE_IPC_PATH: ipcPath,
      BRIDGE_PORT: String(WS_PORT),
      BRIDGE_TOKEN: TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stderr.on('data', (chunk) => {
    logs.push(chunk.toString());
  });

  /** 等待 stderr 出现指定子串（超时抛错） */
  function waitLog(substr, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const check = () => logs.join('').includes(substr);
      if (check()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`等待日志超时：「${substr}」\n实际日志：\n${logs.join('')}`));
      }, timeoutMs);
      const poll = setInterval(() => {
        if (check()) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  }

  return { child, waitLog, logs };
}

/** 验证 WS 端口有活的 bridge 在监听（能完成握手即通过） */
function probeWs() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${WS_PORT}/?token=${TOKEN}`);
    const timer = setTimeout(() => {
      sock.terminate();
      reject(new Error('WS 探测超时'));
    }, 3000);
    sock.on('open', () => {
      clearTimeout(timer);
      sock.close();
      resolve();
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function makeIpcPath() {
  return path.join(os.tmpdir(), `failover-test-${process.pid}-${Date.now()}.sock`);
}

async function killAndWait(child, signal = 'SIGKILL') {
  if (child.exitCode === null && !child.killed) {
    child.kill(signal);
    await once(child, 'exit').catch(() => {});
  }
}

test('Primary 被杀后 Proxy 自动接管为新 Primary', async (t) => {
  const ipcPath = makeIpcPath();
  const a = spawnBridge(ipcPath);
  t.after(async () => {
    await killAndWait(a.child);
    fs.rmSync(ipcPath, { force: true });
  });
  await a.waitLog('Primary 模式');

  const b = spawnBridge(ipcPath);
  t.after(async () => killAndWait(b.child));
  await b.waitLog('Proxy 模式');

  // SIGKILL 模拟硬退出：不走清理逻辑，留下残留 socket 文件
  a.child.kill('SIGKILL');
  await once(a.child, 'exit');

  await b.waitLog('已接管为 Primary');
  await probeWs();
});

test('多个 Proxy 竞选只产生一个新 Primary，落选者转连新主', async (t) => {
  const ipcPath = makeIpcPath();
  const a = spawnBridge(ipcPath);
  t.after(async () => {
    await killAndWait(a.child);
    fs.rmSync(ipcPath, { force: true });
  });
  await a.waitLog('Primary 模式');

  const b = spawnBridge(ipcPath);
  const c = spawnBridge(ipcPath);
  t.after(async () => {
    await killAndWait(b.child);
    await killAndWait(c.child);
  });
  await b.waitLog('Proxy 模式');
  await c.waitLog('Proxy 模式');

  a.child.kill('SIGKILL');
  await once(a.child, 'exit');

  // 等到 B/C 各自完成选主（一个接管、一个转连）
  const outcome = (logs) => {
    const text = logs.join('');
    if (text.includes('已接管为 Primary')) return 'primary';
    if (text.includes('已连接到新 Primary')) return 'proxy';
    return null;
  };
  const deadline = Date.now() + 15_000;
  let bRole = null;
  let cRole = null;
  while (Date.now() < deadline) {
    bRole = outcome(b.logs);
    cRole = outcome(c.logs);
    if (bRole && cRole) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.ok(bRole && cRole, `选主未在期限内完成：B=${bRole} C=${cRole}\nB 日志：\n${b.logs.join('')}\nC 日志：\n${c.logs.join('')}`);
  const roles = [bRole, cRole].sort();
  assert.deepEqual(roles, ['primary', 'proxy'], `期望一主一从，实际 B=${bRole} C=${cRole}`);
  await probeWs();
});
