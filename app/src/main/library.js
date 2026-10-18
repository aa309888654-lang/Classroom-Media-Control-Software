const fs = require('fs');
const path = require('path');
const { getResourcesPath } = require('./paths');
const config = require('./config');

// 与 transcode.js 全格式清单一致：库里能显示的格式全集；
// Chromium 不能直接播的格式在导入/播放时自动转码为 MP4/MP3（见 transcode.js）
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac', '.opus', '.wma', '.ape', '.amr', '.aiff', '.aif', '.mka', '.ra', '.ac3', '.dts']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.ogv', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.3gp', '.3g2', '.mpg', '.mpeg', '.vob', '.asf', '.rm', '.rmvb', '.f4v']);
const PPT_EXT = new Set(['.pptx', '.ppt', '.ppsx']);          // PowerPoint/WPS 可 COM 放映（翻页/胶片/备注全支持）
// 课件库扩展为「各种文档」：PDF/Word/Excel/RTF/WPS/ODF 等 + 图片，均能用系统默认程序打开投屏
const DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.odp', '.odt', '.ods', '.rtf', '.wps', '.et', '.dps', '.dpt', '.pot', '.potx', '.potm', '.pptm', '.vsd', '.vsdx', '.txt']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff', '.svg']);
const IMG_EXT_ARR = [...IMG_EXT].map((e) => e.slice(1)); // 对话框过滤器用（去点）
const COURSEWARE_EXT = new Set([...PPT_EXT, ...DOC_EXT, ...IMG_EXT]);
const COURSEWARE_EXT_ARR = [...COURSEWARE_EXT].map((e) => e.slice(1)); // 对话框过滤器用（去点）
function isPptExt(ext) { return PPT_EXT.has(String(ext).toLowerCase()); }
function isImgExt(ext) { return IMG_EXT.has(String(ext).toLowerCase()); }
// 视频库＝视频 + 图片：老师把课件截图/板书照片丢进同一个文件夹就能在视频板块整屏投放
const MEDIA_EXT = new Set([...VIDEO_EXT, ...IMG_EXT]);
const MEDIA_EXT_ARR = [...MEDIA_EXT].map((e) => e.slice(1));

// 库扫描一律走 fs.promises：这些都是跑在主进程事件循环上的目录遍历，
// 同步版本（readdirSync/statSync）在网络盘/U 盘上会冻结菜单、窗口拖动、全局快捷键与计时 tick。
async function listAudioFiles(dir) {
  try {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

async function scanCategories(rootDir, builtinTag) {
  const cats = [];
  let ents = [];
  try { ents = await fs.promises.readdir(rootDir, { withFileTypes: true }); } catch { return cats; }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const files = await listAudioFiles(path.join(rootDir, ent.name));
    // 空文件夹也保留：用户新建的分类就是空的，放歌后自动有内容
    cats.push({ category: ent.name, builtin: builtinTag, tracks: files });
  }
  return cats;
}

// 内置曲库（resources/music/<分类>/*）+ 用户曲库（musicDir/<分类>/*），同名分类合并
async function scanMusic() {
  const cfg = config.get();
  const raw = [];

  if (cfg.builtinMusicEnabled) {
    raw.push(...await scanCategories(path.join(getResourcesPath(), 'music'), true));
  }
  if (cfg.musicDir) {
    raw.push(...await scanCategories(cfg.musicDir, false));
    // 根目录散落的音频归入「我的音乐」（虚拟分类，不可删除）
    const loose = await listAudioFiles(cfg.musicDir);
    if (loose.length) raw.push({ category: '我的音乐', builtin: false, virtual: true, tracks: loose });
  }
  return mergeCategories(raw);
}

// 同名分类（如用户自建「暖场」文件夹）合并为一个卡片，曲目去重（Set 去重替代 includes，O(n)）
function mergeCategories(list) {
  const map = new Map();
  for (const c of list) {
    const ex = map.get(c.category);
    if (ex) {
      const seen = new Set(ex.tracks);
      for (const t of c.tracks) if (!seen.has(t)) { seen.add(t); ex.tracks.push(t); }
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

// 视频库：视频 + 图片（kind: 'video' | 'img'）。图片走同一条投放链路，只是播放窗里换成整屏显示，
// 支持左右翻图与自动轮播——课件截图/板书照片不用再单独转成视频。
async function scanVideos() {
  const cfg = config.get();
  const out = [];
  if (cfg.videoDir) {
    const files = await listFiles(cfg.videoDir, MEDIA_EXT);
    const stats = await Promise.all(files.map((f) => safeStat(f)));
    files.forEach((f, i) => out.push({
      file: f,
      name: path.basename(f),
      size: stats[i].size,
      mtime: stats[i].mtimeMs,
      kind: isImgExt(path.extname(f)) ? 'img' : 'video',
    }));
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return applyOrder(out, cfg.videoOrder);
}

// 课件库：pptDir 下的各种文档（PPT 走 COM 集成放映；PDF/Word/Excel/图片等用系统默认程序打开投屏）
// kind: 'ppt'=COM可放映(翻页/胶片/备注) · 'img'=图片(自身作缩略图) · 'doc'=其它文档(占位图标)
async function scanPpts() {
  const cfg = config.get();
  const out = [];
  if (cfg.pptDir) {
    const files = await listFiles(cfg.pptDir, COURSEWARE_EXT);
    const stats = await Promise.all(files.map((f) => safeStat(f)));
    files.forEach((f, i) => {
      const ext = path.extname(f).toLowerCase();
      const kind = isPptExt(ext) ? 'ppt' : IMG_EXT.has(ext) ? 'img' : 'doc';
      out.push({ file: f, name: path.basename(f), size: stats[i].size, mtime: stats[i].mtimeMs, kind });
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return applyOrder(out, cfg.pptOrder);
}

async function listFiles(dir, extSet) {
  try {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isFile() && extSet.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

async function safeStat(f) {
  try { return await fs.promises.stat(f); } catch { return { size: 0, mtimeMs: 0 }; }
}

function pushRecent(kind, file) {
  const cfg = config.get();
  const key = kind === 'ppt' ? 'recentPpt' : 'recentVideo';
  const list = [file, ...cfg[key].filter((f) => f !== file)].slice(0, 8);
  config.save({ [key]: list });
}

module.exports = { scanMusic, scanVideos, scanPpts, pushRecent, mergeCategories, applyOrder, AUDIO_EXT, VIDEO_EXT, PPT_EXT, DOC_EXT, IMG_EXT, IMG_EXT_ARR, COURSEWARE_EXT, COURSEWARE_EXT_ARR, MEDIA_EXT, MEDIA_EXT_ARR, isPptExt, isImgExt }; // mergeCategories/applyOrder 导出供测试（GAP-01）
