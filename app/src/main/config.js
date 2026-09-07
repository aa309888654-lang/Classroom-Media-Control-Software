const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const IS_MAC = process.platform === 'darwin';

// 默认快捷键分平台：Windows 用 Ctrl/Alt+F 系（避开 F4/F5 雷区）；
// macOS 上 Ctrl+F* 与系统快捷键冲突且 F 键需 Fn，改用 Cmd+Alt+字母/方向键（Mac 习惯且全局冲突少）
const HOTKEYS_WIN = {
  prev: 'Control+F3',
  playPause: 'Control+F6',
  next: 'Control+F7',
  mute: 'Control+F8',         // 静音/恢复
  volDown: 'Control+F9',
  volUp: 'Control+F10',
  cat1: 'Control+F11',
  cat2: 'Control+F12',
  present: 'Control+F1',      // 放映课件
  exitPresent: 'Control+F2',  // 退出投屏
  timerToggle: 'Alt+F7',      // Ctrl 系只剩 F10/F12(Office)等雷区，Alt+F 两键且免
  timerReset: 'Alt+F8',
  openFull: '`',      // ~ 打开全屏
  exitFull: 'Escape', // Esc 退出全屏
};
const HOTKEYS_MAC = {
  prev: 'Super+Alt+Left',
  playPause: 'Super+Alt+M',
  next: 'Super+Alt+Right',
  mute: 'Super+Alt+0',
  volDown: 'Super+Alt+Down',
  volUp: 'Super+Alt+Up',
  cat1: 'Super+Alt+1',
  cat2: 'Super+Alt+2',
  present: 'Super+Alt+P',
  exitPresent: 'Super+Alt+E',
  timerToggle: 'Super+Alt+T',
  timerReset: 'Super+Alt+R',
  openFull: '`',
  exitFull: 'Escape',
};

const DEFAULTS = {
  musicDir: '',
  videoDir: '',
  builtinMusicEnabled: true,
  volume: 0.7,
  crossfadeSeconds: 2,
  playPauseFadeSeconds: 0.5,
  loopMode: 'list', // 'list' | 'single'
  uiDensity: 'compact', // 'compact' | 'roomy'
  displayMode: 'control', // 'control' | 'led'
  catOrder: [], // 分类卡片排序（长按拖动后持久化）
  catPinned: {}, // 每个分类置顶的曲目（决定默认显示的前三首）
  catTrackOrder: {}, // 每个分类内曲目的手工排序（长按拖动后持久化）
  windowBounds: null, // 记忆窗口位置尺寸
  display: { teacherScreenIndex: 0, forceExtendOnPresent: true },
  office: { prefer: 'auto' }, // 'auto' | 'powerpoint' | 'wps'
  exitAction: { restoreMusic: true, closePowerpoint: true },
  hotkeysVer: IS_MAC ? 6 : 5, // 快捷键方案版本（分平台）；升级即重置为当前默认
  hotkeys: IS_MAC ? HOTKEYS_MAC : HOTKEYS_WIN,
  recentPpt: [],
  recentVideo: [],
  pptDir: '',        // 课件文件夹（PPT 库根目录）
  videoOrder: [],    // 视频库手动排序（长按拖动后持久化）
  pptOrder: [],      // 课件库手动排序（长按拖动后持久化）
  miniMode: false,   // 迷你模式：极小控制面板（单屏 LED 场景）
  miniAutoHide: true, // 迷你面板贴在屏幕右下角时自动隐藏，鼠标靠近浮现
  miniBounds: null,  // 迷你模式的窗口位置尺寸（与正常 windowBounds 分开记忆）
  // 文字欢迎屏：文字/副标题/背景序号/样式序号/字体序号/LOGO
  welcome: { text: '欢迎各位领导莅临指导', sub: '小天AIGC · 课堂中控', bg: 1, style: 1, font: 1, logo: { path: '', pos: 'tl' } },
};

let cfg = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue; // undefined 不覆盖，防止污染配置
      out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

function load() {
  try {
    cfg = deepMerge(structuredClone(DEFAULTS), JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    cfg = structuredClone(DEFAULTS);
  }
  if (!cfg.musicDir) cfg.musicDir = path.join(app.getPath('documents'), '小天AIGC', '音乐');
  if (!cfg.videoDir) cfg.videoDir = path.join(app.getPath('documents'), '小天AIGC', '视频');
  if (!cfg.pptDir) cfg.pptDir = path.join(app.getPath('documents'), '小天AIGC', '课件');
  // 快捷键方案迁移：版本不符就整体升级为当前默认（V5=Windows Ctrl/Alt+F 系；V6=macOS Cmd+Alt 系）
  const wantVer = IS_MAC ? 6 : 5;
  if (cfg.hotkeysVer !== wantVer || !cfg.hotkeys || !cfg.hotkeys.mute) {
    cfg.hotkeys = structuredClone(IS_MAC ? HOTKEYS_MAC : HOTKEYS_WIN);
    cfg.hotkeysVer = wantVer;
  }
  return cfg;
}

function get() {
  return cfg || load();
}

function save(patch) {
  cfg = deepMerge(get(), patch);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

module.exports = { get, save, load };
