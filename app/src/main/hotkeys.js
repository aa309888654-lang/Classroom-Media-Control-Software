const { globalShortcut } = require('electron');
const config = require('./config');

const ACTION_KEYS = ['playPause', 'prev', 'next', 'volUp', 'volDown', 'mute', 'cat1', 'cat2', 'present', 'exitPresent', 'pptPrev', 'pptNext', 'timerToggle', 'timerReset', 'openFull', 'exitFull'];
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super', 'Command', 'Cmd', 'CommandOrControl', 'Meta'];
// 无修饰键也安全的键位：功能键与具名键（不会吞掉字母/数字输入）；F13-F24 也放行
const STANDALONE_RE = /^(F([1-9]|1[0-9]|2[0-4])|Escape|Grave|`)$/;

// 系统保留组合（BUG-13）：全局注册后会被系统级截走，复制粘贴/关闭窗口/显示桌面等全校办公软件
// 功能都会被吞掉，且用户很难自查。这些组合即使「能注册成功」也应拒绝。
const RESERVED_RES = [
  /^(Control|Ctrl|Command|Cmd|Super|Win|Meta)\+(Shift\+)?[A-Z]$/, // Ctrl/Cmd/Win + 字母：复制/粘贴/保存/关闭/锁屏/运行…
  /^Alt\+F4$/i,                                                    // 关窗
  /^Control\+Shift\+Escape$/,                                      // 任务管理器
];
function isReserved(acc) {
  const a = String(acc);
  return RESERVED_RES.some((re) => re.test(a));
}

// 要么含修饰键，要么是功能/具名键——否则全局钩子会吞掉普通按键（比如全系统的 M 键都失效）
function hasModifier(acc) {
  const a = String(acc);
  return MODIFIERS.some((m) => a.split('+').includes(m)) || STANDALONE_RE.test(a) || a === '~';
}

// 不能注册成全局快捷键的键位：RegisterHotKey 会在系统层截走按键，
// 导致 PowerPoint/WPS 全屏放映、其他全屏应用收不到 Esc，出现「退不出全屏」；
// 裸 ~ 也同理——输入框打字时按到会误触切换 LED 全屏。
// 这两类键的语义只在本窗口获得焦点时生效（渲染层 keydown 路由）。
const IN_WINDOW_ONLY = new Set(['Escape', 'Esc', '`', '~', 'Grave', 'Backquote']);
// 默认键位就是窗口内键的两个动作：允许改回 `/Esc（否则改键后永远回不去）
const IN_WINDOW_ACTIONS = new Set(['openFull', 'exitFull']);

// 笔记本多媒体音量键兜底：很多机型 F4/F5/F6 的媒体层发出的不是 F 键扫描码，
// 而是系统音量媒体键（VK_VOLUME_MUTE/DOWN/UP），只注册 F4/F5/F6 接不住。
// 固定注册这三个媒体键映射到同一动作（不进改键配置，注册失败静默），仅 Windows。
const MEDIA_KEYS = { VolumeMute: 'mute', VolumeDown: 'volDown', VolumeUp: 'volUp' };

// 注册全局快捷键；返回冲突清单 [{action, accelerator}]
function registerAll(onAction) {
  onActionRef = onAction; // 直接初始化回调引用，避免注册期间媒体键无响应
  try { globalShortcut.unregisterAll(); } catch { }
  const conflicts = [];
  const hotkeys = config.get().hotkeys;
  for (const action of ACTION_KEYS) {
    const acc = hotkeys[action];
    if (!acc || !hasModifier(acc)) continue;
    if (IN_WINDOW_ONLY.has(acc)) continue; // 裸 Esc 只做窗口内处理，不进全局钩子
    if (isReserved(acc)) continue; // 系统保留组合：即便旧配置里存了也拒绝注册（BUG-13）
    const ok = globalShortcut.register(acc, () => onAction(action));
    if (!ok) conflicts.push({ action, accelerator: acc });
  }
  if (process.platform === 'win32') {
    for (const [acc, action] of Object.entries(MEDIA_KEYS)) {
      try { globalShortcut.register(acc, () => onActionRef && onActionRef(action)); } catch { }
    }
  }
  return conflicts;
}

// PPT 放映时音量键不注册（让系统原生处理，控制 PPT 内嵌视频音量）
// 退出放映时恢复注册
let mediaKeysRegistered = true;
let onActionRef = null;
function setMediaKeysEnabled(enabled) {
  if (enabled === mediaKeysRegistered) return;
  mediaKeysRegistered = enabled;
  if (process.platform !== 'win32') return;
  if (enabled) {
    for (const [acc, action] of Object.entries(MEDIA_KEYS)) {
      try { globalShortcut.register(acc, () => onActionRef && onActionRef(action)); } catch { }
    }
  } else {
    for (const acc of Object.keys(MEDIA_KEYS)) {
      try { globalShortcut.unregister(acc); } catch { }
    }
  }
}
function setActionHandler(fn) { onActionRef = fn; }

// 改键：先注销旧的，注册成功才落盘
function remap(action, accelerator, onAction) {
  const old = config.get().hotkeys[action];
  if (!hasModifier(accelerator)) return { ok: false, error: 'need-modifier', accelerator: old };
  if (isReserved(accelerator)) return { ok: false, error: 'reserved', accelerator: old }; // BUG-13：系统保留组合直接拒绝
  // 窗口内专用键（`/Esc）：只有默认就用它们的全屏动作允许设置（且不进全局钩子，由渲染层 keydown 路由）
  if (IN_WINDOW_ONLY.has(accelerator)) {
    if (!IN_WINDOW_ACTIONS.has(action)) return { ok: false, error: 'in-window-only', accelerator: old };
    // 窗口内专用键：只落盘不注册（全局注册 Esc/` 会把该键从所有窗口里吞掉）；
    // 旧键若是全局键要先注销（如从 F9 改回 Esc）
    if (old && !IN_WINDOW_ONLY.has(old)) { try { globalShortcut.unregister(old); } catch { } }
    config.save({ hotkeys: { ...config.get().hotkeys, [action]: accelerator } });
    return { ok: true, accelerator };
  }
  if (old) { try { globalShortcut.unregister(old); } catch { } }
  if (!globalShortcut.register(accelerator, () => onAction(action))) {
    // 注册失败则回滚
    if (old) globalShortcut.register(old, () => onAction(action));
    return { ok: false, accelerator: old };
  }
  config.save({ hotkeys: { ...config.get().hotkeys, [action]: accelerator } });
  return { ok: true, accelerator };
}

module.exports = { registerAll, remap, ACTION_KEYS, setMediaKeysEnabled, setActionHandler };
