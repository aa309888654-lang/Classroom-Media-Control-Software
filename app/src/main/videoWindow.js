const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { projectionDisplay } = require('./displays');
const library = require('./library');

let win = null;
let currentFile = '';
let inlineMode = false;
let windowed = false;          // 当前窗口是否处于「窗口模式」（非全屏）
let winBounds = null;          // 窗口模式的位置尺寸（切回全屏时保存、再切回时还原）
let onEnded = null;
let onProgress = null; // 播放窗把进度回报给主进程，由主进程转给控制面板显示
// 图片投放（视频板块同时收图片）：整屏显示 + 左右翻图 + 自动轮播
let mediaKind = 'video';
let imageList = [];      // 当前可翻的整套图片（视频库里的图片，顺序与库里一致）
let imageIndex = -1;     // 当前显示第几张
let autoPlay = false;    // 自动轮播
let autoSeconds = 5;     // 每张停留秒数
let onChanged = null;    // 图片翻页/轮播状态变化 → 主进程转给面板

// 外部窗口播放（模式一：控制台模式 → 投到副屏）
// opts: { windowed, images:[...], auto, seconds }
function play(file, opts = {}) {
  stop(true);
  inlineMode = false;
  // 目标屏：智能识别/用户指定的那块（非内置屏优先，见 displays.js）
  const display = projectionDisplay();
  windowed = !!opts.windowed;
  winBounds = null;
  mediaKind = library.isImgExt(path.extname(file)) ? 'img' : 'video';
  imageList = mediaKind === 'img' && Array.isArray(opts.images) && opts.images.length ? opts.images.slice() : [];
  imageIndex = imageList.length ? Math.max(0, imageList.indexOf(file)) : -1;
  autoPlay = mediaKind === 'img' && !!opts.auto;
  autoSeconds = Math.max(1, Number(opts.seconds) || 5);
  const winsizeFor = () => {
    const w = Math.min(1280, display.bounds.width - 40);
    const h = Math.round((w * 9) / 16);
    return { w, h };
  };
  const ws = winsizeFor();
  win = new BrowserWindow({
    x: windowed ? display.bounds.x + Math.round((display.bounds.width - ws.w) / 2) : display.bounds.x,
    y: windowed ? display.bounds.y + Math.round((display.bounds.height - ws.h) / 2) : display.bounds.y,
    width: windowed ? ws.w : display.bounds.width,
    height: windowed ? ws.h : display.bounds.height,
    fullscreen: !windowed,
    frame: windowed, // 窗口模式带标题栏可拖动/最大化；全屏模式无边框
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    title: mediaKind === 'img' ? '小天AIGC · 图片投放' : '小天AIGC · 视频投放',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'playerBridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 播放窗口禁止后台节流（失焦时照样流畅渲染/播放）
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'), { query: { file } });
  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return; // GAP-05：加载完成前窗口可能已被关闭
    win.webContents.send('video:load', loadPayload());
    // show()+focus()：窗口必须拿焦点，Esc 才能进页面（showInactive 会导致键盘事件丢失）
    win.show();
    win.focus();
  });
  // Esc 主进程兜底：页面脚本异常也能停播
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') stop();
  });
  win.on('closed', () => {
    const had = !!win;
    win = null;
    currentFile = '';
    if (had && onEnded) onEnded();
  });
  currentFile = file;
  return { ok: true, windowed };
}

// 全屏 ⇄ 窗口模式互切（面板遥控条 / 播放窗口进度条的 ⛶ 按钮）
function toggleWindowMode() {
  if (!win || win.isDestroyed()) return { ok: false };
  const toWindow = !windowed; // 当前全屏 → 切窗口；当前窗口 → 切全屏
  if (toWindow) {
    winBounds = win.getBounds(); // 记全屏边界，切回时还原
    const d = projectionDisplay();
    const w = Math.min(1280, d.bounds.width - 40);
    const h = Math.round((w * 9) / 16);
    win.setFullScreen(false);
    win.setBounds({
      x: d.bounds.x + Math.round((d.bounds.width - w) / 2),
      y: d.bounds.y + Math.round((d.bounds.height - h) / 2),
      width: w, height: h,
    });
    windowed = true;
  } else {
    win.setFullScreen(true);
    windowed = false;
  }
  win.webContents.send('video:windowmode', { windowed: windowed });
  return { ok: true, windowed };
}

// 内联播放（模式二：LED 投屏模式 → 主窗口内联播放）
function playInline(file) {
  stop(true);
  inlineMode = true;
  currentFile = file;
  return { ok: true, inline: true };
}

// 图片翻页（左右翻图 + 自动轮播共用）：到头回到另一头，循环翻
function pageImage(delta) {
  if (!win || win.isDestroyed() || mediaKind !== 'img' || !imageList.length) return { ok: false };
  const n = imageList.length;
  imageIndex = ((imageIndex < 0 ? 0 : imageIndex + delta) % n + n) % n;
  currentFile = imageList[imageIndex];
  win.webContents.send('video:load', loadPayload());
  if (onChanged) onChanged(current());
  return { ok: true, index: imageIndex, count: n };
}

// 自动轮播开关：面板按钮/快捷键都能切，状态回传给面板
function toggleAuto(force) {
  if (mediaKind !== 'img' || !imageList.length) return { ok: false, auto: false };
  autoPlay = typeof force === 'boolean' ? force : !autoPlay;
  if (win && !win.isDestroyed()) win.webContents.send('video:auto', { auto: autoPlay, seconds: autoSeconds });
  if (onChanged) onChanged(current());
  return { ok: true, auto: autoPlay, seconds: autoSeconds };
}

function loadPayload() {
  return {
    file: currentFile,
    windowed,
    kind: mediaKind,
    index: imageIndex,
    count: imageList.length,
    auto: autoPlay,
    seconds: autoSeconds,
  };
}

function control(cmd) {
  if (!win || win.isDestroyed()) return { ok: false };
  if (cmd === 'next' || cmd === 'prev') return pageImage(cmd === 'next' ? 1 : -1);
  if (cmd === 'auto') return toggleAuto();
  win.webContents.send('video:control', cmd);
  return { ok: true };
}

// 控制面板进度条拖动跳转：面板 invoke('video:seek', { t }) → 这里转给播放窗
// （内联模式没有播放窗，LED 模式的面板自己就是播放器，由渲染进程本地处理，不走这里）
let lastProgress = { t: 0, d: 0, p: 0 }; // 播放窗最近一次回报的进度（seek 时用来夹取上界）
function seek(t) {
  if (!win || win.isDestroyed()) return { ok: false };
  const d = lastProgress.d || 0;
  const sec = Math.max(0, Math.min(d || Number.MAX_SAFE_INTEGER, Number(t) || 0));
  win.webContents.send('video:seek', sec);
  return { ok: true, t: sec };
}

function stop(silent = false) {
  lastProgress = { t: 0, d: 0, p: 0 }; // 换片/停播后旧进度作废（否则 seek 会被上一部的时长夹住）
  mediaKind = 'video';
  imageList = [];
  imageIndex = -1;
  autoPlay = false;
  if (win) {
    const w = win;
    win = null;
    currentFile = '';
    inlineMode = false;
    try { w.destroy(); } catch { }
    if (!silent && onEnded) onEnded();
    return;
  }
  const had = !!currentFile;
  currentFile = '';
  inlineMode = false;
  if (!silent && had && onEnded) onEnded();
}

function isPlaying() {
  return !!win || inlineMode;
}

function current() {
  return {
    playing: !!win || inlineMode,
    file: currentFile,
    windowed,
    kind: mediaKind,
    index: imageIndex,
    count: imageList.length,
    auto: autoPlay,
    seconds: autoSeconds,
  };
}

function init(onVideoEnded, onVideoProgress, onMediaChanged) {
  onEnded = onVideoEnded;
  onProgress = onVideoProgress;
  onChanged = onMediaChanged;
  // 播放窗 500ms 一次的进度回报 → 主进程 → 控制面板进度条
  ipcMain.handle('video:progress', (_e, p) => {
    if (!win || win.isDestroyed()) return { ok: false }; // 窗口已关（结束/退出）的尾包直接丢
    lastProgress = {
      t: Math.max(0, Number(p && p.t) || 0),
      d: Math.max(0, Number(p && p.d) || 0),
      p: Number(p && p.p) || 0,
    };
    if (onProgress) onProgress(lastProgress);
    return { ok: true };
  });
  ipcMain.handle('video:notifyEnded', () => {
    const w = win;
    win = null;
    currentFile = '';
    inlineMode = false;
    windowed = false;
    lastProgress = { t: 0, d: 0, p: 0 };
    mediaKind = 'video';
    imageList = [];
    imageIndex = -1;
    autoPlay = false;
    if (w) { try { w.destroy(); } catch { } }
    if (onEnded) onEnded();
    return { ok: true };
  });
  // 播放窗里的翻图/轮播由页面自报（自动轮播到头、用户按了 ←/→），主进程据此同步面板显示
  ipcMain.handle('video:imageChanged', (_e, p) => {
    if (!win || win.isDestroyed() || mediaKind !== 'img') return { ok: false };
    if (Number.isInteger(p && p.index) && imageList[p.index]) {
      imageIndex = p.index;
      currentFile = imageList[p.index];
    }
    if (typeof (p && p.auto) === 'boolean') autoPlay = p.auto;
    if (onChanged) onChanged(current());
    return { ok: true };
  });
}

module.exports = { play, playInline, control, stop, isPlaying, current, init, toggleWindowMode, seek, pageImage, toggleAuto };
