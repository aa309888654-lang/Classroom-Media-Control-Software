/* pptServer 回归测试（BUG-02/BUG-14 的直接防线，报告 GAP-01 第 2 步）：
 * stub powershell.exe 覆盖 并发不互杀 / 崩溃自愈 / 懒预热 / close 幂等 四条路径。 */
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { installElectron, patchSpawn } = require('./helpers');
installElectron();

let spawnCount = 0;
const procs = [];
const written = []; // 捕获主进程写给常驻脚本的请求 JSON：校验协议字段透传
patchSpawn((cmd) => {
  if (!/powershell/i.test(String(cmd))) return null;
  spawnCount++;
  const proc = new EventEmitter();
  proc.pid = 90000 + spawnCount;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write: (s) => {
      for (const line of String(s).split('\n')) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        written.push(j);
        setTimeout(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({ seq: j.seq, ok: true, action: j.action }) + '\n')), 5);
      }
    },
  };
  proc.kill = () => { proc.killed = true; setTimeout(() => proc.emit('exit', 1, null), 2); return true; };
  procs.push(proc);
  setTimeout(() => proc.stdout.emit('data', Buffer.from('SERVER_READY\n')), 40);
  return proc;
});

const pptServer = require('../src/main/pptServer.js');

test('并发 exec 不互杀：3 个并发请求共用 1 个进程且全部拿到响应（BUG-02）', async () => {
  const before = spawnCount;
  const [a, b, c] = await Promise.all([
    pptServer.exec('next', {}, 3000, 'ctl'),
    pptServer.exec('next', {}, 3000, 'ctl'),
    pptServer.exec('next', {}, 3000, 'ctl'),
  ]);
  assert.strictEqual(spawnCount - before, 1, '应只 spawn 一次');
  assert.ok(a && a.ok && b && b.ok && c && c.ok, '三个请求都应成功');
});

test('进程退出后下一次 exec 自动重建', async () => {
  const before = spawnCount;
  const cur = procs[procs.length - 1];
  cur.kill();
  await new Promise((r) => setTimeout(r, 80));
  const r = await pptServer.exec('prev', {}, 3000, 'ctl');
  assert.ok(r && r.ok);
  assert.ok(spawnCount - before >= 1, '应重建进程');
});

test('warmup() 默认只热 ctl 通道（GAP-07）', async () => {
  pptServer.close();
  const before = spawnCount;
  pptServer.warmup();
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(spawnCount - before, 1);
});

test('close() 幂等且收掉所有通道进程（BUG-14）', async () => {
  pptServer.warmup(['ctl', 'thumb']);
  await new Promise((r) => setTimeout(r, 150));
  pptServer.close();
  pptServer.close(); // 连调两次不抛
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(procs.filter((p) => !p.killed).length, 0, '所有进程应被杀掉');
});

test('noexport 透传：presenter 请求按参数带 noexport 字段（放映翻页期停导图，PERF-12）', async () => {
  written.length = 0;
  const r1 = await pptServer.exec('presenter', { exportDir: 'D', noexport: true }, 3000, 'thumb');
  assert.ok(r1 && r1.ok);
  assert.strictEqual(written[written.length - 1].noexport, 'true', 'noexport=true 应传 true');
  written.length = 0;
  const r2 = await pptServer.exec('presenter', { exportDir: 'D' }, 3000, 'thumb');
  assert.ok(r2 && r2.ok);
  assert.strictEqual(written[written.length - 1].noexport, '', '缺省不抑制导图');
});
