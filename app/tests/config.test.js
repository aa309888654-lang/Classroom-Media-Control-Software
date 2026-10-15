/* config 模块单测：deepMerge 语义、迁移、save 跳过重复写盘（BUG/GAP 回归防线） */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { installElectron } = require('./helpers');
const { userData } = installElectron();
const config = require('../src/main/config.js');

test('load() 空目录落默认配置', () => {
  const cfg = config.load();
  assert.strictEqual(cfg.hotkeysVer, 7);
  assert.strictEqual(cfg.autoLaunch, false);
  assert.strictEqual(cfg.castAutoTrustCert, true);
  assert.ok(cfg.musicDir.length > 0);
});

test('save() 内容不变跳过写盘', () => {
  const file = path.join(userData, 'config.json');
  config.load();
  config.save({ volume: 0.42 });
  const m1 = fs.statSync(file).mtimeMs;
  // 内容相同 → 不写盘（文件 mtime 不变）
  config.save({ volume: 0.42 });
  const m2 = fs.statSync(file).mtimeMs;
  assert.strictEqual(m2, m1);
  // 内容变化 → 写盘
  config.save({ volume: 0.43 });
  assert.strictEqual(config.get().volume, 0.43);
});

test('undefined 不覆盖已有值（防污染配置）', () => {
  config.load();
  config.save({ volume: 0.55 });
  config.save({ volume: undefined, loopMode: 'single' });
  assert.strictEqual(config.get().volume, 0.55);
  assert.strictEqual(config.get().loopMode, 'single');
});

test('数组整体替换而非合并（曲目排序等场景）', () => {
  config.load();
  config.save({ recentPpt: ['a.pptx', 'b.pptx'] });
  config.save({ recentPpt: ['c.pptx'] });
  assert.deepStrictEqual(config.get().recentPpt, ['c.pptx']);
});

test('hotkeysVer 迁移：旧版本号重置为默认方案', () => {
  const file = path.join(userData, 'config.json');
  const cur = config.get();
  fs.writeFileSync(file, JSON.stringify({ ...cur, hotkeysVer: 3, hotkeys: { mute: 'X' } }));
  const cfg = config.load();
  assert.strictEqual(cfg.hotkeysVer, 7);
  assert.notStrictEqual(cfg.hotkeys.mute, 'X');
});
