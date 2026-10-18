const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const IS_MAC = process.platform === 'darwin';

// 默认快捷键分平台：Windows 控制类用 Ctrl/Alt+F 系；音量三键用裸 F4/F5/F6
//（对标笔记本键盘的静音/减音量/加音量键位，媒体键兜底见 hotkeys.js）；
// macOS 上 Ctrl+F* 与系统快捷键冲突且 F 键需 Fn，改用 Cmd+Alt+字母/方向键（Mac 习惯且全局冲突少）
const HOTKEYS_WIN = {
  prev: 'Control+F3',
  playPause: 'Control+F6',
  next: 'Control+F7',
  mute: 'F4',                 // 笔记本音量键位：F4 静音
  volDown: 'F5',              // F5 减音量
  volUp: 'F6',                // F6 加音量
  cat1: 'Control+F11',
  cat2: 'Control+F12',
  present: 'Control+F1',      // 放映课件
  exitPresent: 'Control+F2',  // 退出投屏
  pptPrev: 'Control+Alt+Left',   // PPT 上一页（COM 驱动放映视图，不抢焦点）
  pptNext: 'Control+Alt+Right',  // PPT 下一页
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
  pptPrev: 'Super+Alt+Comma',    // PPT 上一页（方向键已给音乐切歌）
  pptNext: 'Super+Alt+Period',   // PPT 下一页
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
  loopMode: 'list', // 'list' | 'single' | 'once'
  uiDensity: 'compact', // 'compact' | 'roomy'
  displayMode: 'control', // 'control' | 'led'
  catOrder: ['开学组', '开课音乐'], // 分类卡片排序（长按拖动后持久化）；默认「开学组」「开课音乐」在前两组
  catShowLimit: 3,   // 分类歌单默认只显示前 3 个分类；0=全部显示，N=只显示排序后的前 N 个（歌单栏 ＋/− 可调，最少 1）
  mediaSplit: 0.41,  // 音视频并列行：视频列占比（分隔条拖动后持久化，0.25~0.75）
  mediaSplitV: 300,  // 音视频上下堆叠（窄窗口）时视频区高度 px（分隔条拖动后持久化）
  toolsVisible: true, // 投屏面板右侧的课堂工具卡是否显示（顶栏「工具」按钮切换）
  videoVisible: true, // 视频板块是否显示（顶栏「视频」按钮切换；隐藏后音乐板占满整行）
  catPinned: {}, // 每个分类置顶的曲目（决定默认显示的前三首）
  catTrackOrder: {}, // 每个分类内曲目的手工排序（长按拖动后持久化）
  sectionOrder: [],  // 主面板板块顺序（长按板块标题拖动后持久化）；空 = 默认（投屏/视频/音乐/课堂工具）
  windowBounds: null, // 记忆窗口位置尺寸
  display: {
    teacherScreenIndex: 0,
    projectionId: 0, // 投屏目标屏：0=智能识别（外接屏中挑一块）；>0=用户手动指定，拔掉后自动退回智能识别
    forceExtendOnPresent: true,
    autoTopOnPresent: true,
  }, // autoTopOnPresent：放映 PPT 时自动把面板置顶（挡 PPT 全屏/主窗口），退出放映后还原
  office: { prefer: 'auto' }, // 'auto' | 'powerpoint' | 'wps'
  exitAction: { restoreMusic: true, closePowerpoint: false }, // 退出放映只退全屏，不关闭 PowerPoint/WPS 程序（可在设置里改）
  hotkeysVer: 7, // 快捷键方案版本；升级即重置为当前默认（V7：Win 音量键改为裸 F4/F5/F6）
  hotkeys: IS_MAC ? HOTKEYS_MAC : HOTKEYS_WIN,
  recentPpt: [],
  recentVideo: [],
  pptDir: '',        // 课件文件夹（PPT 库根目录）
  videoOrder: [],    // 视频库手动排序（长按拖动后持久化）
  pptOrder: [],      // 课件库手动排序（长按拖动后持久化）
  miniMode: false,   // 迷你模式：极小控制面板（单屏 LED 场景）
  miniAutoHide: true, // 迷你面板贴在屏幕右下角时自动隐藏，鼠标靠近浮现
  miniBounds: null,  // 迷你模式的窗口位置尺寸（与正常 windowBounds 分开记忆）
  videoWindowed: false, // 视频播放形态：true=窗口模式（可拖动/缩放），false=全屏投放
  imageAutoPlay: false, // 图片投放：自动轮播（下一张自动接上）
  imageAutoSeconds: 5,  // 自动轮播每张停留秒数
  compatMode: false, // 兼容模式：禁用 GPU 硬件加速（老旧一体机花屏/文字乱码时开启，重启生效）
  autoLaunch: false, // 开机自启（GAP-02：教室一体机开机即进课堂，无需手动双击）
  castAutoTrustCert: true, // 投屏自签证书自动装入 Windows 当前用户根证书存储（SEC-03：默认开保持免提示；可在设置中关闭）
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
  // 快捷键方案迁移：版本不符就整体升级为当前默认（V7：Win 音量键改裸 F4/F5/F6；V6/V7 为旧方案）
  const wantVer = 7;
  if (cfg.hotkeysVer !== wantVer || !cfg.hotkeys || !cfg.hotkeys.mute) {
    cfg.hotkeys = structuredClone(IS_MAC ? HOTKEYS_MAC : HOTKEYS_WIN);
    cfg.hotkeysVer = wantVer;
  }
  // 分类显示数量迁移：旧版默认「全部(0)」，播放器布局起改为默认 3 个（只迁移一次，之后用户可随意调）
  if (!cfg.catShowMigrated) {
    cfg.catShowMigrated = true;
    cfg.catShowLimit = 3;
    save({});
  }
  return cfg;
}

function get() {
  return cfg || load();
}

function save(patch) {
  const next = deepMerge(get(), patch);
  const json = JSON.stringify(next, null, 2);
  cfg = next;
  // PERF-06：内容没变就跳过写盘（拖动窗口/音量等高频 save 不再反复落盘；磁盘写入远贵于一次读比较）
  try {
    if (fs.readFileSync(configPath(), 'utf8') === json) return cfg;
  } catch { }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  // 写盘必须兜底：磁盘满 / userData 只读 / 杀软锁文件时，异常会顺着 IPC reject 出去，
  // 窗口位置/音量/热键会**静默全丢**且用户毫无提示。
  // 注意不能把错误塞进返回值（会被下次 save 写进配置文件），改为记录 + 回调通知主进程弹提示。
  try {
    fs.writeFileSync(configPath(), json, 'utf8');
    lastSaveError = '';
  } catch (e) {
    lastSaveError = String((e && e.message) || e);
    console.error('[config] 写盘失败，本次设置未能保存：', lastSaveError);
    try { if (typeof saveErrorCb === 'function') saveErrorCb(lastSaveError); } catch { }
  }
  return cfg;
}

let lastSaveError = '';  // 最近一次写盘失败原因（供 UI 提示/排查）
let saveErrorCb = null;  // 主进程注入的失败通知（一般接 toast）

/** 注册写盘失败回调：设置没存上必须让用户看见，否则等于静默丢配置 */
function onSaveError(cb) { saveErrorCb = typeof cb === 'function' ? cb : null; }
function lastError() { return lastSaveError; }

module.exports = { get, save, load, onSaveError, lastError };
