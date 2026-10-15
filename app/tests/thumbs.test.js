/* thumbs 模块单测：缓存 key 碰撞防线（BUG-03）+ 命中缓存跳过（BUG-04） */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installElectron } = require('./helpers');
installElectron();
const thumbs = require('../src/main/thumbs.js');

test('cachePath：不同目录同名同大小同 mtime 的文件不串图（BUG-03 回归）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-thumbs-'));
  const a = path.join(dir, 'a', 'same.mp4');
  const b = path.join(dir, 'b', 'same.mp4');
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.mkdirSync(path.dirname(b), { recursive: true });
  const t = new Date(1700000000000);
  for (const f of [a, b]) { fs.writeFileSync(f, '0123456789'); fs.utimesSync(f, t, t); }
  const pa = thumbs.cachePath(a, 'vid');
  const pb = thumbs.cachePath(b, 'vid');
  assert.notStrictEqual(pa, pb, '两个文件缓存路径必须不同');
  assert.ok(pa.includes('same.mp4'), '缓存名仍含可读文件名');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cachePath：同一文件内容变化（mtime 变）后 key 变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-thumbs2-'));
  const f = path.join(dir, 'v.mp4');
  fs.writeFileSync(f, 'aaa');
  const p1 = thumbs.cachePath(f, 'vid');
  fs.writeFileSync(f, 'aaaaaa');
  fs.utimesSync(f, new Date(1700000100000), new Date(1700000100000));
  const p2 = thumbs.cachePath(f, 'vid');
  assert.notStrictEqual(p1, p2, '文件变了 key 必须变');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cached：命中返回路径，未命中返回空串', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-thumbs3-'));
  const f = path.join(dir, 'v.mp4');
  fs.writeFileSync(f, 'aaa');
  assert.strictEqual(thumbs.cached('video', f), '', '未生成时应为空串');
  const p = thumbs.cachePath(f, 'vid');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'PNG');
  assert.strictEqual(thumbs.cached('video', f), p, '已生成应命中');
  fs.rmSync(dir, { recursive: true, force: true });
});
