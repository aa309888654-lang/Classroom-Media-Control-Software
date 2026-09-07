/* 下载欢迎屏背景图：Unsplash（免费商用 https://unsplash.com/license）
 * 按候选清单 HEAD 探测后取前 10 张可用的，存 resources/welcome-bg/01..10.jpg */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const OUT = path.resolve(import.meta.dirname, '..', 'resources', 'welcome-bg');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const CANDIDATES = [
  ['photo-1470813740244-df37b8c1edcb', '渐变晚霞'],
  ['photo-1507525428034-b723cf961d3e', '海天一色'],
  ['photo-1472214103451-9374bd1c798e', '威尼斯水道'],
  ['photo-1473615695634-d284ec918736', '雪山'],
  ['photo-1519681393784-d120267933ba', '金秋森林'],
  ['photo-1519501025264-65ba15a82390', '城市夜色'],
  ['photo-1550684848-fac1c5b4e853', '霓虹未来'],
  ['photo-1419242902214-272b3f66ee7a', '星空'],
  ['photo-1483347756197-71ef80e95f73', '极光'],
  ['photo-1506905925346-21bda4d32df4', '晨曦湖面'],
  ['photo-1501785888041-af3ef285b470', '山谷湖泊'],
  ['photo-1470071459604-3b5ec3a7fe05', '金色麦田'],
  ['photo-1518495973542-4542c06a5883', '国风长街'],
  ['photo-1439405326854-014607f694d7', '海浪'],
  ['photo-1500382017468-9049fed747ef', '红花瓣'],
];

function req(url, method = 'HEAD') {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers: UA, timeout: 25000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(req(new URL(res.headers.location, url).href, method));
      }
      resolve(res.statusCode);
      res.resume();
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
    r.end();
  });
}
function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: UA, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

fs.mkdirSync(OUT, { recursive: true });
const picked = [];
for (const [id, label] of CANDIDATES) {
  const url = `https://images.unsplash.com/${id}?q=85&w=1920&fm=jpg&fit=max`;
  if (picked.length >= 10) break;
  try {
    const code = await req(url);
    if (code === 200) picked.push({ url, label, id });
  } catch { }
}
console.log('可用的候选：', picked.map((p) => p.label).join('、'));
let n = 0;
const manifest = [];
for (const p of picked.slice(0, 10)) {
  n++;
  const fp = path.join(OUT, String(n).padStart(2, '0') + '.jpg');
  try {
    const buf = await download(p.url);
    if (buf.length < 50000) throw new Error('too small');
    fs.writeFileSync(fp, buf);
    manifest.push({ file: `${n}.jpg`, label: p.label, source: p.url });
    console.log(`OK ${String(n).padStart(2, '0')} ${p.label} ${(buf.length / 1048576).toFixed(1)}MB`);
  } catch (e) { console.log(`失败 ${p.label}: ${e.message}`); }
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`完成 ${manifest.length} 张`);
