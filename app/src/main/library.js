const fs = require('fs');
const path = require('path');
const { getResourcesPath } = require('./paths');
const config = require('./config');

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v']);
const PPT_EXT = new Set(['.pptx', '.ppt', '.ppsx']);

function listAudioFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function scanCategories(rootDir, builtinTag) {
  const cats = [];
  try {
    for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const files = listAudioFiles(path.join(rootDir, ent.name));
      // 空文件夹也保留：用户新建的分类就是空的，放歌后自动有内容
      cats.push({ category: ent.name, builtin: builtinTag, tracks: files });
    }
  } catch { }
  return cats;
}

// 内置曲库（resources/music/<分类>/*）+ 用户曲库（musicDir/<分类>/*），同名分类合并
function scanMusic() {
  const cfg = config.get();
  const raw = [];

  if (cfg.builtinMusicEnabled) {
    raw.push(...scanCategories(path.join(getResourcesPath(), 'music'), true));
  }
  if (cfg.musicDir) {
    raw.push(...scanCategories(cfg.musicDir, false));
    // 根目录散落的音频归入「我的音乐」（虚拟分类，不可删除）
    const loose = listAudioFiles(cfg.musicDir);
    if (loose.length) raw.push({ category: '我的音乐', builtin: false, virtual: true, tracks: loose });
  }
  return mergeCategories(raw);
}

// 同名分类（如用户自建「暖场」文件夹）合并为一个卡片，曲目去重
function mergeCategories(list) {
  const map = new Map();
  for (const c of list) {
    const ex = map.get(c.category);
    if (ex) {
      for (const t of c.tracks) if (!ex.tracks.includes(t)) ex.tracks.push(t);
      ex.builtin = ex.builtin && c.builtin;
      ex.virtual = ex.virtual && !!c.virtual;
    } else {
      map.set(c.category, { category: c.category, builtin: c.builtin, virtual: !!c.virtual, tracks: [...c.tracks] });
    }
  }
  return [...map.values()];
}

// 手动排序优先（config 里的文件路径数组），未排过的按修改时间倒序排在后面
function applyOrder(list, order) {
  if (!Array.isArray(order) || !order.length) return list;
  const pos = new Map(order.map((f, i) => [f, i]));
  return list.slice().sort((a, b) => {
    const pa = pos.has(a.file) ? pos.get(a.file) : Infinity;
    const pb = pos.has(b.file) ? pos.get(b.file) : Infinity;
    if (pa !== pb) return pa - pb;
    return b.mtime - a.mtime;
  });
}

function scanVideos() {
  const cfg = config.get();
  const out = [];
  if (cfg.videoDir) {
    for (const f of listFiles(cfg.videoDir, VIDEO_EXT)) {
      const st = safeStat(f);
      out.push({ file: f, name: path.basename(f), size: st.size, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return applyOrder(out, cfg.videoOrder);
}

// 课件库：pptDir 下的 PPT/PPTX/PPSX，排序规则同视频库
function scanPpts() {
  const cfg = config.get();
  const out = [];
  if (cfg.pptDir) {
    for (const f of listFiles(cfg.pptDir, PPT_EXT)) {
      const st = safeStat(f);
      out.push({ file: f, name: path.basename(f), size: st.size, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return applyOrder(out, cfg.pptOrder);
}

function listFiles(dir, extSet) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && extSet.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function safeStat(f) {
  try { return fs.statSync(f); } catch { return { size: 0, mtimeMs: 0 }; }
}

function pushRecent(kind, file) {
  const cfg = config.get();
  const key = kind === 'ppt' ? 'recentPpt' : 'recentVideo';
  const list = [file, ...cfg[key].filter((f) => f !== file)].slice(0, 8);
  config.save({ [key]: list });
}

module.exports = { scanMusic, scanVideos, scanPpts, pushRecent, AUDIO_EXT, VIDEO_EXT, PPT_EXT };
