/* 课堂计时器：倒计时/正计时/秒表，独立窗口投第二显示器
 * 状态在主进程统一计时，250ms 向面板与投影窗口广播 tick */
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { projectionDisplay } = require('./displays');

let win = null;
let broadcast = null;
let loop = null;
const st = { mode: 'countdown', duration: 0, running: false, startTs: 0, pausedAcc: 0, finished: false, started: false };

function elapsed() {
  if (!st.started) return 0;
  return st.running ? Date.now() - st.startTs : st.pausedAcc;
}
function remaining() {
  if (st.mode !== 'countdown') return 0;
  return Math.max(0, st.duration - elapsed());
}
function snapshot() {
  return { ...st, remaining: remaining(), elapsed: elapsed() };
}
function emitTick() {
  const s = snapshot();
  if (broadcast) broadcast('timer:tick', s);
  if (win && !win.isDestroyed()) win.webContents.send('timer:tick', s);
}

function startLoop() {
  clearInterval(loop);
  loop = setInterval(() => {
    if (st.mode === 'countdown' && st.running && elapsed() >= st.duration) {
      st.finished = true;
      st.running = false;
      st.pausedAcc = st.duration;
      clearInterval(loop);
      loop = null;
      emitTick();
      if (broadcast) broadcast('timer:finished', snapshot());
      if (win && !win.isDestroyed()) win.webContents.send('timer:finished', snapshot());
      return;
    }
    emitTick();
  }, 250);
}

function start(mode, durationMs) {
  st.mode = mode;
  st.duration = mode === 'countdown' ? Math.max(1000, durationMs || 0) : 0;
  st.started = true;
  st.running = true;
  st.startTs = Date.now();
  st.pausedAcc = 0;
  st.finished = false;
  showWindow();
  startLoop();
  emitTick();
}

function togglePause() {
  if (!st.started || st.finished) return snapshot();
  if (st.running) {
    st.pausedAcc = Date.now() - st.startTs;
    st.running = false;
    clearInterval(loop); loop = null;
  } else {
    // 恢复时以 pausedAcc 为新的起算基准，否则已流逝时间会被清零
    st.startTs = Date.now() - st.pausedAcc;
    st.running = true;
    startLoop();
  }
  emitTick();
  return snapshot();
}

function reset() {
  clearInterval(loop); loop = null;
  st.started = false; st.running = false; st.finished = false;
  st.duration = 0; st.pausedAcc = 0; st.startTs = 0;
  emitTick();
  return snapshot();
}

/* ---------- 投影窗口：普通窗口（可拖动/缩放），不再强制全屏 ---------- */
function showWindow() {
  if (win && !win.isDestroyed()) { win.showInactive(); return; }
  const d = projectionDisplay();
  const w = Math.round(d.bounds.width * 0.56);
  const h = Math.round(d.bounds.height * 0.56);
  win = new BrowserWindow({
    x: d.bounds.x + Math.round((d.bounds.width - w) / 2),
    y: d.bounds.y + Math.round((d.bounds.height - h) / 2),
    width: w, height: h,
    minWidth: 420, minHeight: 240,
    frame: false, resizable: true, fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#161616', show: false,
    title: '小天AIGC · 计时器',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bridge.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'timer.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('timer:tick', snapshot());
    win.showInactive();
  });
  win.on('closed', () => { win = null; });
}

function toggleShow() {
  if (win && !win.isDestroyed()) { win.close(); return { showing: false }; }
  showWindow();
  return { showing: true };
}

function toggleFullscreen() {
  if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
}

function closeWindow() {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

function current() {
  return snapshot();
}

function init(bc) {
  broadcast = bc;
  // ESC / 左上角 ✕ 的统一退出：全屏时先退出全屏，窗口化时直接关窗
  ipcMain.handle('timer:escExit', () => {
    if (win && !win.isDestroyed()) {
      if (win.isFullScreen()) win.setFullScreen(false);
      else closeWindow();
    }
    return { ok: true };
  });
}

module.exports = { start, togglePause, reset, toggleShow, toggleFullscreen, closeWindow, current, init };
