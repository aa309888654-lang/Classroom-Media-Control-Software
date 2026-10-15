/* hotkeys 模块单测：保留组合黑名单（BUG-13）+ F13-F24 放行 + hasModifier 判定表 */
const { test } = require('node:test');
const assert = require('node:assert');

const { installElectron } = require('./helpers');
installElectron();
const hotkeys = require('../src/main/hotkeys.js');

const noop = () => { };

test('系统保留组合被拒绝', () => {
  for (const acc of ['Control+C', 'Control+V', 'Control+Shift+S', 'Command+C', 'Super+D', 'Meta+L', 'Alt+F4', 'Control+Shift+Escape']) {
    const r = hotkeys.remap('playPause', acc, noop);
    assert.strictEqual(r.error, 'reserved', `${acc} 应被拒绝`);
  }
});

test('含修饰键的合法组合放行', () => {
  for (const acc of ['Super+Alt+M', 'Control+F9', 'Control+Alt+Right', 'Alt+F7']) {
    const r = hotkeys.remap('playPause', acc, noop);
    assert.strictEqual(r.ok, true, `${acc} 应放行，实际 ${JSON.stringify(r)}`);
  }
});

test('F1-F24 单键放行，F25+ 拒绝', () => {
  assert.strictEqual(hotkeys.remap('playPause', 'F13', noop).ok, true);
  assert.strictEqual(hotkeys.remap('playPause', 'F24', noop).ok, true);
  assert.strictEqual(hotkeys.remap('playPause', 'F25', noop).error, 'need-modifier');
});

test('裸字母/数字必须拒绝（否则吞掉全局按键）', () => {
  assert.strictEqual(hotkeys.remap('playPause', 'M', noop).error, 'need-modifier');
  assert.strictEqual(hotkeys.remap('playPause', '5', noop).error, 'need-modifier');
});

test('窗口内专用键只允许 openFull/exitFull', () => {
  assert.strictEqual(hotkeys.remap('playPause', 'Escape', noop).error, 'in-window-only');
  assert.strictEqual(hotkeys.remap('exitFull', 'Escape', noop).ok, true);
});
