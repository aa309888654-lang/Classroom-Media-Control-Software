/* 库缩略图：视频用 ffmpeg 抽帧，PPT 用 PowerPoint COM 导第 1 页（WPS 同理）。
 * 缩略图存 userData/thumbs，文件名带 大小+mtime 做版本 key：
 * 文件没变 → 直接命中缓存（getInit/scan 同步返回）；变了 → 异步重新生成并广播 thumb:ready。
 * 生成走顺序队列（ffmpeg 与 COM 都重，并发无益）；放映 PPT 期间跳过 PPT 缩略图，避免 COM 打扰放映。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const transcode = require('./transcode');
const pptController = require('./pptController');

let thumbDir = null;
const liveKids = new Set(); // 在跑的 ffmpeg 抽帧进程（退出时统一 kill，避免孤儿进程空转）
function dir() {
  if (!thumbDir) {
    const { app } = require('electron');
    thumbDir = path.join(app.getPath('userData'), 'thumbs');
    try { fs.mkdirSync(thumbDir, { recursive: true }); } catch { }
  }
  return thumbDir;
}

// st：调用方（库扫描）已经 stat 过的源文件信息，透传进来可省掉对源文件的一次 statSync。
// 源文件可能在网络盘/U 盘上，多一次 stat 就是多一次可感知的同步等待。
function statKey(st) {
  if (!st) return '';
  const size = st.size;
  const mtime = st.mtimeMs != null ? st.mtimeMs : st.mtime;
  if (typeof size !== 'number' || typeof mtime !== 'number') return '';
  return `${size}-${Math.round(mtime)}`;
}

function cachePath(file, prefix, st) {
  let key = statKey(st) || 'unknown';
  if (!st) { try { const s2 = fs.statSync(file); key = `${s2.size}-${Math.round(s2.mtimeMs)}`; } catch { } }
  // BUG-03：原来只按「文件名 + 大小 + mtime」做 key，不同目录下同名同大小同 mtime 的文件
  // 会共用一个 key —— 串图且永不再生。把规范化完整路径的哈希纳入 key 彻底分离。
  // （旧缓存按旧规则命名，首次会 miss 并重新生成一次，属一次性成本。）
  const norm = String(file).replace(/\\/g, '/');
  const base = norm.split('/').pop().replace(/[^\w.-]/g, '_') || 'file';
  const dirHash = crypto.createHash('sha1').update(norm.toLowerCase()).digest('hex').slice(0, 10);
  const name = `${prefix}-${dirHash}-${base}-${key}.png`;
  return path.join(dir(), name);
}

// 同步查缓存：命中返回 PNG 路径，未命中返回 ''（列表先下发，异步补图）
function cached(kind, file, st) {
  // PPT 用 ppt2 前缀：v2 = 按幻灯片真实比例导出（旧缓存自动重新生成）
  const p = cachePath(file, kind === 'video' ? 'vid' : 'ppt2', st);
  try { if (fs.statSync(p).size > 0) return p; } catch { }
  return '';
}

// ---------- 视频：ffmpeg 抽帧 ----------
function videoThumb(file) {
  const out = cachePath(file, 'vid');
  const ffmpeg = transcode.resolveFfmpeg();
  if (!ffmpeg) return Promise.resolve('');
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    // PERF-08：能读出时长就一次抽帧——短于 1.5s 的短视频直接取第 0 帧（一次 spawn），
    // 不再固定先试 -ss 1 失败再重来；读不出时长（非 MP4/损坏）才走旧的双尝试兜底。
    const dur = transcode.probeDurationSec(file);
    const firstSeek = dur > 0 ? dur >= 1.5 : true;
    // 先试跳到 1s 取帧（避开开头黑屏），失败/无输出再取第 0 帧
    const attempt = (seek) => {
      const args = ['-hide_banner', '-y', '-loglevel', 'error'];
      if (seek) args.push('-ss', '1');
      args.push('-i', file, '-vframes', '1', '-vf', 'scale=320:-2', out);
      child = spawn(ffmpeg, args, { windowsHide: true });
      liveKids.add(child);
      child.on('close', () => liveKids.delete(child));
      child.on('error', () => finish(''));
      child.on('close', () => {
        let ok = false;
        try { ok = fs.statSync(out).size > 0; } catch { }
        if (ok || !seek) { finish(ok ? out : ''); }
        else attempt(false);
      });
    };
    attempt(firstSeek);
    // 兜底：极端大文件卡住 60s 放弃；unref 避免这个定时器拖着进程不退出（PERF-09）
    const killTimer = setTimeout(() => {
      try { if (child) child.kill(); } catch { }
      finish('');
    }, 60000);
    killTimer.unref();
  });
}

// ---------- PPT：COM 导出第 1 页（走 thumb 通道常驻 PS，与翻页隔离）----------
// Mac 无 COM（V1 不做，返回空）；'thumb' 动作把 $Exp 参数用作输出 PNG 路径
function pptThumb(file) {
  if (process.platform === 'darwin') return Promise.resolve('');
  const out = cachePath(file, 'ppt2');
  return pptController.runCtl('thumb', { path: file, exportDir: out, close: false }, 20000, 'thumb').then((r) => {
    let ok = false;
    try { ok = !!(r && r.ok) && fs.statSync(out).size > 0; } catch { }
    return ok ? out : '';
  });
}

// ---------- 顺序队列 ----------
const queue = [];
let draining = false;
const pending = new Set(); // kind|file 去重：扫描/导入多次触发不重复排队

// onReady(kind, file, thumbPath|'')：主进程把它接到 broadcast('thumb:ready') 上
function requestThumb(kind, file, onReady) {
  if (!file || pending.has(`${kind}|${file}`)) return;
  if (kind === 'ppt' && pptController.getState().presenting) return; // 放映中不打扰 COM
  // BUG-04：命中缓存直接跳过，否则每次 getInit/scan/openDialog 都全库重跑 ffmpeg/COM
  try { if (cached(kind, file)) return; } catch { }
  pending.add(`${kind}|${file}`);
  queue.push({ kind, file, onReady });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const { kind, file, onReady } = queue.shift();
    pending.delete(`${kind}|${file}`);
    let thumb = '';
    try {
      thumb = kind === 'video' ? await videoThumb(file) : await pptThumb(file);
    } catch { thumb = ''; }
    if (thumb) onReady(kind, file, thumb);
  }
  draining = false;
}

// 批量入队（列表来自 scanVideos/scanPpts）
function requestMany(kind, list, onReady) {
  (list || []).forEach((v) => requestThumb(kind, v.file, onReady));
}

// 在跑的 ffmpeg 抽帧进程登记表：应用退出时统一 kill，避免主进程死后 ffmpeg 变孤儿继续空转
function killAll() {
  for (const c of liveKids) { try { c.kill(); } catch { } }
  liveKids.clear();
}

module.exports = { cached, requestMany, cachePath, killAll }; // cachePath 导出仅供测试（BUG-03 回归防线）
