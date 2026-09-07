const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { projectionDisplay } = require('./displays');

let win = null;
let currentFile = '';
let inlineMode = false;
let onEnded = null;

// 外部窗口播放（模式一：控制台模式 → 投到副屏）
function play(file) {
  stop(true);
  inlineMode = false;
  const display = projectionDisplay();
  win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    title: '小天AIGC · 视频投放',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'), { query: { file } });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('video:load', { file });
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
  return { ok: true };
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
  return { playing: !!win || inlineMode, file: currentFile };
}

function init(onVideoEnded) {
  onEnded = onVideoEnded;
  ipcMain.handle('video:notifyEnded', () => {
    const w = win;
    win = null;
    currentFile = '';
    inlineMode = false;
    if (w) { try { w.destroy(); } catch { } }
    if (onEnded) onEnded();
    return { ok: true };
  });
}

module.exports = { play, playInline, control, stop, isPlaying, current, init };
