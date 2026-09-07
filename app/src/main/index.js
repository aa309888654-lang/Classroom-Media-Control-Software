const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, screen, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// setAppUserModelId 仅 Windows 有意义（任务栏/通知归属），macOS 无此概念
if (process.platform === 'win32') app.setAppUserModelId('com.xiaotian.aigc');

const IS_MAC = process.platform === 'darwin';

const config = require('./config');
const displays = require('./displays');
const officeDetector = require('./officeDetector');
const pptController = require('./pptController');
const library = require('./library');
const hotkeys = require('./hotkeys');
const videoWindow = require('./videoWindow');
const timer = require('./timer');
const castServer = require('./castServer');
const castWindow = require('./castWindow');
const brand = require('./brand');
const welcomeWindow = require('./welcomeWindow');
const { getResourcesPath } = require('./paths');

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

const sm = { mode: 'idle' }; // idle | ppt | video

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(text, type = 'info') {
  broadcast('toast', { text, type });
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

async function presentPpt(file) {
  if (!file) {
    toast('请先选择要放映的课件', 'warn');
    return { ok: false, error: 'no-file' };
  }
  if (videoWindow.isPlaying()) videoWindow.stop(true);
  // 切扩展模式是 Windows 专属能力（DisplaySwitch）；macOS 外接默认即扩展，LED 单屏模式下也无意义
  if (!IS_MAC && config.get().display.forceExtendOnPresent && config.get().displayMode !== 'led') displays.extendMode();
  broadcast('ppt:state', { presenting: true, file, loading: true });
  // 放映前让音乐淡出（通知渲染进程）
  broadcast('music:restore', { action: 'duck' });
  const office = await officeDetector.detect();
  const seq = ++presentSeq;
  const result = await pptController.present(file, office.progId);
  if (seq !== presentSeq) {
    // 放映期间用户点了「退出投屏」：把刚打开的收掉，不覆盖退出后的状态
    if (result.ok) await pptController.exitPresent(config.get().exitAction.closePowerpoint);
    return result;
  }
  sm.mode = result.ok ? 'ppt' : 'idle';
  broadcast('ppt:state', { presenting: result.ok, file, loading: false, error: result.ok ? null : result.error });
  if (!result.ok) toast(`放映失败：${PPT_ERRORS[result.error] || result.error}`, 'error');
  return result;
}

async function exitPresent() {
  presentSeq++; // 使进行中的放映结果失效
  const cfg = config.get();
  const res = await pptController.exitPresent(cfg.exitAction.closePowerpoint);
  sm.mode = 'idle';
  broadcast('ppt:state', { presenting: false, file: '', loading: false });
  if (cfg.exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
  return res;
}

function forwardHotkey(action) {
  broadcast('hotkey', action);
}

function onHotkeyAction(action) {
  if (action === 'present') { presentPpt(lastPptFile); return; }
  if (action === 'exitPresent') { exitPresent(); return; }
  if (action === 'timerToggle') { timer.togglePause(); return; }
  if (action === 'timerReset') { timer.reset(); return; }
  broadcast('hotkey', action);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('app:getInit', async () => {
    const office = await officeDetector.detect();
    return {
      config: config.get(),
      music: library.scanMusic(),
      videos: library.scanVideos(),
      ppts: library.scanPpts(),
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

  ipcMain.handle('config:save', (_e, patch) => config.save(patch));

  ipcMain.handle('library:scan', () => ({ music: library.scanMusic(), videos: library.scanVideos(), ppts: library.scanPpts() }));

  // 自定义音乐分类：添加（建文件夹）/ 删除（文件夹入回收站，可找回）
  const CAT_NAME_RE = /^[^\\/:*?"<>|]{1,30}$/;
  ipcMain.handle('music:addCategory', (_e, name) => {
    name = String(name || '').trim();
    if (!CAT_NAME_RE.test(name)) return { ok: false, error: 'bad-name' };
    const dir = config.get().musicDir;
    const target = path.join(dir, name);
    if (fs.existsSync(target)) return { ok: false, error: 'exists' };
    try {
      fs.mkdirSync(target, { recursive: true });
      return { ok: true, music: library.scanMusic() };
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
      return { ok: true, music: library.scanMusic() };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  // 导入音乐到指定分类：弹文件选择 → 复制进用户音乐文件夹（长期保存），重名自动加 (n)
  ipcMain.handle('music:import', async (_e, category) => {
    category = String(category || '').trim();
    if (!CAT_NAME_RE.test(category)) return { ok: false, error: 'bad-name' };
    const AUDIO = ['.mp3', '.wav', '.m4a', '.ogg', '.flac'];
    const r = await dialog.showOpenDialog(win, {
      title: `导入音乐到「${category}」`,
      filters: [{ name: '音频文件', extensions: AUDIO.map((x) => x.slice(1)) }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const dir = path.join(config.get().musicDir, category);
    fs.mkdirSync(dir, { recursive: true });
    let imported = 0;
    for (const src of r.filePaths) {
      const ext = path.extname(src).toLowerCase();
      if (!AUDIO.includes(ext)) continue;
      const base = path.basename(src);
      const stem = base.slice(0, -ext.length);
      let dest = path.join(dir, base);
      let k = 1;
      while (fs.existsSync(dest)) dest = path.join(dir, `${stem} (${k++})${ext}`);
      try { fs.copyFileSync(src, dest); imported++; } catch { }
    }
    return { ok: true, imported, music: library.scanMusic() };
  });

  ipcMain.handle('displays:list', () => displays.listDisplays());
  // 一键扩展模式是 Windows 能力；Mac 上外接默认扩展，直接返回成功（面板在 Mac 不展示该按钮）
  ipcMain.handle('displays:extend', () => (IS_MAC ? { ok: true, noop: 'mac-default-extend' } : { ok: displays.extendMode() }));
  screen.on('display-removed', () => {
    // 投影线被拔掉：视频/计时/同屏/欢迎窗口都不能再留在不存在的显示器上
    timer.closeWindow();
    castWindow.close();
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
      filters: [{ name: '演示文稿', extensions: ['pptx', 'ppt', 'ppsx'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    lastPptFile = r.filePaths[0];
    library.pushRecent('ppt', lastPptFile);
    return lastPptFile;
  });
  ipcMain.handle('ppt:present', (_e, file) => {
    if (file) lastPptFile = file;
    return presentPpt(lastPptFile);
  });
  ipcMain.handle('ppt:exit', () => exitPresent());
  ipcMain.handle('ppt:status', () => pptController.syncStatus());
  ipcMain.handle('ppt:next', async () => {
    const r = await pptController.nextSlide();
    if (r.ok) broadcast('ppt:presenter', { ok: true, presenting: true, position: r.position, total: r.total, notes: '', nextNotes: '', curImg: '', nextImg: '' });
    return r;
  });
  ipcMain.handle('ppt:prev', async () => {
    const r = await pptController.prevSlide();
    if (r.ok) broadcast('ppt:presenter', { ok: true, presenting: true, position: r.position, total: r.total, notes: '', nextNotes: '', curImg: '', nextImg: '' });
    return r;
  });

  ipcMain.handle('video:openDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择视频',
      defaultPath: config.get().videoDir || undefined,
      filters: [{ name: '视频', extensions: ['mp4', 'webm', 'm4v'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    library.pushRecent('video', r.filePaths[0]);
    return r.filePaths[0];
  });
  ipcMain.handle('video:play', (_e, file) => {
    if (!file || !fs.existsSync(file)) {
      toast('找不到视频文件（U 盘拔了？）', 'error');
      return { ok: false, error: 'file-not-found' };
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
        broadcast('music:restore', { action: 'duck' });
        broadcast('video:load', { file });
        broadcast('video:state', videoWindow.current());
      }
      return r;
    }
    const r = videoWindow.play(file);
    if (r.ok) {
      sm.mode = 'video';
      broadcast('music:restore', { action: 'duck' });
      broadcast('video:state', videoWindow.current());
    }
    return r;
  });
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
    if (ledMode) broadcast('video:control', cmd);
    else videoWindow.control(cmd);
    return { ok: true };
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

  ipcMain.handle('hotkey:remap', (_e, { action, accelerator }) => {
    const r = hotkeys.remap(action, accelerator, onHotkeyAction);
    hotkeyConflicts = hotkeyConflicts.filter((c) => c.action !== action);
    return r;
  });
  ipcMain.handle('hotkey:conflicts', () => hotkeyConflicts);

  ipcMain.handle('window:toggleAlwaysOnTop', () => {
    alwaysOnTop = !alwaysOnTop;
    win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
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
  ipcMain.handle('window:miniMode', (_e, on) => {
    if (!win) return { ok: false };
    if (on) {
      if (!config.get().miniMode) config.save({ windowBounds: win.getBounds() }); // 先存正常尺寸
      if (win.isMaximized() || win.isFullScreen()) { win.setFullScreen(false); win.unmaximize(); } // 最大化/全屏下 setBounds 无效
      win.setMinimumSize(460, 110);
      win.setAlwaysOnTop(true, 'screen-saver'); // 置顶级拉高，保证浮在欢迎屏/视频全屏窗之上
      const mb = config.get().miniBounds;
      if (mb && isBoundsVisible(mb)) win.setBounds(mb); else win.setSize(540, 132);
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
  const stopCast = async () => {
    try { castServer.bye(); } catch { }          // 通知发送端释放共享
    castWindow.close();
    castServer.stop();
    broadcast('cast:state', { running: false });
  };
  ipcMain.handle('cast:toggle', async () => {
    if (castServer.running()) { await stopCast(); return { ok: true, running: false }; }
    const r = await castServer.start((ev) => broadcast('cast:status', { event: ev }));
    if (!r.ok) { broadcast('cast:status', { event: 'port-busy' }); return r; }
    const inline = config.get().displayMode === 'led'; // LED 模式在面板内联播放，不再开窗口
    if (!inline) castWindow.open(r.port);
    broadcast('cast:state', { running: true, url: r.url, inline });
    return { ok: true, running: true, url: r.url, inline };
  });
  ipcMain.handle('cast:state', () => castServer.current());

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
    // 重启后恢复"当前课件"，保证 Ctrl+Alt+P 一按就能放映上次课件
    lastPptFile = (config.get().recentPpt || [])[0] || '';
    videoWindow.init(() => {
      sm.mode = pptController.getState().presenting ? 'ppt' : 'idle';
      broadcast('video:state', videoWindow.current());
      if (config.get().exitAction.restoreMusic) broadcast('music:restore', { action: 'restore' });
    });
    timer.init(broadcast); // 计时器 250ms 广播依赖此句柄
    welcomeWindow.init(() => broadcast('welcome:state', { open: false })); // 用户按 Esc 关窗回调
    castWindow.init(() => {
      // 同屏接收窗被用户 ESC/✕ 关掉：做完整收尾（通知发送端 + 停信令 + 面板状态复位）
      if (!castServer.running()) return;
      try { castServer.bye(); } catch { }
      try { castServer.stop(); } catch { }
      broadcast('cast:state', { running: false });
    });
    createWindow();
    createTray();
    hotkeyConflicts = hotkeys.registerAll(onHotkeyAction);
    registerIpc();

    // PPT 状态轮询：老师手动关掉放映/PowerPoint 时，面板 5 秒内自动复位
    setInterval(async () => {
      if (!pptController.getState().presenting) return;
      const before = pptController.getState().presenting;
      const s = await pptController.syncStatus();
      if (before && !s.presenting) {
        sm.mode = 'idle';
        broadcast('ppt:state', { presenting: false, file: '', loading: false });
      }
    }, 5000);

    // 演讲者视图轮询：放映中每 2 秒查页码，翻页才做缩略图导出（贵操作）
    let lastPos = 0;
    const exportDir = path.join(app.getPath('temp'), 'xiaotian-aigc-ppt');
    // 缩略图导出目录必须存在，否则 PS 脚本里的 Test-Path 为假、静默跳过导出
    try { fs.mkdirSync(exportDir, { recursive: true }); } catch { }
    setInterval(async () => {
      if (!pptController.getState().presenting) { lastPos = 0; return; }
      const info = await pptController.pageInfo();
      if (!info.ok || !info.presenting) return;
      if (info.position !== lastPos) {
        lastPos = info.position;
        const full = await pptController.presenterInfo(exportDir);
        if (full.ok && full.presenting) broadcast('ppt:presenter', full);
      }
    }, 2000);

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
