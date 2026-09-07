const { globalShortcut } = require('electron');
const config = require('./config');

const ACTION_KEYS = ['playPause', 'prev', 'next', 'volUp', 'volDown', 'mute', 'cat1', 'cat2', 'present', 'exitPresent', 'timerToggle', 'timerReset', 'openFull', 'exitFull'];
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super', 'Command', 'Cmd', 'CommandOrControl', 'Meta'];
// 无修饰键也安全的键位：功能键与具名键（不会吞掉字母/数字输入）
const STANDALONE_RE = /^(F[1-9]|F1[0-2]|Escape|Grave|`)$/;

// 要么含修饰键，要么是功能/具名键——否则全局钩子会吞掉普通按键（比如全系统的 M 键都失效）
function hasModifier(acc) {
  const a = String(acc);
  return MODIFIERS.some((m) => a.split('+').includes(m)) || STANDALONE_RE.test(a) || a === '~';
}

// 注册全局快捷键；返回冲突清单 [{action, accelerator}]
function registerAll(onAction) {
  try { globalShortcut.unregisterAll(); } catch { }
  const conflicts = [];
  const hotkeys = config.get().hotkeys;
  for (const action of ACTION_KEYS) {
    const acc = hotkeys[action];
    if (!acc || !hasModifier(acc)) continue;
    const ok = globalShortcut.register(acc, () => onAction(action));
    if (!ok) conflicts.push({ action, accelerator: acc });
  }
  return conflicts;
}

// 改键：先注销旧的，注册成功才落盘
function remap(action, accelerator, onAction) {
  const old = config.get().hotkeys[action];
  if (!hasModifier(accelerator)) return { ok: false, error: 'need-modifier', accelerator: old };
  if (old) { try { globalShortcut.unregister(old); } catch { } }
  if (!globalShortcut.register(accelerator, () => onAction(action))) {
    // 注册失败则回滚
    if (old) globalShortcut.register(old, () => onAction(action));
    return { ok: false, accelerator: old };
  }
  config.save({ hotkeys: { ...config.get().hotkeys, [action]: accelerator } });
  return { ok: true, accelerator };
}

module.exports = { registerAll, remap, ACTION_KEYS };
