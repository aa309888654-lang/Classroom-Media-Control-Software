/* 全格式转码兼容层：ffmpeg 静态二进制随包分发（ffmpeg-static）
 * Chromium 不能直接播的格式（mov/mkv/avi/wmv/flv/ts 等）转码为 MP4（H.264+AAC）；
 * 音频冷门格式（wma/ape/amr 等）转码为 MP3。
 * 转码进度经回调上报（0-100）。 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Chromium <video>/<audio> 原生可播（无需转码直接拷贝入库）
const VIDEO_SAFE = new Set(['.mp4', '.m4v', '.webm', '.ogv']);
const AUDIO_SAFE = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.opus']);
// 市面常见格式全量（导入对话框用）
const VIDEO_ALL = ['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.3gp', '.3g2', '.mpg', '.mpeg', '.vob', '.asf', '.rm', '.rmvb', '.f4v'];
const AUDIO_ALL = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.opus', '.wma', '.ape', '.amr', '.aiff', '.aif', '.mka', '.ra', '.ac3', '.dts'];

function resolveFfmpeg() {
  const { app } = require('electron');
  // ffmpeg-static 的产物名带平台后缀：Windows 是 ffmpeg.exe，macOS/Linux 是 ffmpeg。
  // 原来四处候选路径全部硬编码 'ffmpeg.exe' → macOS 上一个都命中不了，
  // resolveFfmpeg() 恒返回 null → MOV/MKV/AVI 转码直接失败（'no-ffmpeg'）、
  // 视频缩略图一张都生成不了（thumbs.js 走同一函数）。
  // 2026-10-20 全面检查发现：README/包配置都宣称支持 macOS，但该平台媒体库退化成纯文字列表。
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const rel = path.join('node_modules', 'ffmpeg-static', exeName);
  // 打包态：asarUnpack 之后二进制在 app.asar.unpacked 下；dev：随包安装的 ffmpeg-static
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', rel),
    path.join(app.getAppPath(), rel),
    path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), rel),
    path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', exeName), // dev 兜底
  ];
  for (const p of candidates) { try { if (p && fs.existsSync(p)) return p; } catch { } }
  return null;
}

function isVideoSafe(ext) { return VIDEO_SAFE.has(String(ext).toLowerCase()); }
function isAudioSafe(ext) { return AUDIO_SAFE.has(String(ext).toLowerCase()); }
function isVideoExt(ext) { return VIDEO_ALL.includes(String(ext).toLowerCase()); }
function isAudioExt(ext) { return AUDIO_ALL.includes(String(ext).toLowerCase()); }

// 从 ffmpeg stderr 解析总时长（秒）
function parseDuration(text) {
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/* 直接解析 MP4/MOV 的 mvhd 原子读时长（秒），零 spawn（PERF-08：短视频抽帧决策用）。
 * 只读文件头/尾各 256KB 找 moov（faststart 在前、常规 MP4 在后）；非 MP4 或解析失败返回 0，
 * 调用方回退到「先试 1s、失败再 0 帧」的双尝试路径——最坏情况与旧行为一致。 */
function probeDurationSec(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return 0;
    const CHUNK = 256 * 1024;
    const readChunk = (pos, len) => {
      const buf = Buffer.alloc(Math.min(len, Math.max(0, size - pos)));
      if (!buf.length) return null;
      fs.readSync(fd, buf, 0, buf.length, pos);
      return buf;
    };
    const chunks = [readChunk(0, CHUNK)];
    if (size > CHUNK) chunks.push(readChunk(Math.max(0, size - CHUNK), CHUNK));
    for (const buf of chunks) {
      if (!buf) continue;
      let i = 0;
      while ((i = buf.indexOf('mvhd', i)) >= 0) {
        // box 布局：size(4) 'mvhd'(4) version(1) flags(3) ...
        if (i + 4 >= buf.length) break;
        const version = buf.readUInt8(i + 4);
        try {
          if (version === 0 && i + 24 <= buf.length) {
            const timescale = buf.readUInt32BE(i + 16);
            const duration = buf.readUInt32BE(i + 20);
            if (timescale > 0) return duration / timescale;
          } else if (version === 1 && i + 36 <= buf.length) {
            const timescale = buf.readUInt32BE(i + 24);
            const duration = Number(buf.readBigUInt64BE(i + 28));
            if (timescale > 0) return duration / timescale;
          }
        } catch { /* 越界就换下一个匹配 */ }
        i += 4;
      }
    }
    return 0;
  } catch { return 0; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch { } }
}

/**
 * 转码。kind: 'video' → mp4；'audio' → mp3。
 * onProgress(0-100)。返回 { ok, file, error }
 */
function transcode(src, destDir, kind, onProgress, timeoutMs = 10 * 60 * 1000) {
  const ext = kind === 'video' ? '.mp4' : '.mp3';
  const stem = path.basename(src, path.extname(src));
  let dest = path.join(destDir, stem + ext);
  let k = 1;
  while (fs.existsSync(dest)) dest = path.join(destDir, `${stem} (${k++})${ext}`);
  return _runTranscode(src, dest, kind, onProgress, timeoutMs);
}

// 底层转码：src → 指定 dest（含扩展名），video=mp4(H.264+AAC)、audio=mp3(libmp3lame)
function _runTranscode(src, dest, kind, onProgress, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const ffmpeg = resolveFfmpeg();
    if (!ffmpeg) return resolve({ ok: false, error: 'no-ffmpeg' });
    const args = ['-hide_banner', '-y', '-i', src];
    if (kind === 'video') {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
    } else {
      args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '4');
    }
    args.push(dest);

    let stderr = '', duration = 0, settled = false;
    let tail = '';   // 失败详情用：只保留 stderr 尾部，不再对全量 stderr 重复正则匹配（PERF-01）
    let carry = '';  // 进度解析用：拼上上一块尾部，避免 time=HH:MM:SS.mm 被 chunk 边界切断漏报
    const child = spawn(ffmpeg, args, { windowsHide: true });
    liveChildren.add(child);
    child.on('close', () => liveChildren.delete(child)); // 正常结束即注销，退出时只需 kill 仍在跑的
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill(); } catch { } try { fs.unlinkSync(dest); } catch { } resolve({ ok: false, error: 'timeout' }); }
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      tail = (tail + chunk).slice(-600);
      if (!duration) {
        stderr += chunk;
        duration = parseDuration(stderr);
      }
      if (duration && onProgress) {
        // 只扫「上一块尾部 + 本次 chunk」，仍是 O(n)；跨块切断的 time= 也能接上
        const m = (carry + chunk).match(/time=(\d+):(\d+):(\d+\.\d+)/g);
        if (m) {
          const last = m[m.length - 1].match(/(\d+):(\d+):(\d+\.\d+)/);
          const cur = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
          onProgress(Math.min(99, Math.round((cur / duration) * 100)));
        }
        carry = chunk.slice(-20); // 20 字足够接住 time=HH:MM:SS.mm（11 字）
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { fs.unlinkSync(dest); } catch { }
      resolve({ ok: false, error: 'spawn-failed', detail: String(err) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        if (onProgress) onProgress(100);
        resolve({ ok: true, file: dest });
      } else {
        try { fs.unlinkSync(dest); } catch { }
        resolve({ ok: false, error: 'transcode-failed', detail: tail.slice(-300) });
      }
    });
  });
}

/* ===== 音乐「播放前转码缓存」：放文件夹里的冷门格式（wma/ape/amr/ra/ac3/dts/mka…）
 *   Chromium 解不了，播放前转码为缓存的 MP3 再播；按「路径+大小+mtime」哈希缓存，二次播秒开。 ===== */
function mediaCacheDir() {
  const { app } = require('electron');
  const d = path.join(app.getPath('userData'), 'media-cache');
  try { fs.mkdirSync(d, { recursive: true }); } catch { }
  return d;
}
function _safeStat(f) { try { const s = fs.statSync(f); return { size: s.size, mtimeMs: s.mtimeMs.getTime() }; } catch { return { size: 0, mtimeMs: 0 }; } }
function _cacheKey(file) {
  const st = _safeStat(file);
  const norm = String(file).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha1').update(`${norm}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 12);
}
function audioCachePath(file) { return path.join(mediaCacheDir(), `aud-${_cacheKey(file)}.mp3`); }
function getCachedAudio(file) { const p = audioCachePath(file); return fs.existsSync(p) ? p : ''; }

// 返回 { file, transcoded }：safe 或非音频→原文件；冷门→缓存命中即返，未命中转码到缓存再返
function ensureAudioPlayable(file, onProgress) {
  const ext = path.extname(file).toLowerCase();
  if (isAudioSafe(ext) || !isAudioExt(ext)) return Promise.resolve({ file, transcoded: false });
  const cached = getCachedAudio(file);
  if (cached) return Promise.resolve({ file: cached, transcoded: true, cached: true });
  const dest = audioCachePath(file);
  return _runTranscode(file, dest, 'audio', onProgress).then((r) => {
    if (r.ok) return { file: r.file, transcoded: true };
    return { file, transcoded: false, error: r.error }; // 转码失败用原文件兜底（引擎会 onError 跳过）
  });
}

// 启动时清理 14 天前的转码缓存（防只增不减，GAP-10 同款）。
// 异步执行：原本 readdirSync + 每文件 statSync/rmSync 会同步冻结主进程。
const MEDIA_TTL_MS = 14 * 24 * 3600 * 1000;
async function sweepMediaCache() {
  const dir = mediaCacheDir();
  let files = [];
  try { files = await fs.promises.readdir(dir); } catch { return; }
  await Promise.all(files.map(async (f) => {
    try {
      const p = path.join(dir, f);
      const st = await fs.promises.stat(p);
      if (Date.now() - st.mtimeMs > MEDIA_TTL_MS) await fs.promises.rm(p, { force: true });
    } catch { }
  }));
}

// 在跑的 ffmpeg 子进程登记表：转码/抽帧途中退出应用时统一 kill，
// 否则主进程一死 ffmpeg 就变孤儿，继续占 CPU 往已无人关心的缓存里写盘（大文件可达 10 分钟）。
const liveChildren = new Set();
function killAll() {
  for (const c of liveChildren) { try { c.kill(); } catch { } }
  liveChildren.clear();
}

module.exports = { transcode, isVideoSafe, isAudioSafe, isVideoExt, isAudioExt, VIDEO_ALL, AUDIO_ALL, resolveFfmpeg, probeDurationSec, parseDuration, ensureAudioPlayable, getCachedAudio, sweepMediaCache, killAll }; // parseDuration/probeDurationSec 导出供测试（GAP-01）
