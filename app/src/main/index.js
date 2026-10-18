const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, screen, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// setAppUserModelId 仅 Windows 有意义（任务栏/通知归属），macOS 无此概念
if (process.platform === 'win32') app.setAppUserModelId('com.xiaotian.aigc');

const IS_MAC = process.platform === 'darwin';

const config = require('./config');
const displays = require('./displays');
const transcode = require('./transcode');
const thumbs = require('./thumbs');

// 兼容模式必须在 app ready 前调用：读配置（同步）后禁用 GPU 硬件加速
// 老旧教室一体机显卡驱动弱，Electron 文字渲染花屏/乱码时开启此项
config.load();
if (config.get().compatMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
}
const officeDetector = require('./officeDetector');
const pptController = require('./pptController');
const pptServer = require('./pptServer');
const library = require('./library');
const hotkeys = require('./hotkeys');
const videoWindow = require('./videoWindow');
const timer = require('./timer');
const castServer = require('./castServer');
const castWindow = require('./castWindow');
const peer = require('./peer');
const peerClient = require('./peerClient');
const floatBar = require('./floatBar');
const brand = require('./brand');
const welcomeWindow = require('./welcomeWindow');
const pptExport = require('./pptExport');
const { getResourcesPath } = require('./paths');

// 主进程兜底（GAP-04）：未捕获异常/未处理拒绝不再让整个课堂进程静默消失，
// 先落到 userData/logs/main-error.log，再打印；避免崩溃时连日志都没有、无从排查。
function logFatal(tag, x) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main-error.log'), `[${new Date().toISOString()}] ${tag}: ${x && x.stack ? x.stack : String(x)}\n`);
  } catch { }
}
process.on('uncaughtException', (err) => { logFatal('uncaughtException', err); console.error('[uncaughtException]', err); });
process.on('unhandledRejection', (reason) => { logFatal('unhandledRejection', reason); console.error('[unhandledRejection]', reason); });

let brandm = null; // 解密后的品牌数据：名称/版本/官网/赞助/hosts；null=未核验通过
let miniDocked = false;              // 迷你面板当前是否贴在右下角（贴着才允许自动隐藏）
let miniCollapsed = false;           // 迷你面板当前是否已收成小把手
let miniBoundsBeforeCollapse = null; // 收起前的迷你窗口 bounds（展开时还原）

// 欢迎屏背景清单：manifest.json 是唯一来源（混合 png/svg，编号对应选择索引）
let welcomeBgsCache = null;
function loadWelcomeBgs() {
  if (welcomeBgsCache) return welcomeBgsCache;
  try {
    const p = path.join(getResourcesPath(), 'welcome-bg', 'manifest.json');
    const list = JSON.parse(fs.readFileSync(p, 'utf8'));
    welcomeBgsCache = (Array.isArray(list) && list.length) ? list : null;
  } catch { welcomeBgsCache = null; }
  return welcomeBgsCache;
}
function welcomeBgFile(idx) {
  const bgs = loadWelcomeBgs() || [];
  return (bgs[idx - 1] && bgs[idx - 1].file) || '01.png';
}

const isSmoke = process.argv.includes('--smoke-test');

let win = null;
let tray = null;
let alwaysOnTop = false;
let quitting = false;
let lastPptFile = '';
let presentSeq = 0; // 放映动作序号：退出投屏可打断进行中的放映
let hotkeyConflicts = [];
let musicMemo = { playing: false, category: '', track: '' };
let lastVideoFile = ''; // 上次起播的视频：遥控端「播放/暂停」在空闲时据此续播（遥控端没有选片列表）

const sm = { mode: 'idle' }; // idle | ppt | video

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(text, type = 'info') {
  broadcast('toast', { text, type });
}

// 配置写盘失败（磁盘满/只读/杀软锁文件）必须让用户看见，否则等于静默丢配置。
// 节流 3s：拖动窗口等高频 save 可能连续失败，只提示一次。
let cfgErrToastAt = 0;
config.onSaveError((msg) => {
  const now = Date.now();
  if (now - cfgErrToastAt < 3000) return;
  cfgErrToastAt = now;
  toast(`设置未能保存（${msg}），请检查磁盘空间或权限`, 'error');
});

// 置顶的「固定」语义：面板浮在放映软件（PPT 全屏等）之上，老师随时够得着控制按钮。
// PPT 全屏窗口出现/重新聚焦时会盖掉普通置顶，这里按需把面板重新压回顶层。
// force=true 跳过节流（放映弹出等关键时刻连发补救）；轮询 tick 走节流：
// moveTop 是强制 z-order 操作，翻页期 400ms/次纯属白干还占 CPU（PERF-12）
let lastOnTopAt = 0;
function assertAlwaysOnTop(force = false) {
  if (!win || win.isDestroyed() || !alwaysOnTop) return;
  const now = Date.now();
  if (!force && now - lastOnTopAt < 2000) return;
  lastOnTopAt = now;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'win32') win.moveTop();
  } catch { }
}

// 放映期间自动置顶：PPT 一开始放映，全屏放映窗/PPT 主窗口就会盖住面板；
// 双屏「扩展模式」下更明显——放映落在副屏，可 PowerPoint 主窗口仍可能压在教师屏的面板上，
// 老师就没法点退出/翻页了。默认在「开始放映」时自动打开置顶，「结束放映」后还原成用户原来的手动状态，
// 不会留下「莫名其妙一直置顶」。设置里 display.autoTopOnPresent 可关。
let autoTopApplied = false; // 置顶是否由「放映自动置顶」临时打开（待还原）
function applyAutoTopOnPresent(on) {
  const disp = config.get().display || {};
  if (disp.autoTopOnPresent === false) return; // 用户关掉了这项
  if (on) {
    if (alwaysOnTop) return; // 用户本来就开着置顶，别当成临时状态，退出时也别去动它
    autoTopApplied = true;
    alwaysOnTop = true;
  } else {
    if (!autoTopApplied) return; // 不是我们临时开的（或用户中途自己动过），不动
    autoTopApplied = false;
    alwaysOnTop = false;
  }
  if (win && !win.isDestroyed()) {
    try {
      win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
      if (alwaysOnTop) assertAlwaysOnTop();
    } catch { }
  }
  broadcast('window:alwaysOnTop', { alwaysOnTop, auto: autoTopApplied }); // 面板置顶按钮同步点亮/熄灭
}

// 同屏彻底收场的**唯一出口**。
// 历史上这里有三条各自为政的清理路径（面板停止 / ESC 关窗 / 拔掉投影线），每条都漏了不同的一步：
//   · ESC 关窗漏了 peer.stopBeacon() → UDP 信标每 2s 继续广播主机名，本机永久出现在别人设备列表里；
//   · 拔投影线漏了 castServer.stop()  → HTTP 服务继续对外，发送端仍能上传，queues.receiver 持续堆积。
// 现在统一走这里，保证 bye/stop/关窗/撤信标/状态广播五步一个不少。
async function teardownCast() {
  try { castServer.bye(); } catch { }    // 通知发送端释放共享
  castWindow.close();                    // 注意：close() 不触发 onClosedCb，不会递归回来
  await castServer.stop();               // 关 HTTP/HTTPS + closeAllConnections + 作废 token
  peer.stopBeacon();                     // 同屏停了，遥控 API 也停了，信标同步撤下
  broadcast('cast:state', { running: false });
}

// 停止无线同屏（放映 PPT 等独占投影屏的动作统一走这里清场）
async function stopCast() {
  await teardownCast();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: brandm ? `${brandm.name} · 课堂中控` : '课堂中控',
    backgroundColor: '#161616',
    autoHideMenuBar: true,
    show: false,
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // 外链一律走全系统浏览器校验通道，禁止渲染进程自行弹新窗口
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 窗口位置尺寸记忆（对标 VS Code：重启还原上次布局）
  const saved = config.get().windowBounds;
  if (saved && isBoundsVisible(saved)) win.setBounds(saved);
  // LED 模式：启动直接全屏
  if (config.get().displayMode === 'led') {
    win.setFullScreen(true);
  }
  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isMaximized() && !win.isMinimized()) {
        // 迷你模式的位置尺寸存 miniBounds，与正常 windowBounds 分开；收起成把手时不存
        if (config.get().miniMode) {
          if (!miniCollapsed) config.save({ miniBounds: win.getBounds() });
        } else {
          config.save({ windowBounds: win.getBounds() });
        }
      }
    }, 600);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  // 迷你面板拖到右下角附近即吸附到角落，并标记为「已停靠」（自动隐藏的判定条件）
  win.on('moved', () => {
    if (!config.get().miniMode || miniCollapsed) return;
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b).workArea;
    const gapR = Math.abs((b.x + b.width) - (d.x + d.width));
    const gapB = Math.abs((b.y + b.height) - (d.y + d.height));
    miniDocked = gapR < 100 && gapB < 100;
    if (miniDocked) {
      win.setBounds({ x: d.x + d.width - b.width - 12, y: d.y + d.height - b.height - 12, width: b.width, height: b.height });
    }
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide(); // 托盘常驻，音乐不中断
    }
  });
}

function resolveIcon() {
  // 打包态 resources 在 asar 外（process.resourcesPath/resources），必须经 getResourcesPath 定位，
  // 直接拼 __dirname 相对路径在打包后取不到 → 托盘会创建成空图标（右下角不显示）
  const p = path.join(getResourcesPath(), 'icon.png');
  try { return nativeImage.createFromPath(p); } catch { return undefined; }
}

// 窗口中心点落在某块显示器工作区内才算可见（防止拔掉投影后窗口恢复不到屏外）
function isBoundsVisible(b) {
  if (!b || typeof b.x !== 'number') return false;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return screen.getAllDisplays().some((d) =>
    cx >= d.workArea.x && cx < d.workArea.x + d.workArea.width &&
    cy >= d.workArea.y && cy < d.workArea.y + d.workArea.height
  );
}

function createTray() {
  // 托盘图标必须用裁了边的小图——870×870 白底大图缩到 16px 会糊成纯白块
  let icon;
  try {
    const p = path.join(getResourcesPath(), 'icon-tray.png');
    const nimg = nativeImage.createFromPath(p);
    icon = nimg.isEmpty() ? resolveIcon() : (nimg.resize({ width: 20, height: 20 }) || nimg);
  } catch {
    icon = resolveIcon();
  }
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(`${(brandm && brandm.name) || '课堂中控'} · 课堂中控`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主面板', click: () => showMain() },
    { type: 'separator' },
    { label: '播放/暂停音乐', click: () => forwardHotkey('playPause') },
    { label: '放映当前课件', click: () => presentPpt(lastPptFile) },
    { label: '退出投屏', click: () => exitPresent() },
    { type: 'separator' },
    { label: '退出程序', click: () => quitApp() },
  ]));
  tray.on('click', () => showMain());
}

function showMain() {
  if (!win) return;
  win.show();
  win.focus();
}

async function quitApp() {
  quitting = true;
  // 退出即清场：视频、计时窗口、PPT 放映全部同时收掉（音乐随窗口销毁自动停止）
  try { welcomeWindow.close(); } catch { }
  try { floatBar.close(); } catch { }
  try { videoWindow.stop(true); } catch { }
  try { timer.closeWindow(); } catch { }
  // 无线同屏：通知发送端离开 + 关接收窗口 + 停信令服务
  try { castServer.bye(); } catch { }
  try { castWindow.close(); } catch { }
  try { castServer.stop(); } catch { }
  try {
    if (pptController.getState().presenting) {
      // 是否连同关闭 PowerPoint/WPS 程序，沿用「退出放映时」设置（默认开）
      await pptController.exitPresent(config.get().exitAction.closePowerpoint);
    }
  } catch { }
  // 预打开（放映预热）期间由我们拉起的 PowerPoint 统一关闭，不留后台进程
  try { await pptController.runCtl('shutdown', {}, 4000, 'ctl'); } catch { }
  try { pptServer.close(); } catch { } // 收掉常驻 PowerShell 与在途请求（BUG-14）
  // ffmpeg 子进程：转码/抽帧途中退出程序时若不杀，ffmpeg 会变孤儿继续占 CPU 写盘（大文件可达 10 分钟）
  try { transcode.killAll(); } catch { }
  try { thumbs.killAll(); } catch { }
  app.quit();
}

// ---------- 业务动作 ----------

// 放映失败错误码 → 用户可读提示（Mac 没有 WPS COM 与 PowerShell，文案分平台）
const PPT_ERRORS = IS_MAC ? {
  'no-office-com': '未检测到 Microsoft PowerPoint（Mac 版仅支持 PowerPoint）',
  'file-not-found': '找不到课件文件（U 盘拔了？）',
  'timeout': '操作超时，请重试',
  'com-error': '课件可能有密码或已损坏；若首次放映请先在系统弹窗中允许「自动化」权限',
  'parse-error': 'AppleScript 输出异常，请重试',
  'spawn-failed': '无法启动 osascript（系统组件缺失？）',
} : {
  'no-office-com': '未检测到 PowerPoint/WPS',
  'file-not-found': '找不到课件文件（U 盘拔了？）',
  'timeout': '操作超时，请重试',
  'com-error': '课件可能有保护视图/密码，请手动打开并「启用编辑」后重试',
  'parse-error': 'PowerShell 输出异常，请重试',
  'spawn-failed': '无法启动 PowerShell（被杀毒软件拦截？）',
};

// ---------- 演讲者缩略图（5 页胶片） ----------
// 导出缓存目录逻辑已抽到 ./pptExport（GAP-09）：路径哈希键控防串图（BUG-03）+ 14 天 TTL（GAP-10）
// 过期缓存清扫改为异步 + 延后到窗口起来之后（原本是同步 readdirSync/rmSync/statSync，
// 在模块顶层（app ready 之前）执行会让开机黑屏 1~3s，老机更久）。
setTimeout(() => {
  Promise.allSettled([pptExport.sweep(), transcode.sweepMediaCache()]);
  // 顺带把投屏证书预生成好：keygen 是同步重活，放在用户点「无线同屏」那一刻会像假死
  try { castServer.warmCert(); } catch { }
}, 2000);
const pptExportDir = pptExport.exportDir;
let pptLastPos = 0;
let pptLastTotal = 0;
let pptLastBroadcast = ''; // 最近一次 ppt:presenter 广播内容签名：内容没变不广播，面板不重复重绘
let presenterBusy = false; // presenter 调用防重入（导图慢时跳过本轮，下轮再补）
let pptLastFlipAt = 0;     // 最近一次翻页/跳页/开播时间：翻页进行中不给导图任务（保 PowerPoint 主线程，PERF-12）
const PPT_EXPORT_CALM_MS = 600; // 翻页静默期：距上次翻页超过它才允许现场导图

function noteFlip() { pptLastFlipAt = Date.now(); }

function broadcastPresenterIfChanged(full) {
  pptLastTotal = full.total || pptLastTotal;
  const sig = JSON.stringify([
    full.position, full.total, full.notes, full.nextNotes,
    (full.pages || []).map((p) => `${p.page}:${p.img}`),
  ]);
  if (sig === pptLastBroadcast) return;
  pptLastBroadcast = sig;
  broadcast('ppt:presenter', full);
}

// 老师手动关了放映/PowerPoint：复位面板状态（与旧 5s 状态轮询行为一致）
async function handleShowGone() {
  await pptController.syncStatus(); // 让主进程状态与 COM 实际一致（presenting=false）
  pptLastPos = 0;
  pptLastBroadcast = '';
  sm.mode = 'idle';
  floatBar.close(); // 老师手动退了放映：悬浮条一并收掉
  applyAutoTopOnPresent(false); // 同上：自动置顶也要还原
  broadcast('ppt:state', { presenting: false, file: '', loading: false });
  releaseDeferredThumbs(); // 同上：手动退出也要放行延后的缩略图
}

// 演讲者信息统一轮询（thumb 通道）：一次调用拿页码/备注/缩略图，导图不再与翻页命令同通道排队。
// 翻页/跳页/开播后会立即直调一次（页码先由翻页结果即时广播，胶片由此跟上）
async function pollPresenter() {
  if (presenterBusy || !pptController.getState().presenting) return;
  presenterBusy = true;
  try {
    // 静默期才导图：翻页瞬间/轮询密集期 presenter 只读已缓存页，Export 不和幻灯片渲染抢主线程（PERF-12）
    // 遥控器/键盘翻页不经过本进程，由轮询检测到页码变化时补记 noteFlip（见 presenterPoll）
    const calm = Date.now() - pptLastFlipAt >= PPT_EXPORT_CALM_MS;
    const full = await pptController.presenterInfo(pptExportDir(pptController.getState().file), { noexport: !calm });
    if (full.ok && full.presenting) {
      pptLastPos = full.position;
      broadcastPresenterIfChanged(full);
      return full;
    }
    // presenter 说已不在放映（或通路异常再用 status 复核）→ 按手动退出处理
    // 严格判 false：通路故障时 status 拿不到字段，不能误当「放映已结束」把面板复位
    const s = full.ok ? { presenting: false } : await pptController.syncStatus();
    if (s.presenting === false) await handleShowGone();
  } catch { } finally {
    presenterBusy = false;
  }
}

async function presentPpt(file) {
  if (!file) {
    toast('请先选择要放映的课件', 'warn');
    return { ok: false, error: 'no-file' };
  }
  // 幂等防护：全局快捷键/托盘入口在放映中也能触发，重复放映会报错或重复开档。
  // 以真实 COM 状态为准（老师可能刚手动退出、轮询尚未同步）：
  // 同一课件 → 直接返回成功（无副作用）；不同课件 → 先退当前再映新的
  if (pptController.getState().presenting) {
    const real = await pptController.syncStatus();
    if (real.presenting) {
      const same = real.file && path.normalize(real.file).toLowerCase() === path.normalize(file).toLowerCase();
      if (same) {
        toast('该课件正在放映中', 'info');
        return { ok: true, mode: 'already', state: pptController.getState() };
      }
      await exitPresent();
    }
  }
  if (videoWindow.isPlaying()) videoWindow.stop(true);
  // 非 PPT 文档（PDF/Word/Excel/图片…）：用系统默认程序打开投屏，不走 COM（无翻页/胶片/备注集成控制）
  const ext = path.extname(file).toLowerCase();
  if (!library.isPptExt(ext)) {
    if (welcomeWindow.isOpen()) { welcomeWindow.close(); broadcast('welcome:state', { open: false }); }
    if (castServer.running()) await stopCast();
    const { shell } = require('electron');
    const opened = shell.openPath(file);
    if (opened) {
      toast(`已用默认程序打开「${path.basename(file)}」：翻页/退出请在该程序里操作（PPT 才有集成控制）`, 'info');
      return { ok: true, mode: 'document', state: pptController.getState() };
    }
    toast(`打不开「${path.basename(file)}」：系统未关联可打开它的程序`, 'error');
    return { ok: false, error: 'open-failed' };
  }
  // 投影屏是独占的：放映 PPT 前收掉欢迎屏与无线同屏。
  // 同屏窗在放映期间挂的全局 Esc 钩子也随之释放，避免和 PPT 全屏的 Esc 退出冲突
  if (welcomeWindow.isOpen()) { welcomeWindow.close(); broadcast('welcome:state', { open: false }); }
  if (castServer.running()) await stopCast();
  // 切扩展模式是 Windows 专属能力（DisplaySwitch）；macOS 外接默认即扩展，LED 单屏模式下也无意义。
  // 已是双屏则跳过；切换失败（投影线/HDMI 未被识别）给出明确提示，仍继续放映
  const hasMultiDisplay = displays.listDisplays().length > 1;
  if (!IS_MAC && hasMultiDisplay && config.get().display.forceExtendOnPresent && config.get().displayMode !== 'led') {
    try {
      const ext = await displays.extendMode();
      if (!ext.ok) {
        toast(ext.error === 'no-displayswitch'
          ? '系统缺少 DisplaySwitch，无法自动切扩展模式'
          : '未能识别到第二块屏（投影）：请检查投影线/HDMI 输入源，将以当前屏幕放映', 'warn');
      }
    } catch { }
  }
  broadcast('ppt:state', { presenting: true, file, loading: true });
  // 放映 PPT 不打断音乐：开课音乐等继续播放（播放视频仍会先暂停音乐）
  const office = await officeDetector.detect();
  const seq = ++presentSeq;
  // 目标屏：智能识别/用户指定的那块。有扩展屏就把放映窗口搬过去，否则默认落在主屏（老师看不到）
  const target = displays.targetIndex() >= 0 && displays.listDisplays().length > 1
    ? { displays: displays.displayTable(), index: displays.targetIndex() }
    : null;
  const result = await pptController.present(file, office.progId, false, target);
  if (seq !== presentSeq) {
    // 放映期间用户点了「退出投屏」：把刚打开的收掉，不覆盖退出后的状态
    if (result.ok) await pptController.exitPresent(config.get().exitAction.closePowerpoint);
    return result;
  }
  sm.mode = result.ok ? 'ppt' : 'idle';
  broadcast('ppt:state', { presenting: result.ok, file, loading: false, error: result.ok ? null : result.error });
  if (!result.ok) toast(`放映失败：${PPT_ERRORS[result.error] || result.error}`, 'error');
  // 搬到扩展屏的结果回报给老师：失败要说清楚「画面还在主屏」，别让用户以为程序没反应
  if (result.ok && target) {
    const show = result.show;
    if (!show || show.ok === false) {
      toast('没能把画面投到扩展屏，仍投在本机屏幕：请确认已切到扩展显示模式、投影屏已点亮', 'warn');
    } else if (show.mode === 'windowed') {
      toast(`已投到扩展屏（${displays.projectionDisplay().bounds.width}×${displays.projectionDisplay().bounds.height}）`, 'ok');
    }
  }
  // 先自动置顶（老师不手动开也要挡住 PPT 窗口），下面的补救重断言才有效
  if (result.ok) applyAutoTopOnPresent(true);
  // 置顶开着时，PPT 全屏窗口弹出会把面板盖掉；分几次把面板重新压回顶层
  if (result.ok && alwaysOnTop) {
    [800, 2000, 4000].forEach((ms) => setTimeout(() => assertAlwaysOnTop(true), ms)); // force：关键时刻不听节流
  }
  // 单屏放映：弹出无边框半透明悬浮控制条（鼠标靠近右下角浮现，不抢焦点）
  if (result.ok && screen.getAllDisplays().length === 1) floatBar.open(onHotkeyAction);
  else floatBar.close();
  if (result.ok) {
    noteFlip(); // 开播即进入翻页静默期：头几百毫秒不导图，让幻灯片渲染独占主线程
    pptServer.warmup(['thumb']); // 提前拉起 thumb 常驻进程：首轮 presenter 不再冷启动 PowerShell（GAP-07 按需策略只留给未放映场景）
    pollPresenter(); // 开播后立刻拉一次演讲者信息（页码/胶片/备注），免等 2s 轮询
    // PPT 放映时音量键交还系统（控制 PPT 内嵌视频音量），不再截给音乐引擎
    if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(false);
  } else {
    // 放映失败时确保音量键恢复控制音乐引擎（防止状态不一致）
    if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(true);
  }
  return result;
}

async function exitPresent() {
  presentSeq++; // 使进行中的放映结果失效
  floatBar.close(); // 收悬浮控制条
  applyAutoTopOnPresent(false); // 放映结束，还原老师原来的置顶状态
  const cfg = config.get();
  const res = await pptController.exitPresent(cfg.exitAction.closePowerpoint);
  sm.mode = 'idle';
  pptLastPos = 0;
  pptLastBroadcast = ''; // 清空广播签名：下次放映同一课件同一页也能正常广播
  broadcast('ppt:state', { presenting: false, file: '', loading: false });
  if (cfg.exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
  // 退出放映：恢复音量键注册（重新控制音乐引擎音量）
  if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(true);
  releaseDeferredThumbs(); // 放映期间延后的 PPT 缩略图在这里补做
  return res;
}

// 放映结束（含老师手动关窗口、退出命令两条路径）→ 把延后的缩略图请求放出来。
// 不做的话：放映前扫过库时 requestThumb 里的「放映中跳过」会把请求直接丢掉，
// 课件芯片和「当前课件」缩略图会一直是占位符。
function releaseDeferredThumbs() {
  try { thumbs.releaseDeferred(); } catch { }
}

function forwardHotkey(action) {
  broadcast('hotkey', action);
}

// 无线遥控命令（手机/电脑浏览器 → castServer → 这里），与面板/快捷键走同一套动作
function remoteCmd({ target, cmd, page }) {
  try {
    if (target === 'music') {
      // 音乐引擎在渲染层：走与全局快捷键相同的广播通道（遥控页 toggle → playPause）
      const musicCmdMap = { toggle: 'playPause', prev: 'prev', next: 'next', volUp: 'volUp', volDown: 'volDown', mute: 'mute' };
      // 桌面遥控端「分类播放」：复用分类 1/2 快捷键（渲染层 playCatIndex）
      if (cmd === 'playCat') { forwardHotkey(page === 1 ? 'cat2' : 'cat1'); return; }
      const act = musicCmdMap[cmd];
      if (act) forwardHotkey(act);
      return;
    }
    if (target === 'ppt') {
      if (cmd === 'next' || cmd === 'prev') { onHotkeyAction(cmd === 'next' ? 'pptNext' : 'pptPrev'); return; }
      if (cmd === 'exit') { exitPresent(); return; }
      if (cmd === 'goto') {
        pptController.gotoSlide(Math.floor(Number(page) || 0)).then((r) => {
          if (r.ok) {
            noteFlip();
            broadcast('ppt:presenter', { ok: true, presenting: true, position: r.position, total: r.total });
            pptLastTotal = r.total;
            pollPresenter();
          }
        }).catch(() => { });
        return;
      }
    }
    if (target === 'video') {
      const ledMode = config.get().displayMode === 'led';
      if (cmd === 'stop') {
        if (ledMode) broadcast('video:control', 'stop');
        videoWindow.stop();
        sm.mode = 'idle';
        broadcast('video:state', videoWindow.current());
      if (config.get().exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
      return;
    }
    // 没在播时遥控端按「播放/暂停」= 续播上次的视频（遥控端没有选片列表）；
    // 本次还没播过就退到视频库第一个，免得遥控起播静默失效
    if (cmd === 'toggle' && !videoWindow.current().playing) {
      // 库扫描已异步化：这里必须 await，否则拿到的是 Promise，「续播上次」会静默失效
      library.scanVideos().then((vids) => {
        const file = lastVideoFile || (vids[0] || {}).file || '';
        if (file) playVideoFile(file).catch(() => { });
      }).catch(() => { });
      return;
    }
    if (['toggle', 'volUp', 'volDown'].includes(cmd)) {
      if (ledMode) broadcast('video:control', cmd);
      else videoWindow.control(cmd);
    }
    }
  } catch { }
}

function onHotkeyAction(action) {
  if (action === 'present') { presentPpt(lastPptFile); return; }
  if (action === 'exitPresent') { exitPresent(); return; }
  if (action === 'timerToggle') { timer.togglePause(); return; }
  if (action === 'timerReset') { timer.reset(); return; }
  // PPT 翻页：COM 直接驱动放映视图，不抢放映窗口焦点（盲操场景）
  if (action === 'pptNext' || action === 'pptPrev') {
    if (!pptController.getState().presenting) return;
    const p = action === 'pptNext' ? pptController.nextSlide() : pptController.prevSlide();
    p.then((r) => {
      if (r.ok) {
        noteFlip(); // 翻页静默期计时：随后 600ms 内的 presenter 轮询只读缓存不导图
        broadcast('ppt:presenter', { ok: true, presenting: true, position: r.position, total: r.total }); // 页码即时刷新
        pptLastTotal = r.total;
        pollPresenter(); // 胶片随后跟上（thumb 通道，不阻塞下一次翻页）
      }
    }).catch(() => { });
    return;
  }
  broadcast('hotkey', action);
}

// ---------- IPC ----------

// ---------- 库缩略图：列表同步下发（缓存命中项带 thumb 路径），缺的异步生成后逐个广播补图 ----------
// 课件：PPT 走 COM 首页缩略图；图片用自身；PDF/Word/Excel 等文档不生成（占位图标）
function decorateThumbs(list, kind) {
  return (list || []).map((v) => {
    // 把库扫描时已取到的 size/mtime 透传给 thumbs，跳过对源文件的重复 statSync
    // （原来每文件要 5 次 stat：扫描 1 次 + decorate 2 次 + requestThumbs 2 次）
    const st = { size: v.size, mtimeMs: v.mtime };
    if (kind === 'ppt') {
      if (v.kind === 'img') return { ...v, thumb: v.file };
      if (v.kind === 'doc') return { ...v, thumb: '' };
      return { ...v, thumb: thumbs.cached('ppt', v.file, st) };
    }
    // 媒体库里的图片：自身就是缩略图，不必再跑一遍 ffmpeg 抽帧
    if (v.kind === 'img') return { ...v, thumb: v.file };
    return { ...v, thumb: thumbs.cached(kind, v.file, st) };
  });
}
function requestThumbs(list, kind) {
  // 已经有缩略图的（decorateThumbs 刚命中缓存）不必再入队，省掉第二轮 cached() 的 stat
  const filtered = (list || []).filter((v) => (kind !== 'ppt' || v.kind === 'ppt') && !v.thumb);
  thumbs.requestMany(kind, filtered, (k, file, thumb) => broadcast('thumb:ready', { kind: k, file, thumb }));
}

// 入库目标路径：同名同大小视为同一份（返回 null 跳过），否则加 (n) 后缀避免覆盖
function uniqueDest(dest, src) {
  if (!fs.existsSync(dest)) return dest;
  try { if (fs.statSync(dest).size === fs.statSync(src).size) return null; } catch { }
  const dir = path.dirname(dest);
  const stem = path.basename(dest, path.extname(dest));
  const ext = path.extname(dest);
  let k = 1;
  for (;;) {
    const next = path.join(dir, `${stem} (${k++})${ext}`);
    if (!fs.existsSync(next)) return next;
    try { if (fs.statSync(next).size === fs.statSync(src).size) return null; } catch { }
  }
}

/* 起播视频：面板点播与遥控端「播放」共用。冷门格式先转码；起播成功记住文件，
 * 遥控端（手机/另一台电脑）在空闲时按「播放/暂停」即可续播上次的视频。 */
async function playVideoFile(file) {
  if (!file || !fs.existsSync(file)) {
    toast('找不到投放文件（U 盘拔了？）', 'error');
    return { ok: false, error: 'file-not-found' };
  }
  const ext = path.extname(file).toLowerCase();
  // 图片：直接整屏投放，不转码（课件截图/板书照片走视频板块）
  if (library.isImgExt(ext)) {
    // 图片走下面的统一投放路径（LED 内联 / 扩展屏整屏 + 翻图轮播）
  } else if (!transcode.isVideoSafe(ext) && transcode.isVideoExt(ext)) {
    // 库里手动拖入的冷门格式（MOV/MKV/AVI 等）：播放前自动转码为 MP4
    const label = path.basename(file);
    broadcast('import:progress', { label, pct: 0 });
    const t = await transcode.transcode(file, config.get().videoDir, 'video', (pct) => broadcast('import:progress', { label, pct }));
    broadcast('import:progress', null);
    if (!t.ok) {
      toast(`「${label}」转码失败，无法播放`, 'error');
      return { ok: false, error: 'transcode-failed' };
    }
    file = t.file;
    toast(`「${label}」已转码为 MP4，下次点播即播`, 'ok');
  }
  if (pptController.getState().presenting) {
    toast('PPT 正在放映，请先退出投屏再播视频', 'warn');
    return { ok: false, error: 'ppt-presenting' };
  }
  if (sm.mode === 'ppt') return { ok: false, error: 'ppt-presenting' };
  const ledMode = config.get().displayMode === 'led';
  if (ledMode) {
    const r = videoWindow.playInline(file);
    if (r.ok) {
      sm.mode = 'video';
      lastVideoFile = file;
      // immediate：视频要立刻出声，音乐不等淡出尾巴，避免起播瞬间撞音（BUG-C）
      broadcast('music:restore', { action: 'duck', immediate: true });
      broadcast('video:load', { file });
      broadcast('video:state', videoWindow.current());
    }
    return r;
  }
  const r = videoWindow.play(file, {
    windowed: !!config.get().videoWindowed,
    images: library.isImgExt(ext) ? (await library.scanVideos()).filter((v) => v.kind === 'img').map((v) => v.file) : null,
    auto: !!config.get().imageAutoPlay,
    seconds: config.get().imageAutoSeconds,
  });
  if (r.ok) {
    sm.mode = 'video';
    lastVideoFile = file;
    // immediate：视频要立刻出声，音乐不等淡出尾巴，避免起播瞬间撞音（BUG-C）
      broadcast('music:restore', { action: 'duck', immediate: true });
    broadcast('video:state', videoWindow.current());
  }
  return r;
}

function registerIpc() {
  ipcMain.handle('app:getInit', async () => {
    const office = await officeDetector.detect();
    const videos = decorateThumbs(await library.scanVideos(), 'video');
    const ppts = decorateThumbs(await library.scanPpts(), 'ppt');
    requestThumbs(videos, 'video');
    requestThumbs(ppts, 'ppt');
    return {
      config: config.get(),
      music: await library.scanMusic(),
      videos,
      ppts,
      displays: displays.listDisplays(),
      office,
      ppt: pptController.getState(),
      video: videoWindow.current(),
      hotkeyConflicts,
      alwaysOnTop,
      mode: sm.mode,
      version: app.getVersion(),
      platform: process.platform, // 渲染层按平台隐藏 Windows 专属入口（一键扩展模式等）、切换快捷键文案
      // 品牌负载：名称/版本/官网/赞助 + 解密 logo 临时路径，页面随后全部改用这些值
      brand: {
        name: brandm.name,
        version: brandm.version,
        site: brandm.site,
        sponsor: brandm.sponsor,
        logo: brand.logoFile(),
      },
      welcomeBgDir: path.join(getResourcesPath(), 'welcome-bg'),
      welcomeBgs: loadWelcomeBgs() || [{ file: '01.png', label: '鎏金风华' }],
    };
  });
  ipcMain.handle('app:quit', () => quitApp());

  // 复制文本到剪贴板（渲染进程 sandbox 下 navigator.clipboard 不可用，改走主进程）
  ipcMain.handle('app:copyText', (_e, text) => {
    try { clipboard.writeText(String(text || '')); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  // 打开官网/赞助外链：仅放行 https 的官方域名（域名白名单来自解密数据，改包改域名都会校验失败）
  ipcMain.handle('app:openExternal', (_e, url) => {
    try {
      if (!brandm) return { ok: false, error: 'brand-locked' };
      const u = new URL(String(url));
      if (u.protocol !== 'https:') return { ok: false, error: 'bad-url' };
      const host = u.hostname.toLowerCase();
      const allowed = (brandm.officialHosts || []).some((h) => host === h || host.endsWith('.' + h));
      if (!allowed) return { ok: false, error: 'bad-host' };
      shell.openExternal(u.href);
      return { ok: true };
    } catch { return { ok: false, error: 'bad-url' }; }
  });

  ipcMain.handle('config:save', (_e, patch) => {
    const next = config.save(patch);
    // 开机自启在保存时即时生效，无需重启（GAP-02）
    if (patch && typeof patch.autoLaunch === 'boolean') {
      try { app.setLoginItemSettings({ openAtLogin: patch.autoLaunch }); } catch { }
    }
    return next;
  });

  ipcMain.handle('library:scan', async () => {
    const videos = decorateThumbs(await library.scanVideos(), 'video');
    const ppts = decorateThumbs(await library.scanPpts(), 'ppt');
    requestThumbs(videos, 'video');
    requestThumbs(ppts, 'ppt');
    return { music: await library.scanMusic(), videos, ppts };
  });

  // Windows/macOS 默认文件系统大小写不敏感：比较前统一大小写，避免「小写盘符路径」被误判
  // 为不在库内（deleteFile 拒绝删除 / openDialog 误复制出 "(1)" 重复文件）——RD-01
  const withinRoot = (p, root) => {
    const a = path.resolve(String(p)).toUpperCase();
    const b = path.resolve(String(root)).toUpperCase();
    return a.startsWith(b + path.sep);
  };

  // 从库里删除文件（移入回收站，可找回）：允许用户库目录（视频/课件/音乐），
  // 音乐另放行内置曲库目录（per-user 安装可写；回收站兜底，重装可恢复）
  // 删除课件时先「释放」PowerPoint 占用：选中课件会后台只读打开预热，
  // 文件被占用时 Windows 无法把它移进回收站（表现为「删除不了」）——RD
  ipcMain.handle('library:deleteFile', async (_e, { kind, file }) => {
    const cfg = config.get();
    const roots = { video: [cfg.videoDir], ppt: [cfg.pptDir], music: [cfg.musicDir, path.join(getResourcesPath(), 'music')] };
    const allowed = (roots[kind] || []).filter(Boolean).map((d) => path.resolve(d));
    if (!allowed.length || !file) return { ok: false, error: 'bad-args' };
    const target = path.resolve(String(file));
    if (!allowed.some((rootAbs) => withinRoot(target, rootAbs))) return { ok: false, error: 'not-in-library' };
    if (!fs.existsSync(target)) return { ok: false, error: 'not-found' };
    // PPT：先关掉后台预热打开的演示文稿（不碰正在放映的）；非 PPT 文档未预热，无需释放
    if (kind === 'ppt' && library.isPptExt(path.extname(target))) {
      const rel = await pptController.runCtl('release', { path: target }, 6000).catch(() => null);
      if (rel && rel.ok === false && rel.error === 'presenting') return { ok: false, error: 'ppt-presenting' };
    }
    const freshLists = async () => {
      const videos = decorateThumbs(await library.scanVideos(), 'video');
      const ppts = decorateThumbs(await library.scanPpts(), 'ppt');
      requestThumbs(videos, 'video');
      requestThumbs(ppts, 'ppt');
      return { music: await library.scanMusic(), videos, ppts };
    };
    try {
      await shell.trashItem(target);
      // 删成功：清掉失效的「最近使用」记录与 lastPptFile 兜底
      if (kind === 'ppt') {
        if (lastPptFile && path.resolve(lastPptFile).toUpperCase() === target.toUpperCase()) lastPptFile = '';
        const next = (cfg.recentPpt || []).filter((f) => path.resolve(f).toUpperCase() !== target.toUpperCase());
        if (next.length !== (cfg.recentPpt || []).length) config.save({ recentPpt: next });
      }
      return { ok: true, ...(await freshLists()) };
    } catch (err) {
      // PowerPoint 释放文件句柄略有延迟：再释放一次、稍等重试（仍失败才报占用）；非 PPT 文档直接报错
      if (kind === 'ppt' && library.isPptExt(path.extname(target))) {
        await pptController.runCtl('release', { path: target }, 6000).catch(() => null);
        await new Promise((r) => setTimeout(r, 500));
        try {
          await shell.trashItem(target);
          if (lastPptFile && path.resolve(lastPptFile).toUpperCase() === target.toUpperCase()) lastPptFile = '';
          const next = (cfg.recentPpt || []).filter((f) => path.resolve(f).toUpperCase() !== target.toUpperCase());
          if (next.length !== (cfg.recentPpt || []).length) config.save({ recentPpt: next });
          return { ok: true, ...(await freshLists()) };
        } catch (err2) { return { ok: false, error: 'busy' }; }
      }
      return { ok: false, error: String(err) };
    }
  });

  // 重命名曲目（右键曲目行调用）：只允许改**用户音乐库**里的文件。
  // 内置曲库在安装目录（Program Files），改名要么没权限、要么下次重装/升级就被覆盖回来，因此一律拒绝。
  ipcMain.handle('music:renameTrack', async (_e, { file, name }) => {
    const cfg = config.get();
    const root = cfg.musicDir ? path.resolve(cfg.musicDir) : '';
    if (!root || !file) return { ok: false, error: 'bad-args' };
    const target = path.resolve(String(file));
    if (!withinRoot(target, root)) return { ok: false, error: 'builtin' }; // 内置曲库不给改
    if (!fs.existsSync(target)) return { ok: false, error: 'not-found' };
    const ext = path.extname(target);
    // 顺手滤掉 Windows 文件名非法字符，省得老师改完发现没生效还看不懂
    let base = String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '').trim().replace(/\.+$/, '');
    // 老师可能连扩展名一起输（"神曲.mp3"），否则会变成 "神曲.mp3.mp3"
    if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length).trim();
    if (!base) return { ok: false, error: 'empty' };
    if (base.length > 80) return { ok: false, error: 'too-long' };
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return { ok: false, error: 'reserved-name' }; // Windows 保留设备名
    const dest = path.join(path.dirname(target), base + ext);
    const fresh = async () => ({ ok: true, name: path.basename(dest), file: dest, music: await library.scanMusic() });
    if (dest.toUpperCase() === target.toUpperCase()) return fresh(); // 没改，直接当成功
    if (fs.existsSync(dest)) return { ok: false, error: 'exists' };
    try {
      fs.renameSync(target, dest);
    } catch (err) {
      return { ok: false, error: err && err.code === 'EBUSY' ? 'busy' : 'io' };
    }
    // 手工排序里记的是完整路径，不跟着换的话这首的排序会失效（回落到 mtime 序）
    const cat = path.basename(path.dirname(dest));
    const order = cfg.catTrackOrder || {};
    if (Array.isArray(order[cat])) {
      order[cat] = order[cat].map((x) => (path.resolve(x).toUpperCase() === dest.toUpperCase() ? dest : x));
      config.save({ catTrackOrder: order });
    }
    return fresh();
  });

  // 自定义音乐分类：添加（建文件夹）/ 删除（文件夹入回收站，可找回）
  const CAT_NAME_RE = /^[^\\/:*?"<>|]{1,30}$/;
  ipcMain.handle('music:addCategory', async (_e, name) => {
    name = String(name || '').trim();
    if (!CAT_NAME_RE.test(name)) return { ok: false, error: 'bad-name' };
    const dir = config.get().musicDir;
    const target = path.join(dir, name);
    if (fs.existsSync(target)) return { ok: false, error: 'exists' };
    try {
      fs.mkdirSync(target, { recursive: true });
      return { ok: true, music: await library.scanMusic() };
    } catch (err) { return { ok: false, error: String(err) }; }
  });
  ipcMain.handle('music:removeCategory', async (_e, name) => {
    name = String(name || '');
    if (!CAT_NAME_RE.test(name)) return { ok: false, error: 'bad-name' };
    const dir = path.resolve(config.get().musicDir);
    const target = path.resolve(path.join(dir, name));
    if (!target.startsWith(dir + path.sep) || !fs.existsSync(target)) return { ok: false, error: 'not-found' };
    try {
      await shell.trashItem(target); // 移入回收站而非永久删除
      return { ok: true, music: await library.scanMusic() };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  // 导入音乐到指定分类：弹文件选择 → 复制进用户音乐文件夹（长期保存），重名自动加 (n)
  ipcMain.handle('music:import', async (_e, category) => {
    category = String(category || '').trim();
    if (!CAT_NAME_RE.test(category)) return { ok: false, error: 'bad-name' };
    const r = await dialog.showOpenDialog(win, {
      title: `导入音乐到「${category}」（支持 MP3/WMA/APE/FLAC 等全部常见格式）`,
      filters: [{ name: '音频文件', extensions: transcode.AUDIO_ALL.map((x) => x.slice(1)) }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const dir = path.join(config.get().musicDir, category);
    fs.mkdirSync(dir, { recursive: true });
    let imported = 0, transcoded = 0, failed = 0;
    for (const src of r.filePaths) {
      const ext = path.extname(src).toLowerCase();
      if (!transcode.isAudioExt(ext)) { failed++; continue; }
      if (transcode.isAudioSafe(ext)) {
        const base = path.basename(src);
        const stem = base.slice(0, -ext.length);
        let dest = path.join(dir, base);
        let k = 1;
        while (fs.existsSync(dest)) dest = path.join(dir, `${stem} (${k++})${ext}`);
        try { fs.copyFileSync(src, dest); imported++; } catch { failed++; }
      } else {
        // 冷门格式（wma/ape/amr 等）：转码为 MP3 入库
        const label = path.basename(src);
        broadcast('import:progress', { label, pct: 0 });
        const t = await transcode.transcode(src, dir, 'audio', (pct) => broadcast('import:progress', { label, pct }));
        if (t.ok) { imported++; transcoded++; } else { failed++; toast(`「${label}」转码失败`, 'error'); }
      }
    }
    broadcast('import:progress', null);
    return { ok: true, imported, transcoded, failed, music: await library.scanMusic() };
  });

  ipcMain.handle('displays:list', () => displays.listDisplays());
  // 手动指定投屏目标屏（0 = 交回智能识别）；视频/PPT/计时窗口都按它走
  ipcMain.handle('displays:select', async (_e, id) => {
    const want = Math.max(0, Number(id) || 0);
    const list = displays.listDisplays();
    if (want && !list.some((d) => d.id === want)) return { ok: false, displays: list };
    config.save({ display: { projectionId: want } });
    const after = displays.listDisplays();
    broadcast('displays:changed', after);
    const t = after.find((d) => d.isProjection);
    toast(want
      ? `投屏目标已固定到「${t ? t.label : '所选屏幕'}」`
      : '投屏目标已改为智能识别（外接屏）', 'ok');
    return { ok: true, displays: after };
  });
  // 一键扩展模式是 Windows 能力；Mac 上外接默认即扩展，直接返回成功（面板在 Mac 不展示该按钮）
  ipcMain.handle('displays:extend', () => (IS_MAC ? { ok: true, noop: 'mac-default-extend' } : displays.extendMode()));
  screen.on('display-removed', () => {
    // 投影线被拔掉：视频/计时/同屏/欢迎窗口都不能再留在不存在的显示器上
    timer.closeWindow();
    // 同屏原先只 close() 接收窗，服务与信标都留着（发送端还能上传、信标还在广播）。
    // 这里走统一收尾，保证不会残留。
    if (castServer.running()) teardownCast().catch(() => { });
    welcomeWindow.close();
    if (videoWindow.isPlaying()) {
      videoWindow.stop();
      sm.mode = 'idle';
      broadcast('video:state', videoWindow.current());
      toast('显示器已断开，视频投放已停止', 'warn');
    }
    broadcast('displays:changed', displays.listDisplays());
  });
  screen.on('display-added', () => broadcast('displays:changed', displays.listDisplays()));

  ipcMain.handle('office:detect', (_e, force) => officeDetector.detect(!!force));

  ipcMain.handle('ppt:openDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择课件',
      defaultPath: config.get().pptDir || undefined,
      filters: [
        { name: '课件与文档', extensions: library.COURSEWARE_EXT_ARR },
        { name: '演示文稿', extensions: ['pptx', 'ppt', 'ppsx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Word', extensions: ['doc', 'docx', 'rtf', 'wps'] },
        { name: 'Excel', extensions: ['xls', 'xlsx', 'et'] },
        { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'svg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    lastPptFile = r.filePaths[0];
    library.pushRecent('ppt', lastPptFile);
    // 入库：课件不在课件文件夹时复制进去（与视频库行为一致）——课件库芯片 + 缩略图立即可见
    let imported = false;
    try {
      const dir = config.get().pptDir;
      const normDir = path.normalize(dir);
      if (!withinRoot(lastPptFile, normDir)) {
        fs.mkdirSync(dir, { recursive: true });
        let dest = path.join(dir, path.basename(lastPptFile));
        const ext = path.extname(dest);
        const stem = path.basename(dest, ext);
        let k = 1;
        while (fs.existsSync(dest)) dest = path.join(dir, `${stem} (${k++})${ext}`);
        await fs.promises.copyFile(lastPptFile, dest);
        imported = true;
      }
    } catch { }
    const ppts = decorateThumbs(await library.scanPpts(), 'ppt');
    requestThumbs(ppts, 'ppt'); // 新课件异步导第 1 页缩略图，好了广播补图
    return { file: lastPptFile, imported, ppts };
  });
  ipcMain.handle('ppt:present', (_e, file) => {
    if (file) lastPptFile = file;
    return presentPpt(lastPptFile);
  });
  ipcMain.handle('ppt:exit', () => exitPresent());
  // 放映预热：选中课件后后台「只读无窗口」打开（ctl 通道串行，放映点击时只剩 Run）
  ipcMain.handle('ppt:preopen', (_e, file) => {
    if (!file || pptController.getState().presenting) return { ok: false, error: 'busy' };
    // 非 PPT 文档（PDF/Word/图片…）不走 COM 预热，避免白拉起 PowerPoint 打不开还报错
    if (!library.isPptExt(path.extname(file))) return { ok: true, noop: 'non-ppt' };
    return pptController.runCtl('preopen', { path: file }, 20000, 'ctl');
  });
  // 全部页面缩略图：一次性导出所有页到按版本缓存的目录，目录轮询渐进广播（页面导出一张显示一张）
  let exportAllBusy = false;
  ipcMain.handle('ppt:exportAll', async (_e, file) => {
    if (!file) return { ok: false, error: 'no-file' };
    if (!library.isPptExt(path.extname(file))) return { ok: true, total: 0, cached: true }; // 非 PPT 无页面网格
    // 放映中：绝不启动新的导出（Export 与幻灯片渲染抢主线程，会把放映卡死，PERF-12），
    // 但仍把「已缓存的页」列出来 —— 面板缩略图轨道要跟着正在放的那份课件，
    // 否则老师点缩略图会跳到另一份课件的页码上。
    if (pptController.getState().presenting) {
      const dir = pptExportDir(file);
      const pages = [];
      let total = 0;
      try { total = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).total || 0; } catch { }
      try {
        for (const f of fs.readdirSync(dir)) {
          const m = /^page-(\d+)\.png$/.exec(f);
          if (m) pages.push({ page: Number(m[1]), img: path.join(dir, f) });
        }
        pages.sort((a, b) => a.page - b.page);
      } catch { }
      broadcast('ppt:pages', { file, pages, done: true, presenting: true });
      return { ok: true, total: total || pages.length, cached: true };
    }
    if (exportAllBusy) return { ok: false, error: 'busy' };
    exportAllBusy = true;
    try {
      const dir = pptExportDir(file);
      let lastCount = -1;
      // 导出 300 页课件时，每 400ms 全量重发一次整个 pages 数组 = O(N²)（累计约 4.5 万条对象），
// 主线程持续抖动。改成「攒够 8 页或收尾才发」：进度依然可见，IPC 量降到约 1/8。
const PAGES_BATCH = 8;
const pushPages = (done) => {
        try {
          const pages = [];
          for (const f of fs.readdirSync(dir)) {
            const m = /^page-(\d+)\.png$/.exec(f);
            if (m) pages.push({ page: Number(m[1]), img: path.join(dir, f) });
          }
          pages.sort((a, b) => a.page - b.page);
          if (done || lastCount === -1 || pages.length - lastCount >= PAGES_BATCH) {
            lastCount = pages.length;
            broadcast('ppt:pages', { file, pages, done });
          }
          return pages.length;
        } catch { return lastCount; }
      };
      // 全部页面已缓存（meta.json 记录的总页数已齐）→ 不启动 PowerPoint，直接广播，启动零开销
      let cachedTotal = 0;
      try { cachedTotal = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).total || 0; } catch { }
      const dirCount = (() => { try { return fs.readdirSync(dir).filter((f) => /^page-\d+\.png$/.test(f)).length; } catch { return 0; } })();
      if (cachedTotal > 0 && dirCount >= cachedTotal) {
        pushPages(true);
        return { ok: true, total: cachedTotal, cached: true };
      }
      let job = pptController.runCtl('exportall', { path: file, exportDir: dir }, 180000, 'thumb');
      let exportPollTimer = setInterval(() => pushPages(false), 400); // 不再遮蔽 ./timer 模块（BUG-12）
      let res = await job;
      // open-failed 绝大多数不是文件本身的问题，而是常驻 PowerShell 里缓存的 COM 代理
      // 已经失效（PowerPoint 被杀/崩过，之后 SlideShowWindows / Open 全部失灵）。
      // 这种状态没有任何自愈路径，必须把 thumb 通道整个重启、换一个新进程新 COM 实例再试一次。
      if (res && !res.ok && res.error === 'open-failed') {
        clearInterval(exportPollTimer);
        pptController.resetChannel('thumb');
        console.warn('[ppt] exportall open-failed，已重启 thumb 通道重试：', res.detail || '');
        job = pptController.runCtl('exportall', { path: file, exportDir: dir }, 180000, 'thumb');
        exportPollTimer = setInterval(() => pushPages(false), 400);
        res = await job;
      }
      clearInterval(exportPollTimer);
      if (res && res.ok) {
        // 放映已开始 → 脚本主动停导（aborted）：页面没导全，不写 meta.json（下次选中会重导），
        // 但仍广播完成帧清掉「导出中」指示（放映中面板要用页面网格跳页）
        if (!res.aborted) {
          try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ total: res.total })); } catch { }
        }
        pushPages(true);
        // 有页数、没打断、却一张没导出来 → COM 导出实际失败了（原来这里照报 ok=true，
        // 面板只能干等「导出中 0 页」，人也查不出原因）。明确报错让面板提示并可重试。
        if (!res.aborted && res.total > 0 && res.exported === 0 && dirCount === 0) {
          return { ok: false, error: res.error || 'export-produced-nothing', total: res.total };
        }
        return { ok: true, total: res.total, exported: res.exported, aborted: !!res.aborted };
      }
      return { ok: false, error: (res && res.error) || 'export-failed', detail: res && res.detail };
    } finally { exportAllBusy = false; }
  });
  ipcMain.handle('ppt:status', () => pptController.syncStatus());
  // 无线遥控：命令回调 + 状态快照（遥控页每秒轮询刷新）
  castServer.setCommandHandler(remoteCmd);
  castServer.setStateProvider(() => ({
    music: { playing: !!musicMemo.playing, track: musicMemo.track || '', volume: Math.round((musicMemo.volume || 0) * 100) },
    ppt: { presenting: pptController.getState().presenting, position: pptLastPos || 0, total: pptLastTotal || 0 },
    video: { playing: !!videoWindow.current().playing },
  }));
  ipcMain.handle('ppt:next', async () => {
    const r = await pptController.nextSlide();
    if (r.ok) {
      noteFlip();
      broadcast('ppt:presenter', { ok: true, presenting: true, position: r.position, total: r.total }); // 页码即时刷新
      pptLastTotal = r.total;
      pollPresenter(); // 胶片随后跟上（thumb 通道，连续翻页不互相堵）
    }
    return r;
  });
  ipcMain.handle('ppt:prev', async () => {
    const r = await pptController.prevSlide();
    if (r.ok) {
      noteFlip();
      broadcast('ppt:presenter', { ok: true, presenting: true, position: r.position, total: r.total });
      pptLastTotal = r.total;
      pollPresenter();
    }
    return r;
  });
  // 演讲者条缩略图点击：跳任意页后立刻刷新 5 页胶片
  ipcMain.handle('ppt:goto', async (_e, page) => {
    const r = await pptController.gotoSlide(Math.floor(Number(page) || 0));
    if (r.ok) {
      noteFlip();
      broadcast('ppt:presenter', { ok: true, presenting: true, position: r.position, total: r.total });
      pptLastTotal = r.total;
      pollPresenter();
    }
    return r;
  });

  // 添加到媒体库：视频全格式 + 图片。视频能直播的直接拷贝，MOV/MKV/AVI 等自动转码为 MP4 再入库；
  // 图片原样入库（视频板块里整屏投放，可翻图/轮播）。不直接播放，入库后点卡片才投放。
  ipcMain.handle('video:openDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '添加到媒体库（视频：MP4/MOV/MKV/AVI/WMV/FLV 等；图片：JPG/PNG/BMP/GIF/WEBP 等）',
      defaultPath: config.get().videoDir || undefined,
      filters: [
        { name: '视频与图片', extensions: [...transcode.VIDEO_ALL.map((x) => x.slice(1)), ...library.MEDIA_EXT_ARR] },
        { name: '视频', extensions: transcode.VIDEO_ALL.map((x) => x.slice(1)) },
        { name: '图片', extensions: library.IMG_EXT_ARR },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
    const dir = config.get().videoDir;
    fs.mkdirSync(dir, { recursive: true });
    let imported = 0, transcoded = 0, failed = 0, images = 0;
    for (const src of r.filePaths) {
      const ext = path.extname(src).toLowerCase();
      // 图片：原样拷贝入库（视频板块整屏投放）
      if (library.isImgExt(ext)) {
        try {
          const dest = uniqueDest(path.join(dir, path.basename(src)), src);
          if (!dest) continue;
          fs.copyFileSync(src, dest);
          imported++; images++;
        } catch { failed++; }
        continue;
      }
      if (!transcode.isVideoExt(ext)) { failed++; continue; }
      if (transcode.isVideoSafe(ext)) {
        // Chromium 可直播：直接拷贝（重名加 (n)，同内容跳过）
        const dest = uniqueDest(path.join(dir, path.basename(src)), src);
        if (!dest) continue;
        try { fs.copyFileSync(src, dest); imported++; } catch { failed++; }
      } else {
        // 需转码：转 MP4 入库（H.264+AAC，所有设备可播）
        const label = path.basename(src);
        broadcast('import:progress', { label, pct: 0 });
        const t = await transcode.transcode(src, dir, 'video', (pct) => broadcast('import:progress', { label, pct }));
        if (t.ok) { imported++; transcoded++; } else { failed++; toast(`「${label}」转码失败`, 'error'); }
      }
    }
    broadcast('import:progress', null);
    const videos = decorateThumbs(await library.scanVideos(), 'video');
    requestThumbs(videos, 'video'); // 新入库的媒体异步抽首帧，好了广播 thumb:ready
    return { ok: true, imported, transcoded, failed, images, videos };
  });
  ipcMain.handle('video:play', async (_e, file) => playVideoFile(file));
  ipcMain.handle('video:stop', () => {
    const ledMode = config.get().displayMode === 'led';
    if (ledMode) broadcast('video:control', 'stop');
    videoWindow.stop();
    sm.mode = 'idle';
    broadcast('video:state', videoWindow.current());
    if (config.get().exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
    return { ok: true };
  });
  ipcMain.handle('video:control', (_e, cmd) => {
    const ledMode = config.get().displayMode === 'led';
    // LED 模式的 stop 走的是面板内联：原来只把指令广播给渲染层，主进程这边
    // inlineMode / sm.mode / video:state 都没更新，表现为「画面已停但面板仍显示投放中」。
    if (ledMode && cmd === 'stop') {
      videoWindow.stop();
      sm.mode = 'idle';
      broadcast('video:state', videoWindow.current());
      if (config.get().exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
      return { ok: true };
    }
    if (ledMode) { broadcast('video:control', cmd); return { ok: true }; }
    const r = videoWindow.control(cmd);
    // 图片自动轮播开关：记住老师的偏好，下次投放图片直接沿用
    if (cmd === 'auto' && r && r.ok) config.save({ imageAutoPlay: !!r.auto });
    return r || { ok: true };
  });
  // 面板进度条拖动跳转：LED 内联模式由面板本地处理（它自己就是播放器），这里只服务外部播放窗
  ipcMain.handle('video:seek', (_e, payload) => {
    const t = payload && typeof payload === 'object' ? Number(payload.t) : Number(payload);
    if (!isFinite(t)) return { ok: false };
    return videoWindow.seek(t);
  });
  // 全屏 ⇄ 窗口模式互切（面板遥控条 / 播放窗口进度条的 ⛶ 按钮）；模式记忆，下次播放沿用
  ipcMain.handle('video:windowToggle', () => {
    const r = videoWindow.toggleWindowMode();
    if (r.ok) {
      config.save({ videoWindowed: r.windowed });
      broadcast('video:state', videoWindow.current());
    }
    return r;
  });

  let musicPersistTimer = null;
  ipcMain.handle('music:setState', (_e, s) => {
    musicMemo = s;
    if (tray && !tray.isDestroyed()) {
      const bn = (brandm && brandm.name) || '课堂中控';
      tray.setToolTip(s && s.playing && s.track ? `${bn} · ♪ ${s.track}` : `${bn} · 课堂中控`);
    }
    // 音量/循环模式记忆（对标 Spotify：重启后保持上次的设置）
    clearTimeout(musicPersistTimer);
    musicPersistTimer = setTimeout(() => {
      const c = config.get();
      if (s && typeof s.volume === 'number' && s.loopMode &&
        (s.volume !== c.volume || s.loopMode !== c.loopMode)) {
        config.save({ volume: s.volume, loopMode: s.loopMode });
      }
    }, 800);
    return { ok: true };
  });

  // 音乐播放前解析「可播放路径」：冷门格式（wma/ape/amr/ra/ac3/dts/mka…）转码为缓存的 MP3；
  // safe 或非音频原样返回。引擎 startTrack 播放前调它，让各种格式都能播。
  ipcMain.handle('music:playable', async (_e, file) => {
    if (!file) return { file: '' };
    try {
      const r = await transcode.ensureAudioPlayable(file, (pct) => {
        broadcast('import:progress', { label: path.basename(file), pct });
      });
      broadcast('import:progress', null);
      return r;
    } catch (e) {
      broadcast('import:progress', null);
      return { file, transcoded: false, error: String(e) };
    }
  });

  ipcMain.handle('hotkey:remap', (_e, { action, accelerator }) => {
    const r = hotkeys.remap(action, accelerator, onHotkeyAction);
    hotkeyConflicts = hotkeyConflicts.filter((c) => c.action !== action);
    return r;
  });
  ipcMain.handle('hotkey:conflicts', () => hotkeyConflicts);

  ipcMain.handle('window:toggleAlwaysOnTop', () => {
    alwaysOnTop = !alwaysOnTop;
    autoTopApplied = false; // 老师自己动过置顶：不再由「放映自动置顶」负责还原
    win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
    if (alwaysOnTop) assertAlwaysOnTop();
    return { alwaysOnTop };
  });
  ipcMain.handle('window:minimize', () => { win.minimize(); return { ok: true }; });
  ipcMain.handle('window:toggleFullscreen', () => {
    const fs = !win.isFullScreen();
    win.setFullScreen(fs);
    if (!fs) win.setMenuBarVisibility(false);
    return { fullscreen: fs };
  });
  ipcMain.handle('window:setFullscreen', (_e, on) => {
    win.setFullScreen(!!on);
    if (!on) win.setMenuBarVisibility(false);
    return { fullscreen: !!on };
  });

  // ---------- 迷你模式（单屏 LED：极小控制面板） ----------
  ipcMain.handle('window:miniMode', (_e, arg) => {
    // arg 兼容布尔；对象形态 { on, dockCorner, compact }：
    // dockCorner=放映联动自动进入时贴右下角；compact=PPT 全屏放映时的超紧凑悬浮条（约迷你条一半）
    const on = typeof arg === 'object' && arg !== null ? !!arg.on : !!arg;
    const dockCorner = typeof arg === 'object' && arg !== null && !!arg.dockCorner;
    const compact = typeof arg === 'object' && arg !== null && !!arg.compact;
    if (!win) return { ok: false };
    if (on) {
      if (!config.get().miniMode) config.save({ windowBounds: win.getBounds() }); // 先存正常尺寸
      if (win.isMaximized() || win.isFullScreen()) { win.setFullScreen(false); win.unmaximize(); } // 最大化/全屏下 setBounds 无效
      win.setMinimumSize(compact ? 300 : 460, compact ? 66 : 110);
      win.setAlwaysOnTop(true, 'screen-saver'); // 置顶级拉高，保证浮在欢迎屏/视频全屏窗之上
      const mb = config.get().miniBounds;
      if (!compact && mb && isBoundsVisible(mb)) {
        win.setBounds(mb);
      } else {
        const sz = compact ? { w: 300, h: 66 } : { w: 540, h: 132 };
        if (dockCorner) {
          // 放映联动：直接停靠右下角（自动隐藏的判定条件），不挡课件中心区域
          win.setSize(sz.w, sz.h);
          const d = screen.getPrimaryDisplay().workArea;
          win.setBounds({ x: d.x + d.width - sz.w - 12, y: d.y + d.height - sz.h - 12, width: sz.w, height: sz.h });
        } else {
          win.setSize(sz.w, sz.h);
        }
      }
      // 落点已在右下角的，直接算停靠（自动隐藏判定条件）
      const b = win.getBounds();
      const d = screen.getDisplayMatching(b).workArea;
      miniDocked = Math.abs((b.x + b.width) - (d.x + d.width)) < 100 && Math.abs((b.y + b.height) - (d.y + d.height)) < 100;
    } else {
      miniDocked = false; miniCollapsed = false; miniBoundsBeforeCollapse = null;
      win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
      win.setMinimumSize(920, 640);
      const wb = config.get().windowBounds;
      if (wb && isBoundsVisible(wb)) win.setBounds(wb); else win.setSize(1060, 780);
    }
    return { ok: true };
  });

// 迷你面板当前是否贴在右下角（实时算窗口位置，不缓存——避免 setBounds 异步导致状态过期）
function isMiniDockedAtCorner() {
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b).workArea;
  return Math.abs((b.x + b.width) - (d.x + d.width)) < 100 && Math.abs((b.y + b.height) - (d.y + d.height)) < 100;
}

// 迷你面板收起为小把手（仅停靠右下角且设置开启时生效）；失败时带原因便于排查
ipcMain.handle('window:miniCollapse', () => {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' };
  if (!config.get().miniMode) return { ok: false, reason: 'not-mini' };
  if (!config.get().miniAutoHide) return { ok: false, reason: 'autohide-off' };
  if (miniCollapsed) return { ok: false, reason: 'already-collapsed' };
  if (!isMiniDockedAtCorner()) return { ok: false, reason: 'not-docked' };
  miniBoundsBeforeCollapse = win.getBounds();
  const d = screen.getDisplayMatching(miniBoundsBeforeCollapse).workArea;
  miniCollapsed = true;
  win.setMinimumSize(48, 48); // 先放宽最小尺寸，否则收不大
  // 注意：Windows 对带标题栏窗口有系统最小宽度（约 136px），64 会被钳到 ~120，属正常
  win.setBounds({ x: d.x + d.width - 120 - 12, y: d.y + d.height - 64 - 12, width: 120, height: 64 });
  return { ok: true };
});
ipcMain.handle('window:miniExpand', () => {
  if (!win || win.isDestroyed() || !miniCollapsed || !miniBoundsBeforeCollapse) return { ok: false };
  miniCollapsed = false;
  win.setBounds(miniBoundsBeforeCollapse);
  win.setMinimumSize(460, 110); // 还原迷你模式最小尺寸
  return { ok: true };
});

  ipcMain.handle('dialog:pickDir', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择文件夹',
      defaultPath: current || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- 文字欢迎屏 ----------
  ipcMain.handle('welcome:state', () => ({ open: welcomeWindow.isOpen() }));
  ipcMain.handle('welcome:pickLogo', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 LOGO（PNG，透明底最佳）',
      properties: ['openFile'],
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const dir = path.join(app.getPath('userData'), 'welcome-assets');
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, 'logo.png');
    fs.copyFileSync(r.filePaths[0], dst);
    return { ok: true, path: dst };
  });
  ipcMain.handle('welcome:toggle', (_e, params) => {
    if (welcomeWindow.isOpen()) {
      welcomeWindow.close();
      broadcast('welcome:state', { open: false });
      return { ok: true, open: false };
    }
    const cfg = config.get().welcome || {};
    const bgIdx = Number((params && params.bg) || cfg.bg || 1);
    const logo = (cfg.logo && typeof cfg.logo === 'object') ? cfg.logo : { path: '', pos: 'tl' };
    welcomeWindow.open({
      text: String((params && params.text) ?? cfg.text ?? ''),
      sub: String((params && params.sub) ?? cfg.sub ?? ''),
      bg: bgIdx,
      style: Number((params && params.style) || cfg.style || 1),
      font: Number((params && params.font) || cfg.font || 1),
      logoPath: String((params && params.logoPath) ?? logo.path ?? ''),
      logoPos: String((params && params.logoPos) ?? logo.pos ?? 'tl'),
      bgpath: path.join(getResourcesPath(), 'welcome-bg', welcomeBgFile(bgIdx)),
    });
    broadcast('welcome:state', { open: true });
    return { ok: true, open: true };
  });

  // ---------- 无线同屏 ----------
  ipcMain.handle('cast:toggle', async () => {
    if (castServer.running()) { await stopCast(); return { ok: true, running: false }; }
    // 投影屏互斥（此前方向不对称：playVideoFile 会拦「PPT 放映中」，开同屏却不拦）：
    // PPT 与同屏都要独占投影屏，放任不管就是两个全屏窗叠在同一块屏上，谁盖谁全看窗口顺序。
    if (pptController.getState().presenting || sm.mode === 'ppt') {
      toast('PPT 正在放映，请先退出放映再开启无线同屏', 'warn');
      return { ok: false, error: 'ppt-presenting' };
    }
    // 本地视频同样占着投影屏：起同屏前先收掉（含音乐恢复），否则视频与同屏画面互相覆盖
    if (videoWindow.isPlaying()) {
      toast('已停止本地视频投放，投影屏交给无线同屏', 'warn');
      videoWindow.stop();
      sm.mode = 'idle';
      broadcast('video:state', videoWindow.current());
      if (config.get().exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
    }
    const r = await castServer.start((ev) => broadcast('cast:status', { event: ev }));
    if (!r.ok) { broadcast('cast:status', { event: r.error === 'aborted' ? 'stopped' : 'port-busy' }); return r; }
    const inline = config.get().displayMode === 'led'; // LED 模式在面板内联播放，不再开窗口
    if (!inline) castWindow.open(r.port, r.token);
    peer.startBeacon(r.port);                    // 被控端上线：向局域网广播可遥控信标
    broadcast('cast:state', { running: true, url: r.url, inline, token: r.token });
    return { ok: true, running: true, url: r.url, inline, token: r.token };
  });
  ipcMain.handle('cast:state', () => castServer.current());

  // ---------- 遥控另一台电脑（控制端） ----------
  // 设备发现走 UDP 信标（peer.js）；命令/状态走 peerClient 的 HTTP，打到被控端 castServer
  ipcMain.handle('peer:scanStart', () => {
    peer.startScan((peers) => broadcast('peer:list', peers));
    broadcast('peer:list', []);
    return { ok: true };
  });
  ipcMain.handle('peer:scanStop', () => {
    peer.stopScan();
    broadcast('peer:list', []);
    return { ok: true };
  });
  ipcMain.handle('peer:connect', async (_e, { ip, port, name }) => {
    const r = await peerClient.connect(ip, port, name);
    if (r.ok) broadcast('peer:connected', { name: r.name, ip: r.ip, port: r.port });
    return r;
  });
  ipcMain.handle('peer:disconnect', () => { peerClient.disconnect(); return { ok: true }; });
  ipcMain.handle('peer:session', () => peerClient.current());
  ipcMain.handle('peer:state', () => peerClient.state());
  ipcMain.handle('peer:cmd', (_e, { target, cmd, page }) => peerClient.cmd(target, cmd, page));

  // ---------- 课堂计时器 ----------
  ipcMain.handle('timer:start', (_e, { mode, duration }) => { timer.start(mode || 'countdown', Number(duration) || 0); return timer.current(); });
  ipcMain.handle('timer:toggle', () => timer.togglePause());
  ipcMain.handle('timer:reset', () => timer.reset());
  ipcMain.handle('timer:toggleShow', () => timer.toggleShow());
  ipcMain.handle('timer:winFullscreen', () => { timer.toggleFullscreen(); return { ok: true }; });
  ipcMain.handle('timer:state', () => timer.current());

}

// ---------- 生命周期 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    // 品牌资产首验：密钥缺失或密文被篡改即拒绝启动（防删除/防篡改耦合）
    try {
      brandm = brand.unlock();
    } catch (e) {
      const { dialog: d } = require('electron');
      d.showErrorBox('启动失败', `品牌资产校验失败，程序无法启动。${String(e && (e.code || e.message || e))}`);
      app.exit(1);
      return;
    }
    config.load();
    config.save({}); // 落盘默认配置
    // 开机自启（GAP-02）：按配置同步系统登录项；开发态/Linux 可能不支持，失败静默
    try { app.setLoginItemSettings({ openAtLogin: !!config.get().autoLaunch }); } catch { }
    // 重启后恢复"当前课件"，保证 Ctrl+Alt+P 一按就能放映上次课件
    lastPptFile = (config.get().recentPpt || [])[0] || '';
    videoWindow.init(() => {
      sm.mode = pptController.getState().presenting ? 'ppt' : 'idle';
      broadcast('video:state', videoWindow.current());
      if (config.get().exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
    }, (p) => {
      // 播放窗的进度回报 → 控制面板进度条（视频在投影屏上，面板上是唯一能看到进度的地方）
      broadcast('video:progress', p);
    }, (v) => {
      // 图片翻页 / 自动轮播状态变化 → 面板同步（当前第几张、轮播开关）
      broadcast('video:state', v);
    });
    timer.init(broadcast); // 计时器 250ms 广播依赖此句柄
    floatBar.init(onHotkeyAction); // 悬浮条音乐按钮转发播放/暂停
    welcomeWindow.init(() => broadcast('welcome:state', { open: false })); // 用户按 Esc 关窗回调
    castWindow.init(() => {
      // 同屏接收窗被用户 ESC/✕ 关掉：走统一收尾（bye + stop + 关窗 + 撤信标 + 状态复位）
      if (!castServer.running()) return;
      teardownCast().catch(() => { });
    });
    createWindow();
    createTray();
    hotkeyConflicts = hotkeys.registerAll(onHotkeyAction);
    registerIpc();
    if (!IS_MAC) pptServer.warmup(); // 预热常驻 PowerShell（只热 ctl 通道，thumb 按需冷启动，省 ~80MB，GAP-07）

    // PPT 放映统一轮询（PERF-10 自适应退避）：一次 presenter 调用拿页码/备注/缩略图
    // （thumb 通道，不阻塞翻页），内容有变化才广播（面板不重复重绘）；老师手动关放映时自动复位。
    // 旧版 5s 状态 + 2s 页码两条通道各查一次 COM，现已合并为一条；本版再加退避：
    // 翻页后 400ms 快补一轮（胶片/备注立刻跟上），静止期放宽到 6s（原 4s），
    // 慢机空闲 COM 占用再降 33%——4s 间隔对老一体机仍嫌频繁。
    let presenterPollTimer = null;
    const presenterPoll = async () => {
      if (!pptController.getState().presenting) { schedulePresenterPoll(2000); return; }
      assertAlwaysOnTop(); // 放映期间持续把置顶面板压回 PPT 全屏之上（内部 2s 节流，不追翻页频率）
      const before = pptLastPos;
      const full = await pollPresenter();
      // 页码变了：遥控器/键盘翻页也算一次翻页，记入静默期（随后 600ms 内的轮询不导图）
      if (full && full.presenting && pptLastPos !== before) noteFlip();
      // 刚翻过页或刚补过图：400ms 内再确认一轮（胶片/备注立刻跟上）；静止期放宽到 6s
      const active = full ? (pptLastPos !== before || (full.exported || 0) > 0) : pptLastPos !== before;
      schedulePresenterPoll(active ? 400 : 6000);
    };
    function schedulePresenterPoll(delayMs) {
      clearTimeout(presenterPollTimer);
      presenterPollTimer = setTimeout(presenterPoll, delayMs);
    }
    schedulePresenterPoll(2000);

    if (isSmoke) {
      setTimeout(() => { console.log('SMOKE_OK'); app.exit(0); }, 2500);
    }
  });

  app.on('window-all-closed', () => {
    if (quitting) app.quit(); // 否则保持托盘常驻
  });

  // 任何退出路径（托盘退出、IPC 退出、系统关机注销等）都先清场再放行
  app.on('before-quit', (e) => {
    if (!quitting) {
      e.preventDefault();
      quitApp();
    }
  });
}
