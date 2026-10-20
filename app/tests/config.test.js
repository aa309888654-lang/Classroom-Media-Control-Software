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

/* ---------- 原子写 + 损坏回落（2026-10-20 全面检查发现的「设置静默归零」防线） ---------- */

test('save() 原子写：落盘内容合法、留有 .bak、无残留 .tmp', () => {
  const file = path.join(userData, 'config.json');
  config.load();
  config.save({ volume: 0.611 });           // 与当前值必然不同 → 真的写盘
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'config.json 必须是完整合法 JSON');
  assert.ok(fs.existsSync(file + '.bak'), '应保留上一版备份（.bak）');
  assert.ok(!fs.existsSync(file + '.tmp'), '不应残留写盘用的临时文件');
});

test('配置损坏 → load() 回落 .bak，而不是静默重置为默认', () => {
  const file = path.join(userData, 'config.json');
  // 先造一份「上一版完好配置」，让它在下次 save 时进 .bak
  fs.writeFileSync(file, JSON.stringify({ ...config.get(), volume: 0.5 }));
  config.load();
  config.save({ volume: 0.66 });            // .bak := volume=0.5 的那份
  // 再把正式文件弄坏（模拟写盘中途断电留下的半截 JSON）
  fs.writeFileSync(file, '{ broken json');
  const cfg = config.load();
  assert.strictEqual(cfg.volume, 0.5, '损坏后应从 .bak 回落，而不是重置默认');
  assert.ok(config.lastError(), '必须记录「配置损坏」以便提示用户');
});

test('配置损坏且无备份 → 重置默认，但必须留下错误记录', () => {
  const file = path.join(userData, 'config.json');
  fs.writeFileSync(file, '{ broken json');
  try { fs.rmSync(file + '.bak', { force: true }); } catch { }
  const cfg = config.load();
  assert.strictEqual(cfg.hotkeysVer, 7, '无可用备份时应回落到默认配置');
  assert.ok(config.lastError(), '必须记录「配置损坏已重置」，不能静默');
});
