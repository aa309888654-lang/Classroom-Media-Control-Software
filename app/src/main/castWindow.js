/* 无线同屏·接收窗口（控制台模式：全屏落在投影屏；LED 模式不需要本窗口，改内联） */
const path = require('path');
const { BrowserWindow, ipcMain, globalShortcut } = require('electron');
const { projectionDisplay } = require('./displays');

let win = null;
let onClosedCb = null;
let escHooked = false;

// 用户主动退出（ESC/✕）：关窗 + 通知上层收尾；面板停止同屏走的 close() 不触发回调
function closeByUser() {
  close();
  if (onClosedCb) onClosedCb();
}

// 投屏期间全局接管 ESC：全屏窗口没拿到键盘焦点时（焦点留在主面板/其他窗口），
// 页面 keydown 与 before-input-event 都收不到键——这正是「ESC 无效」的根因。
// 同屏本身就是独占体验，全局 ESC 的语义就是「退出投屏」；关窗立即注销。
function hookEscape() {
  if (escHooked) return;
  try { escHooked = globalShortcut.register('Escape', () => closeByUser()); } catch { escHooked = false; }
}
function unhookEscape() {
  if (!escHooked) return;
  try { globalShortcut.unregister('Escape'); } catch { }
  escHooked = false;
}

function open(port, token) {
  close();
  const d = projectionDisplay();
  win = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    title: '小天AIGC · 无线同屏',
    webPreferences: {
      // 专用窄桥：只暴露关窗动作（preload 在 sandbox 下可用）
      preload: path.join(__dirname, '..', 'preload', 'castBridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 同屏画面实时渲染，禁止后台节流
    },
  });
  win.setMenuBarVisibility(false);
  // token 放进 query：接收端是 file:// 页面，拿不到 Cookie，只能用 X-Token / URL 签名访问信令与媒体
  win.loadFile(path.join(__dirname, '..', 'renderer', 'caster.html'), {
    query: { port: String(port), token: String(token || '') },
  });
  // show()+focus()：窗口必须拿焦点，ESC/键盘事件才进得来（showInactive 会导致快捷键全失灵）
  win.webContents.on('did-finish-load', () => {
    // 窗口可能在加载完成前就被关闭/销毁（GAP-05）
    if (!win || win.isDestroyed()) return;
    win.show(); win.focus();
  });
  // ESC 第二层：页面脚本异常时主进程兜底（第一层是页面 keydown，第三层是全局接管）
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') closeByUser();
  });
  hookEscape();
  win.on('closed', () => { unhookEscape(); win = null; });
  return { ok: true };
}

function close() {
  unhookEscape();
  if (win) {
    const w = win;
    win = null;
    try { w.destroy(); } catch { }
  }
}

function isOpen() { return !!win; }

// 页面 ✕ 按钮的关窗请求；关窗后回调上层做同屏收尾（bye + stop + 广播状态）
function init(onClosed) {
  onClosedCb = onClosed;
  ipcMain.handle('cast:winClose', () => {
    closeByUser();
    return { ok: true };
  });
}

module.exports = { open, close, isOpen, init };
