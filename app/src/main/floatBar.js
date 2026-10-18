/* PPT 放映悬浮控制条：无边框、半透明、不抢焦点、鼠标靠近右下角浮现。
 * 收起态是右下角一个半透明小圆点；光标靠近角落展开为按钮条，移开自动收起。
 * 仅在单屏放映时使用（双屏时教师屏有完整面板）。 */
const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

let win = null;
let pollTimer = null;
let onAction = null;

const BAR = { w: 236, h: 64 };   // 展开态尺寸
const DOT = { w: 34, h: 34 };    // 收起态尺寸（小圆点区域）
const NEAR = 150;                // 光标距右下角多少像素内展开
const HIDE_DELAY = 900;          // 移开后收起延迟
let open_ = false;               // 当前展开态
let hideAt = 0;

function create() {
  const d = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: d.bounds.x + d.bounds.width - DOT.w,
    y: d.bounds.y + d.height - DOT.h,
    width: DOT.w, height: DOT.h,
    frame: false,                 // 无边框
    transparent: true,            // 透明背景
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,             // 永不抢焦点：放映窗口的 Esc/方向键不受影响
    show: false,
    title: 'PPT 控制条',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'floatbarBridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // 压过全屏放映窗口
  win.loadFile(path.join(__dirname, '..', 'renderer', 'floatbar.html'));
  win.webContents.on('did-finish-load', () => { if (!win || win.isDestroyed()) return; win.showInactive(); }); // 不抢焦点
  win.on('closed', () => { win = null; });
  // 窗口隐藏时停掉轮询（无窗口可检测，空转浪费 CPU）
  win.on('hide', () => stopPoll());
  win.on('show', () => { if (!pollTimer) startPoll(); });
}

// 展开/收起：改窗口尺寸并通知页面切换 UI 态
function setOpen(open) {
  if (!win || win.isDestroyed() || open === open_) return;
  open_ = open;
  const d = screen.getPrimaryDisplay();
  const sz = open ? BAR : DOT;
  win.setBounds({ x: d.bounds.x + d.bounds.width - sz.w, y: d.bounds.y + d.bounds.height - sz.h, width: sz.w, height: sz.h });
  win.webContents.send('floatbar:open', open);
  // 页面侧通过 body.open class 切换；用 executeJavaScript 免 IPC 往返
  win.webContents.executeJavaScript(`document.body.classList.toggle('open', ${open})`).catch(() => { });
  // 展开时立刻重置隐藏计时，避免展开后立刻又收起
  if (open) hideAt = Date.now() + HIDE_DELAY;
}

// 光标轮询：靠近右下角展开，离开按钮区一段时间后收起。
// 低频 500ms（原 300ms）：getCursorScreenPoint 在 Win32 上是阻塞调用，
// 高频轮询会让老机器在 PPT 全屏放映期间持续掉帧。
function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const d = screen.getPrimaryDisplay();
    const c = screen.getCursorScreenPoint();
    const nearCorner = c.x >= d.bounds.x + d.bounds.width - NEAR && c.y >= d.bounds.y + d.bounds.height - NEAR;
    const b = win.getBounds();
    const onBar = c.x >= b.x - 6 && c.x <= b.x + b.width + 6 && c.y >= b.y - 6 && c.y <= b.y + b.height + 6;
    if (nearCorner || onBar) {
      hideAt = Date.now() + HIDE_DELAY;
      setOpen(true);
    } else if (open_ && Date.now() > hideAt) {
      setOpen(false);
    }
  }, 500);
  if (pollTimer.unref) pollTimer.unref(); // 不拖住进程退出
}
function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

function open(actions) {
  onAction = actions || onAction;
  if (!win || win.isDestroyed()) create();
  else { win.showInactive(); }
  open_ = false;
  // 先确保旧轮询已停，避免叠加
  stopPoll();
  startPoll();
}

function close() {
  stopPoll();
  if (win && !win.isDestroyed()) { const w = win; win = null; w.destroy(); }
  win = null;
  open_ = false;
}

function isOpen() { return !!win; }

function init(actionHandler) {
  onAction = actionHandler;
  // 悬浮条音乐按钮 → 转发主面板播放/暂停
  ipcMain.handle('floatbar:music', () => {
    if (onAction) onAction('playPause');
    return { ok: true };
  });
}

module.exports = { open, close, isOpen, init };
