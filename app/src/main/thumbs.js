/* 库缩略图：视频用 ffmpeg 抽帧，PPT 用 PowerPoint COM 导第 1 页（WPS 同理）。
 * 缩略图存 userData/thumbs，文件名带 大小+mtime 做版本 key：
 * 文件没变 → 直接命中缓存（getInit/scan 同步返回）；变了 → 异步重新生成并广播 thumb:ready。
 * 生成走顺序队列（ffmpeg 与 COM 都重，并发无益）；放映 PPT 期间**延后** PPT 缩略图请求
 * （避免 COM 打扰放映），退出放映后由 releaseDeferred() 自动补做 —— 原来这里是直接丢弃且永不重试。 */
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
const deferred = new Map(); // 放映中被挡下的 PPT 缩略图请求，等退出放映后补做
const attempts = new Map(); // kind|file -> 已尝试次数（失败重试用，限次避免无限循环）

const MAX_ATTEMPTS = 2; // 首次 + 1 次重试；再多通常是环境问题，重试无意义
const RETRY_DELAY_MS = 1500;

// 纯函数：一次缩略图请求该怎么处理。抽出来是为了能单测这三条分支
// （跳过/延后/入队），不用起 COM、不碰文件系统。
// 关键修复：原来「放映中」直接 return 丢弃请求且永不重试 → 放映前扫过库的话，
// 课件芯片和「当前课件」缩略图会一直是占位符，必须切课件/重启才可能补上。
function planRequest(opts) {
  const { file, presenting, pendingKey, cachedHit } = opts;
  if (!file) return { action: 'skip', reason: 'no-file' };
  if (pendingKey) return { action: 'skip', reason: 'pending' };
  if (cachedHit) return { action: 'skip', reason: 'cached' };
  if (presenting) return { action: 'defer', reason: 'presenting' }; // 不限 kind：视频走 ffmpeg，本来可以照跑
  return { action: 'enqueue', reason: 'ok' };
}

// onReady(kind, file, thumbPath|'')：主进程把它接到 broadcast('thumb:ready') 上
function requestThumb(kind, file, onReady) {
  // 先把上一轮延后的请求放出来（放映可能已经结束了）
  if (kind === 'ppt') releaseDeferred();
  let cachedHit = false;
  // BUG-04：命中缓存直接跳过，否则每次 getInit/scan/openDialog 都全库重跑 ffmpeg/COM
  try { cachedHit = !!cached(kind, file); } catch { }
  const plan = planRequest({
    file,
    presenting: kind === 'ppt' && pptController.getState().presenting,
    pendingKey: pending.has(`${kind}|${file}`),
    cachedHit,
  });
  if (plan.action === 'skip') return;
  if (plan.action === 'defer') { deferred.set(`${kind}|${file}`, { kind, file, onReady }); return; }
  enqueue({ kind, file, onReady });
}

function enqueue(item) {
  const key = `${item.kind}|${item.file}`;
  pending.add(key);
  attempts.set(key, attempts.get(key) || 0);
  queue.push(item);
  drain();
}

// 退出放映后调用：把放映期间被挡下的 PPT 缩略图补做掉（原来这些请求直接丢了，永不重试）
function releaseDeferred() {
  if (!deferred.size) return;
  if (pptController.getState().presenting) return; // 还在放映，继续等
  const items = [...deferred.values()];
  deferred.clear();
  for (const it of items) {
    try { if (!cached(it.kind, it.file)) enqueue(it); } catch { }
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const { kind, file, onReady } = queue.shift();
      const key = `${kind}|${file}`;
      pending.delete(key);
      // 排队期间可能已经生成好了（同一批里重复请求）
      let done = false;
      try { done = !!cached(kind, file); } catch { }
      let thumb = done ? cached(kind, file) : '';
      if (!thumb) {
        try {
          thumb = kind === 'video' ? await videoThumb(file) : await pptThumb(file);
        } catch { thumb = ''; }
      }
      if (thumb) {
        attempts.delete(key);
        // onReady 是广播回调，包 try：它抛异常不能把整个队列带死
        try { onReady(kind, file, thumb); } catch { }
        continue;
      }
      // 失败：限次重试（COM 偶发失败、文件正被占用等）。仍失败就不再刷，避免空转。
      const n = (attempts.get(key) || 0) + 1;
      if (n < MAX_ATTEMPTS) {
        attempts.set(key, n);
        const t = setTimeout(() => { pending.delete(key); enqueue({ kind, file, onReady }); }, RETRY_DELAY_MS);
        if (t.unref) t.unref();
        continue;
      }
      attempts.delete(key);
      // 彻底失败：广播空串，让渲染层知道「这个真的没图」而不是无声无息一直占位
      try { onReady(kind, file, ''); } catch { }
    }
  } finally {
    // 必须放 finally：原来这里直接赋值，任何一处抛异常都会让 draining 永久为 true，
    // 之后所有缩略图请求全部静默卡死（整个会话都不再补图）。
    draining = false;
  }
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

module.exports = { cached, requestMany, cachePath, killAll, releaseDeferred, planRequest }; // cachePath/planRequest 导出仅供测试
