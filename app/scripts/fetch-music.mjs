/* 内置曲库抓取：从 Mixkit（Stock Music / SFX Free License）拉取约 100 首，
 * 按分类写入 resources/music/<分类>/，生成 manifest.json 供 licenses.md 引用。
 * 用法：node scripts/fetch-music.mjs */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const ROOT = path.resolve(import.meta.dirname, '..', 'resources', 'music');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

/* 分类 → [页面URL, 数量]（去重后全局限量）；trailer/sport 拼颁奖 */
const PLAN = [
  ['暖场', 'https://mixkit.co/free-stock-music/tag/happy/', 14],
  ['背景音乐', 'https://mixkit.co/free-stock-music/tag/corporate/', 14],
  ['冥想音乐', 'https://mixkit.co/free-stock-music/ambient/', 14],
  ['庆典', 'https://mixkit.co/free-stock-music/tag/party/', 14],
  ['颁奖', 'https://mixkit.co/free-stock-music/trailer/', 6],
  ['颁奖', 'https://mixkit.co/free-stock-music/sport/', 6],
  ['上舞台', 'https://mixkit.co/free-stock-music/tag/energetic/', 14],
  ['下舞台', 'https://mixkit.co/free-stock-music/funk/', 10],
];
const BELLS = [
  ['上课铃 · 清脆铃', 'https://assets.mixkit.co/active_storage/sfx/600/600-preview.mp3', 'Achievement bell'],
  ['下课铃 · 叮咚铃', 'https://assets.mixkit.co/active_storage/sfx/111/111-preview.mp3', 'Melodic classic door bell'],
  ['预备铃 · 柔和铃声', 'https://assets.mixkit.co/active_storage/sfx/3109/3109-preview.mp3', 'Relaxing bell chime'],
  ['广播提示铃', 'https://assets.mixkit.co/active_storage/sfx/1569/1569-preview.mp3', 'Airport announcement ding'],
];

// 白名单净化文件名：只保留 字母/数字（含中文）/空格/括号/&/'+-
const sanitize = (s) => (s || '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  .replace(/[^\p{L}\p{N}\s().,&'+-]/gu, '')
  .replace(/\s+/g, ' ').trim().slice(0, 80);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: UA, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function getRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await get(url); } catch (e) { last = e; await sleep(600 * (i + 1)); }
  }
  throw last;
}

function parseItems(html) {
  const blocks = html.split('<div class="item-grid__item">').slice(1);
  const out = [];
  for (const b of blocks) {
    const t = b.match(/<h2 class="item-grid-card__title">\s*([^<]+?)\s*<\/h2>/);
    const u = b.match(/(https:\/\/assets\.mixkit\.co\/(?:music|active_storage\/sfx)\/[^"']+\.mp3)/);
    const id = u && u[1].match(/\/(\d+)(?:-\d+)?(?:-|\/)(?:\1)?(?:-preview)?\.mp3/);
    if (t && u) out.push({ title: t[1].trim(), url: u[1], id: id ? id[1] : u[1] });
  }
  return out;
}

const seen = new Set();
const manifest = [];
let ok = 0, fail = 0;

async function downloadTo(cat, title, url, forcedName) {
  const dir = path.join(ROOT, cat);
  fs.mkdirSync(dir, { recursive: true });
  const name = (forcedName || sanitize(title)) + '.mp3';
  const fp = path.join(dir, name);
  if (fs.existsSync(fp)) { console.log(`SKIP 已存在 ${cat}/${name}`); manifest.push({ cat, title, url, file: name, note: '已存在' }); return true; }
  const buf = await getRetry(url);
  // 简单校验不是 HTML 错误页
  if (buf.length < 20000 || buf.slice(0, 15).toString('latin1').includes('<')) {
    throw new Error(`内容异常(${buf.length}B) ${url}`);
  }
  fs.writeFileSync(fp, buf);
  manifest.push({ cat, title, url, file: name });
  console.log(`OK   ${cat}/${name}  ${(buf.length / 1048576).toFixed(1)}MB`);
  return true;
}

for (const [cat, pageUrl, limit] of PLAN) {
  console.log(`\n== 分类「${cat}」<= ${pageUrl} (限 ${limit})`);
  let items;
  try { items = parseItems((await getRetry(pageUrl)).toString('utf8')); }
  catch (e) { console.log(`页面失败: ${e.message}`); continue; }
  let taken = 0;
  for (const it of items) {
    if (taken >= limit) break;
    if (seen.has(it.id)) continue;
    try {
      await downloadTo(cat, it.title, it.url);
      seen.add(it.id); taken++; ok++;
    } catch (e) { console.log(`FAIL ${it.title}: ${e.message}`); fail++; }
    await sleep(200);
  }
  console.log(`「${cat}」完成 ${taken}/${limit}`);
}

console.log('\n== 分类「上课铃声」');
for (const [name, url, origTitle] of BELLS) {
  try { await downloadTo('上课铃声', origTitle, url, name); ok++; }
  catch (e) { console.log(`FAIL ${origTitle}: ${e.message}`); fail++; }
  await sleep(200);
}

fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\n总计: 成功 ${ok} 失败 ${fail}，manifest 已生成`);
