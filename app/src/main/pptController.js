const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { isMac } = require('./platform');

// 定位控制脚本（开发态在 app/resources/，打包态在 extraResources 的 resources/）
// Windows 用 PowerShell + COM（ppt-control.ps1）；macOS 用 osascript + AppleScript（ppt-control.applescript）
function resolveControlScript() {
  const name = isMac ? 'ppt-control.applescript' : 'ppt-control.ps1';
  const { getResourcesPath } = require('./paths');
  return path.join(getResourcesPath(), name);
}

function runCtl(action, params = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let cmd, args;
    if (isMac) {
      cmd = 'osascript';
      args = [
        resolveControlScript(),
        action,
        params.path || '',
        params.close === false ? 'false' : 'true',
        params.exportDir || '',
      ];
    } else {
      cmd = 'powershell.exe';
      args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', resolveControlScript(),
        '-Action', action,
        '-ProgId', params.progId || '',
        '-Path', params.path || '',
        '-Close', params.close === false ? 'false' : 'true',
        '-ExportDir', params.exportDir || '',
      ];
    }
    let out = '', settled = false;
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: 'spawn-failed', detail: String(err) }); }
    });
    child.on('close', () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { resolve(JSON.parse(line)); }
      catch { resolve({ ok: false, error: 'parse-error', detail: out.slice(-300) }); }
    });
  });
}

// ---------- 状态 ----------
let state = { presenting: false, file: '', progId: '' };

function getState() {
  return { ...state };
}

// 正式放映：Windows 走 COM（失败降级 POWERPNT /S）；macOS 走 AppleScript（无降级）
async function present(file, preferProgId, forceExtend = false) {
  const result = await runCtl('start', { progId: preferProgId || '', path: file }, 15000);
  if (result.ok) {
    state = { presenting: true, file, progId: result.progId || preferProgId || '' };
    return { ok: true, mode: isMac ? 'applescript' : 'com', state: getState() };
  }
  if (!isMac && result.error === 'no-office-com') {
    const ok = await fallbackStart(file);
    if (ok) {
      state = { presenting: true, file, progId: 'fallback' };
      return { ok: true, mode: 'fallback', state: getState() };
    }
  }
  return { ok: false, error: result.error || 'unknown', detail: result.detail, state: getState() };
}

// 兜底（仅 Windows）：POWERPNT.EXE /S 文件 —— 直接以放映模式打开
async function fallbackStart(file) {
  const exe = await findPowerpnt();
  // 注册表返回值不可全信：只接受磁盘上真实存在、文件名确为 POWERPNT.EXE 的路径
  if (typeof exe !== 'string' || !/\\POWERPNT\.EXE$/i.test(exe.trim()) || !fs.existsSync(exe.trim())) return false;
  try {
    spawn(exe.trim(), ['/S', file], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  } catch { return false; }
}

function findPowerpnt() {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\powerpnt.exe', '/ve'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).match(/REG_SZ\s+(.+)/);
      resolve(m ? m[1].trim() : null);
    });
  });
}

// 退出放映：脚本 Exit(+Quit)；兜底发 ESC
async function exitPresent(closePowerpoint = true) {
  const wasFallback = state.progId === 'fallback';
  const result = await runCtl('exit', { progId: state.progId, close: closePowerpoint }, 8000);
  if (!result.ok || wasFallback) {
    await sendEsc();
  }
  state = { presenting: false, file: '', progId: '' };
  return { ok: true, wasPresenting: result.wasPresenting !== false, mode: wasFallback ? 'fallback' : (isMac ? 'applescript' : 'com') };
}

// 同步真实状态（老师手动关了 PPT 时自动复位）；ctlOk 反映脚本通路是否健康
async function syncStatus() {
  const result = await runCtl('status', {}, 6000);
  if (result.ok) {
    state = { presenting: !!result.presenting, file: result.file || state.file, progId: state.progId };
  }
  return { ...getState(), psOk: !!result.ok, psError: result.ok ? null : result.error };
}

// 兜底退出：把放映窗口带到前台并发 ESC
// Windows 用 WScript.Shell AppActivate + SendKeys；macOS 用 System Events key code 53（需辅助功能权限，失败则静默）
function sendEsc() {
  if (isMac) {
    return new Promise((resolve) => {
      const script = 'tell application "System Events" to key code 53';
      const child = spawn('osascript', ['-e', script], { windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 4000);
      child.on('close', () => { clearTimeout(timer); resolve(true); });
      child.on('error', () => { clearTimeout(timer); resolve(false); });
    });
  }
  return new Promise((resolve) => {
    const ps = `$ws = New-Object -ComObject WScript.Shell; if ($ws.AppActivate('幻灯片放映')) { Start-Sleep -Milliseconds 200; $ws.SendKeys('{ESC}') }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 4000);
    child.on('close', () => { clearTimeout(timer); resolve(true); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

module.exports = { present, exitPresent, syncStatus, getState, nextSlide, prevSlide, pageInfo, presenterInfo };

// 翻页：脚本直接驱动放映视图，无需抢焦点
async function nextSlide() { return runCtl('next', { progId: state.progId }, 6000); }
async function prevSlide() { return runCtl('prev', { progId: state.progId }, 6000); }
async function pageInfo() { return runCtl('pageinfo', { progId: state.progId }, 6000); }

// 演讲者信息：Windows 导出当前/下一页缩略图 + 备注；macOS V1 仅页码与备注（缩略图字段返回空串）
async function presenterInfo(exportDir) { return runCtl('presenter', { progId: state.progId, exportDir }, 12000); }
