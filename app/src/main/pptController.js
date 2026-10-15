const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { isMac } = require('./platform');
const pptServer = require('./pptServer');

// 定位控制脚本（开发态在 app/resources/，打包态在 extraResources 的 resources/）
// Windows 用 PowerShell + COM（ppt-control.ps1）；macOS 用 osascript + AppleScript（ppt-control.applescript）
function resolveControlScript() {
  const name = isMac ? 'ppt-control.applescript' : 'ppt-control.ps1';
  const { getResourcesPath } = require('./paths');
  return path.join(getResourcesPath(), name);
}

// Windows 优先走常驻 PowerShell 服务（免每次冷启动，Esc 退出等操作从 ~1.5s 降到 ~0.1s）；
// 服务不可用/超时（exec 返回 null）→ 回退一次性 spawn 模式。
// channel='thumb' 走独立常驻进程：导缩略图慢（单张可达秒级），不能排在翻页命令前面堵住控制
function runCtl(action, params = {}, timeoutMs = 10000, channel = 'ctl') {
  if (isMac) return spawnCtl(action, params, timeoutMs);
  return pptServer.exec(action, params, Math.max(4000, timeoutMs), channel).then((r) => {
    if (r) return r;
    return spawnCtl(action, params, timeoutMs);
  });
}

function spawnCtl(action, params = {}, timeoutMs = 10000) {
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
        '-Page', String(params.page || 0),
        '-NoExport', params.noexport ? 'true' : '',
      ];
    }
    let out = '', settled = false;
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill(); } catch { } resolve({ ok: false, error: 'timeout' }); }
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
    // 多标题匹配（兼容中文/英文 Office 与 WPS），失败再按进程 PID 激活；
    // 连发两次 Esc：第一次退全屏放映，第二次兜底消费可能的弹窗
    const ps = `
$ws = New-Object -ComObject WScript.Shell
$ok = $false
foreach ($t in @('幻灯片放映','Slide Show','演示文稿','PowerPoint','WPS')) {
  if ($ws.AppActivate($t)) { $ok = $true; break }
}
if (-not $ok) {
  foreach ($pn in @('POWERPNT','wpp','wps')) {
    $p = Get-Process -Name $pn -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { [void]$ws.AppActivate($p.Id); $ok = $true; break }
  }
}
if ($ok) {
  Start-Sleep -Milliseconds 250
  $ws.SendKeys('{ESC}')
  Start-Sleep -Milliseconds 150
  $ws.SendKeys('{ESC}')
}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 6000);
    child.on('close', () => { clearTimeout(timer); resolve(true); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

module.exports = { present, exitPresent, syncStatus, getState, nextSlide, prevSlide, gotoSlide, pageInfo, presenterInfo, runCtl };

// 翻页：脚本直接驱动放映视图，无需抢焦点
async function nextSlide() { return runCtl('next', { progId: state.progId }, 6000); }
async function prevSlide() { return runCtl('prev', { progId: state.progId }, 6000); }

// 跳转到任意页（演讲者条缩略图点击）；Mac AppleScript 未实现该动作
async function gotoSlide(page) {
  if (isMac) return { ok: false, error: 'unsupported' };
  return runCtl('goto', { progId: state.progId, page }, 6000);
}
async function pageInfo() { return runCtl('pageinfo', { progId: state.progId }, 6000); }

// 演讲者信息：Windows 导出当前/下一页缩略图 + 备注；macOS V1 仅页码与备注（缩略图字段返回空串）
// 走 thumb 通道：导图慢，与翻页命令物理隔离，互不阻塞
// opts.noexport：只读已缓存缩略图、不现场导图（翻页进行中保 PowerPoint 主线程，PERF-12）
async function presenterInfo(exportDir, opts = {}) {
  return runCtl('presenter', { progId: state.progId, exportDir, noexport: !!opts.noexport }, 15000, 'thumb');
}
