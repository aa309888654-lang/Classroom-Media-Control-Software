/*
 * 渲染层真实配置回归检查（手工运行，不入 npm test 的 node --test glob，需 electron）：
 *   npx electron tests/renderer-check.js
 * 读取本机真实 config.json 作为 app:getInit 返回，加载 index.html，
 * 覆盖：循环下拉菜单 / 进度条拖动 / 曲目双击播放 / 删除课件确认流程 / 退出投屏按钮隐藏。
 * 捕获渲染进程抛错/控制台 error 即非零退出。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failed = 0;
const log = (...a) => console.log('[rc]', ...a);

const cfgPath = path.join(os.homedir(), 'AppData', 'Roaming', '小天AIGC', 'config.json');
let realCfg = null;
try { realCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); log('载入真实配置:', cfgPath); }
catch (e) { log('读真实配置失败，回退最小桩:', String(e)); }

const STUB_INIT = {
  platform: process.platform,
  version: '2026.9.22',
  config: realCfg || {
    musicDir: '', videoDir: '', pptDir: '', builtinMusicEnabled: false,
    volume: 0.7, crossfadeSeconds: 2, playPauseFadeSeconds: 0.5,
    loopMode: 'list', uiDensity: 'compact', displayMode: 'control',
    catOrder: [], catShowLimit: 3, catPinned: {}, catTrackOrder: {},
    sectionOrder: [], recentPpt: [], recentVideo: [], pptOrder: [], videoOrder: [],
    hotkeysVer: 7, hotkeys: {}, welcome: { bg: 1, style: 1, font: 1, logo: {} },
    exitAction: { restoreMusic: true, closePowerpoint: false },
  },
  // 给一个测试分类+假曲目，供曲目行双击回归
  music: [{ category: '测试', builtin: false, tracks: ['C:/fake/track-A.mp3', 'C:/fake/track-B.mp3'] }],
  videos: [], ppts: [{ file: 'C:/fake/课件.pptx', name: '课件.pptx', size: 0, mtimeMs: 0 }], displays: [], office: null,
  ppt: { presenting: false }, video: { playing: false },
  hotkeyConflicts: [],
};
const deleteResult = { ok: true, music: STUB_INIT.music, videos: [], ppts: [] };
ipcMain.handle('app:getInit', () => STUB_INIT);
ipcMain.handle('config:save', () => STUB_INIT.config);
ipcMain.handle('music:setState', () => ({ ok: true }));
ipcMain.handle('cast:state', () => ({ running: false }));
ipcMain.handle('library:deleteFile', (_e, { kind, file }) => { log('  [主进程桩] library:deleteFile', kind, file); return deleteResult; });
ipcMain.handle('ppt:preopen', () => ({ ok: true }));
ipcMain.handle('ppt:exportAll', () => ({ ok: true, total: 0, cached: true }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, '..', 'src', 'preload', 'bridge.js'),
    contextIsolation: true, nodeIntegration: false,
  }});
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on('render-process-gone', (_e, d) => { log('GONE', JSON.stringify(d)); failed++; });

  try { await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html')); }
  catch (e) { log('load fail', String(e)); app.exit(1); return; }
  await new Promise((res) => setTimeout(res, 900));

  const r = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    out.displayMode = document.body.classList.contains('led-mode') ? 'led' : 'control';
    out.stateReady = typeof state !== 'undefined' && !!state.config;

    // ① 循环下拉菜单
    out.hasBtnLoop = !!document.getElementById('btnLoop');
    out.btnLoopText = (document.getElementById('btnLoop').textContent || '').trim();
    if (typeof openLoopMenu === 'function') {
      openLoopMenu();
      out.menuItems = document.querySelectorAll('.loop-menu-item').length;
      out.menuActive = (document.querySelector('.loop-menu-item.on')||{}).dataset ? document.querySelector('.loop-menu-item.on').dataset.mode : null;
      const it2 = document.querySelectorAll('.loop-menu-item')[1];
      if (it2) it2.click();
      out.afterClickBtnText = (document.getElementById('btnLoop').textContent || '').trim();
      out.afterClickLoopMode = (typeof engine !== 'undefined') ? engine.loopMode : null;
      closeLoopMenu();
      out.menuClosed = !document.querySelector('.loop-menu');
    }

    // ② 进度条拖动：注入假音频元素，模拟 pointerdown/move/up，断言 fill 宽度跟随 + currentTime 被设
    if (typeof engine !== 'undefined') {
      engine.active = 0; engine.idx = 0;
      engine.channels[0] = { el: { duration: 100, currentTime: 0 } };
      const prog = document.getElementById('npProgress');
      prog.style.display = 'block';
      const rect = prog.getBoundingClientRect();
      const fire = (type, x) => prog.dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true }));
      fire('pointerdown', rect.left + rect.width * 0.5);
      out.progFillAt50 = document.getElementById('npFill').style.width;
      out.progCurrentAt50 = engine.channels[0].el.currentTime;
      fire('pointermove', rect.left + rect.width * 0.75);
      out.progFillAt75 = document.getElementById('npFill').style.width;
      fire('pointerup', rect.left + rect.width * 0.75);
      out.progDraggingClassGone = !prog.classList.contains('dragging');
    }

    // ③ 曲目双击播放：渲染测试分类的曲目行，断言行有 dblclick、无 onclick 播放
    if (typeof renderTrackList === 'function' && typeof selCatView !== 'undefined') {
      selCatView = '测试'; renderTrackList();
      const row = document.querySelector('#catCards .cat-track');
      out.trackRowExists = !!row;
      if (row) {
        out.rowHasDblclick = !!row.ondblclick;
        out.rowHasNoOnclickPlay = !row.onclick; // 单击不再播放
        let played = false;
        const orig = engine.playTrack; engine.playTrack = () => { played = true; };
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        out.dblclickTriggeredPlay = played;
        engine.playTrack = orig;
      }
    }

    // ④ 删除课件确认流程：打开确认弹层 → 点删除 → 调 library:deleteFile
    if (typeof confirmDeleteFile === 'function') {
      confirmDeleteFile('ppt', 'C:/fake/课件.pptx', '课件.pptx');
      out.confirmOpen = !document.getElementById('confirmOverlay').hidden;
      document.getElementById('btnConfirmOk').click();
      await new Promise(r => setTimeout(r, 50));
      out.confirmClosed = document.getElementById('confirmOverlay').hidden;
    }

    // ⑤ 退出投屏按钮：未放映时隐藏
    out.btnExitHidden = document.getElementById('btnExitPresent').hidden;
    return out;
  })()`).catch((e) => { log('exec fail', String(e)); failed++; return null; });

  log('probe', JSON.stringify(r));
  if (errors.length) { log('渲染进程报错:'); errors.forEach((m) => log('  ERR', m)); failed++; }

  if (r) {
    if (!r.stateReady) failed++;
    if (!r.hasBtnLoop || r.btnLoopText.indexOf('列表') === -1) failed++;
    if (r.menuItems !== 3 || r.menuActive !== 'list') failed++;
    if (r.afterClickBtnText.indexOf('单曲') === -1 || r.afterClickLoopMode !== 'single') failed++;
    if (!r.menuClosed) failed++;
    if (r.progFillAt50 !== '50%' || Math.abs(r.progCurrentAt50 - 50) > 0.5) failed++;
    if (r.progFillAt75 !== '75%') failed++;
    if (!r.progDraggingClassGone) failed++;
    if (!r.trackRowExists || !r.rowHasDblclick || !r.rowHasNoOnclickPlay || !r.dblclickTriggeredPlay) failed++;
    if (!r.confirmOpen || !r.confirmClosed) failed++;
    if (!r.btnExitHidden) failed++;
  } else failed++;

  log('RESULT failed=' + failed);
  app.exit(failed ? 1 : 0);
});
