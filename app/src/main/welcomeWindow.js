/* 欢迎屏窗口：绿色接收窗口，全屏落在投影屏；复用面板 IPC 参数驱动 */
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { projectionDisplay } = require('./displays');

let win = null;
let params = null;

function open(p) {
  close();
  params = p;
  const d = projectionDisplay();
  win = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000',
    show: false,
    title: '欢迎屏',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'welcomeBridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 欢迎屏常亮展示，禁止后台节流
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'), {
    query: { text: p.text, sub: p.sub || '', bg: String(p.bg), style: String(p.style), font: String(p.font || 1), lpos: p.logoPos || 'tl', logo: p.logoPath || '', bgpath: p.bgpath },
  });
  win.webContents.on('did-finish-load', () => { if (!win || win.isDestroyed()) return; win.show(); win.focus(); });
  win.on('closed', () => { win = null; });
  return { ok: true };
}

function close() {
  if (win) {
    const w = win;
    win = null;
    try { w.destroy(); } catch { }
  }
}

function isOpen() { return !!win; }

function init(onClosed) {
  ipcMain.handle('welcome:winClose', () => {
    close();
    if (onClosed) onClosed();
    return { ok: true };
  });
}

module.exports = { open, close, isOpen, init };
