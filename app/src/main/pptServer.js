// 常驻 PowerShell COM 服务：避免每次 PPT 操作都冷启动 powershell.exe（0.5~1.5s）。
// stdin 每行一个 JSON 请求，stdout 每行一个 JSON 应答（见 resources/ppt-control.ps1 的 -server 模式）。
// 进程崩溃/超时自动重启；不可用时 exec 返回 null，调用方回退到一次性 spawn 模式。
//
// 双通道设计：PowerShell 是单线程的，一个进程内的请求严格串行。
// 「presenter」动作要导出幻灯片缩略图（单张可达秒级），若与翻页同通道排队，
// 翻页会被一次导图卡住——这正是放映控制卡顿的主因。
// 因此拆两个独立进程：ctl=翻页/退出等短动作（要求低延迟），thumb=演讲者缩略图/备注（允许慢）。
const { spawn } = require('child_process');
const path = require('path');

const servers = { ctl: makeServer(), thumb: makeServer() };

function makeServer() {
  // starting：正在进行的启动 Promise，用于把并发启动串行化（BUG-02：原来并发会互杀进程）
  return { proc: null, ready: false, seq: 0, pending: new Map(), starting: null };
}

function scriptPath() {
  const { getResourcesPath } = require('./paths');
  return path.join(getResourcesPath(), 'ppt-control.ps1');
}

// 启动（或复用正在进行的启动）；ready 后 resolve(true)，失败 resolve(false)。
// BUG-02 修复要点：
//  1) starting 串行化。原实现在「进程在、但还没 ready」时会直接 kill 再重拉；
//     两个并发 exec 相遇时第二个把第一个刚拉起的进程杀掉 → 两个请求都永远拿不到应答。
//     现在同一次启动的 Promise 被复用，绝不互相杀进程。
//  2) exit 守卫。只在「退出的进程仍是当前进程」时才清理在途请求，陈旧退出不再误伤新进程。
//  3) 按行缓冲。原来按 chunk 切分，半行 JSON 会被静默丢弃。
function ensureProc(s) {
  if (s.proc && !s.proc.killed && s.ready) return Promise.resolve(true);
  if (s.starting) return s.starting;
  if (s.proc) { try { s.proc.kill(); } catch { } s.proc = null; }
  s.ready = false;
  const p = new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    let proc = null;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath(), '-Action', '-server',
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      s.proc = proc;
    } catch {
      s.proc = null;
      return done(false);
    }
    const readyTimer = setTimeout(() => {
      done(false);
      // 就绪超时：顺手收掉这个起不来的进程，避免它一直挂到下次调用才被判死
      if (s.proc === proc) { try { proc.kill(); } catch { } s.proc = null; }
    }, 5000);
    // stdout 必须按行缓冲：一次 data 事件可能只含半行 JSON，按 chunk 切分会直接解析失败被丢弃
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (!s.ready && line === 'SERVER_READY') {
          s.ready = true;
          clearTimeout(readyTimer);
          done(true);
          continue;
        }
        if (line.charAt(0) !== '{') continue;
        try {
          const msg = JSON.parse(line);
          const pend = s.pending.get(msg.seq);
          if (pend) {
            clearTimeout(pend.timer);
            s.pending.delete(msg.seq);
            pend.resolve(msg);
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    proc.on('exit', () => {
      clearTimeout(readyTimer);
      if (s.proc !== proc) return; // 已换成新进程：这次退出与当前实例无关，不再误杀在途请求（BUG-02）
      s.ready = false;
      // 所有在途请求以 null resolve（调用方回退 spawn）
      for (const [, p2] of s.pending) { clearTimeout(p2.timer); p2.resolve(null); }
      s.pending.clear();
      s.proc = null;
      done(false);
    });
    proc.on('error', () => {
      clearTimeout(readyTimer);
      if (s.proc === proc) { s.proc = null; } // spawn 失败：只判死本通道，下次 exec 再试（不禁用整个服务）
      done(false);
    });
  });
  s.starting = p;
  const clearStarting = () => { if (s.starting === p) s.starting = null; };
  p.then(clearStarting, clearStarting);
  return p;
}

// 执行一个动作；返回结果对象，服务不可用/超时返回 null（调用方回退一次性 spawn）
// channel: 'ctl'（翻页等短动作，超时会杀进程快速自愈）| 'thumb'（导图慢动作，给足超时）
async function exec(action, params = {}, timeoutMs = 6000, channel = 'ctl') {
  const s = servers[channel] || servers.ctl;
  const ok = await ensureProc(s);
  if (!ok || !s.proc || !s.ready) return null;
  const mySeq = ++s.seq;
  const req = JSON.stringify({
    seq: mySeq,
    action,
    path: params.path || '',
    close: params.close === false ? 'false' : 'true',
    exportDir: params.exportDir || '',
    page: String(params.page || 0),
    noexport: params.noexport ? 'true' : '',
  });
  return new Promise((resolve) => {
    const proc = s.proc; // 固定本次请求对应的进程，超时只杀它，不误伤已重建的新进程
    const timer = setTimeout(() => {
      s.pending.delete(mySeq);
      // 超时视为服务卡死：杀掉待重启，下次 exec 自动重建（只影响本通道）
      try { proc.kill(); } catch { }
      resolve(null);
    }, timeoutMs);
    s.pending.set(mySeq, { resolve, timer });
    try {
      proc.stdin.write(req + '\n');
    } catch {
      clearTimeout(timer);
      s.pending.delete(mySeq);
      resolve(null);
    }
  });
}

// 预热只拉起调用方指定的通道。默认只热 ctl（翻页通路，直接影响体验）；
// thumb 通道会在首次导缩略图时按需冷启动，省一个常驻 PowerShell（≈80MB，GAP-07）。
function warmup(channels) {
  const list = Array.isArray(channels) ? channels : ['ctl'];
  for (const c of list) {
    ensureProc(servers[c] || servers.ctl).catch(() => { });
  }
}

// 退出前收掉所有通道的进程与在途请求（BUG-14：原来没有关闭入口，进程只能等 app.quit 连带杀掉）
function close() {
  for (const s of Object.values(servers)) {
    for (const [, p] of s.pending) { clearTimeout(p.timer); p.resolve(null); }
    s.pending.clear();
    if (s.proc) { try { s.proc.kill(); } catch { } s.proc = null; }
    s.ready = false;
    s.starting = null;
  }
}

module.exports = { exec, warmup, close };
