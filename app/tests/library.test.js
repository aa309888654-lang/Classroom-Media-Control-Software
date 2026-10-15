/* library 模块单测：mergeCategories 合并去重（PERF-07）、applyOrder 手动排序优先 */
const { test } = require('node:test');
const assert = require('node:assert');

const { installElectron } = require('./helpers');
installElectron();
const library = require('../src/main/library.js');

test('mergeCategories：同名分类合并、曲目去重、保留顺序', () => {
  const out = library.mergeCategories([
    { category: '暖场', builtin: true, virtual: false, tracks: ['a.mp3', 'b.mp3'] },
    { category: '暖场', builtin: false, virtual: true, tracks: ['b.mp3', 'c.mp3'] }, // 用户自建同名文件夹
    { category: '轻松', builtin: true, virtual: false, tracks: ['d.mp3'] },
  ]);
  assert.strictEqual(out.length, 2);
  const warm = out.find((c) => c.category === '暖场');
  assert.deepStrictEqual(warm.tracks, ['a.mp3', 'b.mp3', 'c.mp3']);
  assert.strictEqual(warm.builtin, false); // 内置 && 自建 → false（用户文件夹优先语义）
  assert.strictEqual(warm.virtual, false);
});

test('applyOrder：手动排序优先，未排过的按修改时间倒序排后面', () => {
  const list = [
    { file: 'a.mp4', mtime: 100 },
    { file: 'b.mp4', mtime: 300 },
    { file: 'c.mp4', mtime: 200 },
  ];
  const out = library.applyOrder(list, ['c.mp4', 'a.mp4']);
  assert.deepStrictEqual(out.map((x) => x.file), ['c.mp4', 'a.mp4', 'b.mp4']);
});

test('applyOrder：空排序数组原样返回（同一引用，无副作用）', () => {
  const list = [{ file: 'a.mp4' }, { file: 'b.mp4' }];
  assert.strictEqual(library.applyOrder(list, []), list);
  assert.strictEqual(library.applyOrder(list, null), list);
});

test('pushRecent：新项置顶、去重、上限截断', () => {
  const config = require('../src/main/config.js');
  config.load();
  config.save({ recentVideo: ['x.mp4', 'y.mp4'] });
  library.pushRecent('video', 'z.mp4');
  assert.strictEqual(config.get().recentVideo[0], 'z.mp4');
  library.pushRecent('video', 'x.mp4'); // 已存在的提到最前
  const after = config.get().recentVideo;
  assert.strictEqual(after[0], 'x.mp4');
  assert.strictEqual(new Set(after).size, after.length); // 无重复
});

// 库扫描改为异步（避免 readdirSync/statSync 冻结主进程）后的回归防线：
// 必须返回 Promise，且解析出真实条目 + 正确的 kind/size/mtime。
test('scanVideos/scanPpts/scanMusic：异步返回真实条目（异步化回归）', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const config = require('../src/main/config.js');
  config.load();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-libscan-'));
  const vdir = path.join(root, 'video');
  const pdir = path.join(root, 'ppt');
  const mdir = path.join(root, 'music', '暖场');
  fs.mkdirSync(vdir, { recursive: true });
  fs.mkdirSync(pdir, { recursive: true });
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, 'a.mp4'), '0123456789');
  fs.writeFileSync(path.join(pdir, 'b.pptx'), 'xxxx');
  fs.writeFileSync(path.join(pdir, 'c.pdf'), 'yy');
  fs.writeFileSync(path.join(pdir, 'd.jpg'), 'zz');
  fs.writeFileSync(path.join(mdir, 's1.mp3'), 'abc');

  config.save({ videoDir: vdir, pptDir: pdir, musicDir: path.join(root, 'music'), builtinMusicEnabled: false });

  const vs = library.scanVideos();
  assert.ok(vs && typeof vs.then === 'function', 'scanVideos 必须返回 Promise（漏 await 会静默拿到 Promise 对象）');
  const videos = await vs;
  assert.strictEqual(videos.length, 1);
  assert.strictEqual(videos[0].name, 'a.mp4');
  assert.strictEqual(videos[0].size, 10);

  const ppts = await library.scanPpts();
  assert.strictEqual(ppts.length, 3);
  const byName = Object.fromEntries(ppts.map((p) => [p.name, p.kind]));
  assert.strictEqual(byName['b.pptx'], 'ppt', 'PPT 应识别为 ppt');
  assert.strictEqual(byName['c.pdf'], 'doc', 'PDF 应识别为 doc');
  assert.strictEqual(byName['d.jpg'], 'img', '图片应识别为 img');

  const music = await library.scanMusic();
  const cat = music.find((c) => c.category === '暖场');
  assert.ok(cat && cat.tracks.length === 1, '应扫到「暖场」分类的 1 首');

  fs.rmSync(root, { recursive: true, force: true });
});
