/* 从 Lucide（MIT）本地化图标：把项目用到的图标名映射为 lucide 官方 SVG，
 * 输出聚合文件到 src/renderer/assets/vendor/icons.js（保持 Icons.set API 不变）。
 * 用法：node scripts/fetch-icons.mjs */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const VER = '0.462.0';
const BASE = `https://cdn.jsdelivr.net/npm/lucide-static@${VER}/icons`;

// 项目图标名 → lucide 官方图标名
const MAP = {
  play: 'play',
  pause: 'pause',
  stop: 'square',
  previous: 'skip-back',
  next: 'skip-forward',
  'skip-back': 'skip-back',
  'skip-forward': 'skip-forward',
  rewind: 'chevrons-left',
  forward: 'chevrons-right',
  'volume-2': 'volume-2',
  'volume-x': 'volume-x',
  music: 'music',
  film: 'film',
  video: 'video',
  presentation: 'presentation',
  cast: 'cast',
  monitor: 'monitor',
  timer: 'timer',
  reset: 'rotate-ccw',
  settings: 'settings',
  pin: 'pin',
  folder: 'folder-open',
  import: 'import',
  trash: 'trash-2',
  star: 'star',
  x: 'x',
  fullscreen: 'maximize',
  plus: 'plus',
  globe: 'globe',
  heart: 'heart',
  sun: 'sun',
  coffee: 'coffee',
  moon: 'moon-star',
  party: 'party-popper',
  trophy: 'trophy',
  mic: 'mic',
  theater: 'theater',
  bell: 'bell',
  headphones: 'headphones',
  piano: 'piano',
  guitar: 'guitar',
  drum: 'drum',
  flute: 'mic-vocal',
  check: 'check',
};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
      res.on('error', reject);
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inner = (svgText) => {
  const m = svgText.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!m) throw new Error('no svg');
  return m[1].replace(/\s*\n\s*/g, ' ').trim();
};

const out = [];
out.push(`/* 小天AIGC 图标库 —— 基于 Lucide 官方开源图标（MIT License, https://lucide.dev）
 * 本文件由 scripts/fetch-icons.mjs 生成（lucide @ ${VER}），不要手工改，改了重抓即可。
 * 用法：Icons.set(el, name [, size]) 注入 SVG；或静态 <span class="ico" data-ico="name"></span> 经 Icons.hydrate() 替换。 */`);
out.push(`(function () {`);
out.push(`  'use strict';`);
out.push(`  const P = {`);
const failed = [];
for (const [ours, theirs] of Object.entries(MAP)) {
  const url = `${BASE}/${theirs}.svg`;
  try {
    const text = inner(await get(url));
    out.push(`    ${JSON.stringify(ours)}: ${JSON.stringify(text)},`);
    console.log(`OK  ${ours.padEnd(14)} <= ${theirs}`);
  } catch (e) {
    failed.push([ours, e.message]);
    console.log(`FAIL ${ours}: ${e.message}`);
  }
  await sleep(120);
}
out.push(`  };`);
out.push(`  const svg = (name, size) =>`);
out.push(`    \`<svg class="ic ic-\${name}" viewBox="0 0 24 24" width="\${size}" height="\${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${P[name] || P.music}</svg>\`;`);
out.push(`  const api = {`);
out.push(`    set(el, name, size) {`);
out.push(`      if (!el) return;`);
out.push(`      el.innerHTML = svg(name, Number(size || el.dataset.icoSize || 16));`);
out.push(`    },`);
out.push(`    hydrate(root) {`);
out.push(`      (root || document).querySelectorAll('.ico[data-ico]').forEach((el) => api.set(el, el.dataset.ico));`);
out.push(`    },`);
out.push(`  };`);
out.push(`  window.Icons = api;`);
out.push(`})();`);

if (failed.length) {
  console.log(`\n失败 ${failed.length} 个，终止（不重写 icons.js）：${failed.map((f) => f[0]).join(', ')}`);
  process.exit(2);
}
const target = path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'assets', 'vendor', 'icons.js');
fs.writeFileSync(target, out.join('\n') + '\n', 'utf8');
console.log(`\nicons.js 已重写（${Object.keys(MAP).length} 个 Lucide 图标）`);
