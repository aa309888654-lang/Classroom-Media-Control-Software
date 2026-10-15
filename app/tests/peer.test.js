/* peer.js 信标合并纯函数测试：设备表刷新、TTL 过期剔除、名字回退、排序。
 * 不依赖真实网络——mergePeers 是纯函数，直接构造输入。 */
const { test } = require('node:test');
const assert = require('node:assert');

const { mergePeers, PEER_TTL } = require('../src/main/peer.js');

test('同一 ip:port 再次出现只刷新时间戳，不产生重复项', () => {
  const t0 = 1_000_000;
  let list = mergePeers([], { ip: '192.168.1.5', port: 18333, name: '教室电脑' }, t0);
  list = mergePeers(list, { ip: '192.168.1.5', port: 18333, name: '教室电脑' }, t0 + 3000);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].lastSeen, t0 + 3000);
  assert.strictEqual(list[0].name, '教室电脑');
});

test('新信标不带 name 时沿用该设备此前的名字', () => {
  const t0 = 1_000_000;
  let list = mergePeers([], { ip: '10.0.0.7', port: 18333, name: '办公室' }, t0);
  list = mergePeers(list, { ip: '10.0.0.7', port: 18333, name: '' }, t0 + 1000);
  assert.strictEqual(list[0].name, '办公室');
});

test('从未有过名字时回退为 IP', () => {
  const list = mergePeers([], { ip: '10.0.0.9', port: 18333, name: '' }, 1_000_000);
  assert.strictEqual(list[0].name, '10.0.0.9');
});

test('超过 TTL 未再出现的设备被剔除', () => {
  const t0 = 1_000_000;
  const list = mergePeers([], { ip: '192.168.1.5', port: 18333, name: 'A' }, t0);
  const later = mergePeers(list, { ip: '192.168.1.6', port: 18333, name: 'B' }, t0 + PEER_TTL);
  assert.strictEqual(later.length, 1);
  assert.strictEqual(later[0].ip, '192.168.1.6');
});

test('TTL 边界内仍保留', () => {
  const t0 = 1_000_000;
  const list = mergePeers([], { ip: '192.168.1.5', port: 18333, name: 'A' }, t0);
  const later = mergePeers(list, { ip: '192.168.1.6', port: 18333, name: 'B' }, t0 + PEER_TTL - 1);
  assert.strictEqual(later.length, 2);
});

test('设备表按名字排序（中文按拼音）', () => {
  const t0 = 1_000_000;
  let list = mergePeers([], { ip: '192.168.1.3', port: 18333, name: '三年二班' }, t0);
  list = mergePeers(list, { ip: '192.168.1.1', port: 18333, name: '会议室' }, t0 + 1);
  list = mergePeers(list, { ip: '192.168.1.2', port: 18333, name: '办公室' }, t0 + 2);
  assert.deepStrictEqual(list.map((p) => p.name), ['办公室', '会议室', '三年二班']);
});

test('port 统一规整为数字', () => {
  const list = mergePeers([], { ip: '192.168.1.5', port: '18333', name: 'A' }, 1_000_000);
  assert.strictEqual(list[0].port, 18333);
});
