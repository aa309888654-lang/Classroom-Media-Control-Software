const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { projectionDisplay } = require('./displays');

let win = null;
let currentFile = '';
let inlineMode = false;
let windowed = false;          // 当前窗口是否处于「窗口模式」（非全屏）
let winBounds = null;          // 窗口模式的位置尺寸（切回全屏时保存、再切回时还原）
let onEnded = null;

// 外部窗口播放（模式一：控制台模式 → 投到副屏）
function play(file, opts = {}) {
  stop(true);
  inlineMode = false;
  const display = projectionDisplay();
  windowed = !!opts.windowed;
  winBounds = null;
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
    title: '小天AIGC · 视频投放',
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
    win.webContents.send('video:load', { file, windowed });
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

function control(cmd) {
  if (win) win.webContents.send('video:control', cmd);
}

function stop(silent = false) {
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
  return { playing: !!win || inlineMode, file: currentFile, windowed };
}

function init(onVideoEnded) {
  onEnded = onVideoEnded;
  ipcMain.handle('video:notifyEnded', () => {
    const w = win;
    win = null;
    currentFile = '';
    inlineMode = false;
    windowed = false;
    if (w) { try { w.destroy(); } catch { } }
    if (onEnded) onEnded();
    return { ok: true };
  });
}

module.exports = { play, playInline, control, stop, isPlaying, current, init, toggleWindowMode };
