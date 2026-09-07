/* 生成 20 套「专业 LED 欢迎屏」背景（纯 Node，无第三方依赖）
 * 产物：resources/welcome-bg/01.png + 02.svg ~ 20.svg + manifest.json
 * 01.png 为用户选定的参考图（鎏金绸缎城市风），由本脚本从 ../../LED背景/ 复制。
 * 02~20 为程序化自绘 SVG（矢量，CC0）：深色系（盛典蓝/喜庆红/科技蓝等）
 * + 参考图同系的绸缎鎏金城市风（红金筑梦/蓝金致远/晨曦鎏光等）。
 * 用法：node scripts/gen-welcome-bg.js
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'resources', 'welcome-bg');
const REF_PNG = path.join(__dirname, '..', '..', 'LED背景', 'dd66fa52-387a-438f-a73f-e599ac4701a5.png');
const W = 1920; const H = 1080;

/* ---------- 可复现随机数 ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnum = (rng, a, b) => a + rng() * (b - a);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const fmt = (n) => String(Math.round(n * 100) / 100);

/* ---------- SVG 基元 ---------- */
function lg(id, x1, y1, x2, y2, stops) {
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">`
    + stops.map((s) => `<stop offset="${s[0]}" stop-color="${s[1]}"${s[2] != null ? ` stop-opacity="${s[2]}"` : ''}/>`).join('')
    + '</linearGradient>';
}
function rg(id, cx, cy, r, stops) {
  return `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="userSpaceOnUse">`
    + stops.map((s) => `<stop offset="${s[0]}" stop-color="${s[1]}"${s[2] != null ? ` stop-opacity="${s[2]}"` : ''}/>`).join('')
    + '</radialGradient>';
}
const blurF = (id, std) => `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${std}"/></filter>`;
const glowBlob = (fill, cx, cy, rx, ry, opacity, blurId) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" opacity="${opacity}"${blurId ? ` filter="url(#${blurId})"` : ''}/>`;

function beam(id, topX, topY, baseX, baseW, opacity, blurId, height = H) {
  return `<g filter="url(#${blurId})" opacity="${opacity}">`
    + `<polygon points="${fmt(topX)},${fmt(topY)} ${fmt(baseX - baseW / 2)},${height} ${fmt(baseX + baseW / 2)},${height}" fill="url(#${id})"/>`
    + '</g>';
}

function particles(rng, { n, x, y, w, h, colors, rMin, rMax, oMin, oMax }) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `<circle cx="${fmt(rnum(rng, x, x + w))}" cy="${fmt(rnum(rng, y, y + h))}" r="${fmt(rnum(rng, rMin, rMax))}" fill="${pick(rng, colors)}" opacity="${fmt(rnum(rng, oMin, oMax))}"/>`;
  }
  return s;
}

function dotGrid(rng, { x0, y0, cols, rows, dx, dy, colors, r, oMin, oMax }) {
  let s = '';
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      s += `<circle cx="${fmt(x0 + i * dx)}" cy="${fmt(y0 + j * dy)}" r="${r}" fill="${pick(rng, colors)}" opacity="${fmt(rnum(rng, oMin, oMax))}"/>`;
    }
  }
  return s;
}

const ring = (cx, cy, rx, ry, stroke, width, opacity) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;

/* 城市剪影：一排高低错落的楼 + 一座带尖塔的主楼，自右向左延伸 */
function citySkyline(rng, { x1, y, w, hMin, hMax, color, opacity, blurId }) {
  let x = x1 - w; let s = '';
  const hBase = y; // 地面 y
  while (x < x1 - 10) {
    const bw = rnum(rng, 30, 90);
    const bh = rnum(rng, hMin, hMax);
    s += `<rect x="${fmt(x)}" y="${fmt(hBase - bh)}" width="${fmt(bw)}" height="${fmt(bh)}" fill="${color}"/>`;
    if (rng() > 0.72) { // 尖顶
      s += `<polygon points="${fmt(x + bw * 0.2)},${fmt(hBase - bh)} ${fmt(x + bw / 2)},${fmt(hBase - bh - rnum(rng, 30, 90))} ${fmt(x + bw * 0.8)},${fmt(hBase - bh)}" fill="${color}"/>`;
    }
    x += bw + rnum(rng, 6, 26);
  }
  // 主楼：更高 + 细长尖塔
  const mx = x1 - w * 0.42; const mh = hMax * 1.35;
  s += `<rect x="${fmt(mx)}" y="${fmt(hBase - mh)}" width="58" height="${fmt(mh)}" fill="${color}"/>`
    + `<rect x="${fmt(mx + 22)}" y="${fmt(hBase - mh - 120)}" width="14" height="130" fill="${color}"/>`
    + `<polygon points="${fmt(mx + 22)},${fmt(hBase - mh - 120)} ${fmt(mx + 29)},${fmt(hBase - mh - 170)} ${fmt(mx + 36)},${fmt(hBase - mh - 120)}" fill="${color}"/>`;
  return `<g opacity="${opacity}"${blurId ? ` filter="url(#${blurId})"` : ''}>${s}</g>`;
}

/* 绸缎流光：参考图同系的大尺度弧形丝带（横渐变色带 + 重度柔化） */
function silkRibbon(id, y0, amp, thickness, opacity, blurId) {
  return `<path d="M -120 ${fmt(y0)} C 380 ${fmt(y0 - amp)}, 760 ${fmt(y0 + amp * 0.8)}, 1060 ${fmt(y0 - amp * 0.4)} `
    + `C 1380 ${fmt(y0 - amp * 1.2)}, 1720 ${fmt(y0 + amp * 0.5)}, 2040 ${fmt(y0 - amp * 0.6)}"`
    + ` stroke="url(#${id})" stroke-width="${thickness}" fill="none" opacity="${opacity}" filter="url(#${blurId})" stroke-linecap="round"/>`;
}

/* 底部暗化带：保证任何主题下文字区对比度 */
function bottomShade() {
  return `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#shadeBottom)"/>`;
}
const shadeDefs = lg('shadeBottom', 0, 0, 0, H, [
  [0, '#000000', 0], [0.55, '#000000', 0], [0.82, '#000000', 0.18], [1, '#000000', 0.42],
]);

function frame(label, defs, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${label} · 小天AIGC 欢迎屏背景 · 程序化自绘 CC0（scripts/gen-welcome-bg.js 生成） -->
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
${defs}
</defs>
${body}
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* 原 10 套深色系（整体顺延为 02~11）                                    */
/* ------------------------------------------------------------------ */

/* 盛典蓝：深蓝 + 三支舞台灯柱 + LED 点阵 + 天际光带 */
function themeBlueGala() {
  const rng = mulberry32(1001);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#071039'], [0.55, '#0D2A86'], [1, '#061640']]),
    rg('topGlow', 960, -80, 700, [[0, '#6FB4FF', 0.85], [0.5, '#2B6FE0', 0.28], [1, '#2B6FE0', 0]]),
    lg('beamG', 0, 0, 0, 900, [[0, '#CFE6FF', 0.9], [0.6, '#9CC7FF', 0.25], [1, '#9CC7FF', 0]]),
    rg('floorGlow', 960, 1030, 900, [[0, '#3E8CFF', 0.5], [1, '#3E8CFF', 0]]),
    blurF('b40', 42), blurF('b18', 18),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#topGlow)', 960, -60, 760, 520, 1),
    beam('beamG', 620, -120, 420, 520, 0.24, 'b40'),
    beam('beamG', 960, -140, 980, 700, 0.3, 'b40'),
    beam('beamG', 1300, -120, 1530, 520, 0.24, 'b40'),
    `<g filter="url(#b18)">`,
    dotGrid(rng, { x0: 60, y0: 700, cols: 45, rows: 9, dx: 40, dy: 40, colors: ['#7FB9FF', '#B9DAFF'], r: 2.2, oMin: 0.05, oMax: 0.2 }),
    `</g>`,
    glowBlob('url(#floorGlow)', 960, 1050, 1000, 220, 1),
    particles(rng, { n: 90, x: 0, y: 60, w: W, h: 640, colors: ['#FFFFFF', '#A9CEFF', '#FFE9A8'], rMin: 0.8, rMax: 2.6, oMin: 0.15, oMax: 0.7 }),
    ring(960, 560, 640, 210, '#9CC7FF', 2, 0.12),
    ring(960, 560, 860, 285, '#9CC7FF', 1.5, 0.08),
    bottomShade(),
  ].join('');
  return frame('盛典蓝', defs, body);
}

/* 喜庆红：正红 + 金色霞光 + 礼花光线 + 金粒子 */
function themeRedGala() {
  const rng = mulberry32(2002);
  const defs = [
    rg('bg', 960, 240, 1500, [[0, '#C42034'], [0.55, '#8E1220'], [1, '#5C070F']]),
    rg('goldGlow', 960, 60, 720, [[0, '#FFD777', 0.85], [0.45, '#E89B3B', 0.3], [1, '#E89B3B', 0]]),
    blurF('b30', 30), blurF('b8', 8), blurF('b60', 60),
    shadeDefs,
  ].join('');
  const burst = (cx, cy, n) => {
    const lines = [];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + rnum(rng, -0.06, 0.06);
      const len = rnum(rng, 180, 360);
      lines.push(`<line x1="${cx}" y1="${cy}" x2="${fmt(cx + Math.cos(a) * len)}" y2="${fmt(cy + Math.sin(a) * len)}" stroke="${rng() > 0.4 ? '#FFD777' : '#FFF3C4'}" stroke-width="${fmt(rnum(rng, 1.5, 3.5))}" opacity="${fmt(rnum(rng, 0.25, 0.7))}" stroke-linecap="round"/>`);
    }
    return `<g filter="url(#b8)">${lines.join('')}<circle cx="${cx}" cy="${cy}" r="10" fill="#FFF3C4" opacity="0.9"/></g>`;
  };
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#goldGlow)', 960, 40, 740, 420, 1),
    `<g filter="url(#b60)" opacity="0.5">`,
    `<path d="M -100 820 C 420 700 760 880 1180 800 C 1520 730 1780 780 2020 720 L 2020 1120 L -100 1120 Z" fill="#7A0A14"/>`,
    `<path d="M -100 900 C 380 830 900 960 1350 880 C 1650 830 1860 860 2020 840 L 2020 1120 L -100 1120 Z" fill="#E89B3B" opacity="0.55"/>`,
    `</g>`,
    burst(320, 210, 22), burst(1600, 260, 26), burst(1230, 130, 16),
    particles(rng, { n: 130, x: 0, y: 0, w: W, h: H, colors: ['#FFD777', '#FFF3C4', '#FF9E66'], rMin: 0.8, rMax: 3, oMin: 0.15, oMax: 0.75 }),
    bottomShade(),
  ].join('');
  return frame('喜庆红', defs, body);
}

/* 紫金会宴：皇家紫 + 金光流苏 + 底部金带 */
function themePurpleGold() {
  const rng = mulberry32(3003);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#26083C'], [0.55, '#571A5E'], [1, '#2A0A3A']]),
    rg('royalGlow', 960, -40, 680, [[0, '#E78CFF', 0.7], [0.5, '#A64CE0', 0.25], [1, '#A64CE0', 0]]),
    lg('goldBand', 0, 960, 0, H, [[0, '#FFD777', 0], [1, '#FFC24B', 0.45]]),
    blurF('b24', 24), blurF('b70', 70),
    shadeDefs,
  ].join('');
  let tassel = '';
  for (let i = 0; i < 26; i++) {
    const x = rnum(rng, 120, W - 120); const len = rnum(rng, 90, 260); const w = rnum(rng, 2, 6);
    tassel += `<path d="M ${fmt(x)} -20 q ${fmt(rnum(rng, -24, 24))} ${fmt(len / 2)} 0 ${fmt(len)}" stroke="#FFD777" stroke-width="${fmt(w)}" fill="none" opacity="${fmt(rnum(rng, 0.12, 0.4))}" stroke-linecap="round"/>`;
  }
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#royalGlow)', 960, -40, 700, 460, 1),
    `<g filter="url(#b24)">${tassel}</g>`,
    glowBlob('#FF9EF2', 300, 860, 420, 240, 0.25, 'b70'),
    glowBlob('#FFD777', 1650, 900, 460, 260, 0.28, 'b70'),
    `<rect x="0" y="960" width="${W}" height="120" fill="url(#goldBand)"/>`,
    particles(rng, { n: 110, x: 0, y: 40, w: W, h: 900, colors: ['#FFD777', '#FFF3C4', '#FF9EF2'], rMin: 0.8, rMax: 3.2, oMin: 0.15, oMax: 0.7 }),
    ring(960, 520, 700, 230, '#E7B0FF', 2, 0.1),
    bottomShade(),
  ].join('');
  return frame('紫金会宴', defs, body);
}

/* 科技蓝：深空蓝黑 + 地平线光刃 + 透视网格 + 青粒子 */
function themeTechBlue() {
  const rng = mulberry32(4004);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#02060F'], [0.6, '#0A1B3A'], [1, '#040A18']]),
    rg('cyanTL', 240, 120, 620, [[0, '#22D3EE', 0.5], [1, '#22D3EE', 0]]),
    rg('magBR', 1720, 980, 640, [[0, '#C026D3', 0.4], [1, '#C026D3', 0]]),
    lg('horizon', 0, 0, W, 0, [[0, '#38F3FF', 0], [0.5, '#38F3FF', 0.9], [1, '#38F3FF', 0]]),
    blurF('b50', 50), blurF('b6', 6),
    shadeDefs,
  ].join('');
  let grid = '';
  const horizonY = 640;
  for (let i = -8; i <= 8; i++) {
    grid += `<line x1="${fmt(960 + i * 70)}" y1="${horizonY}" x2="${fmt(960 + i * 220)}" y2="${H}" stroke="#38F3FF" stroke-width="1.4" opacity="0.25"/>`;
  }
  for (let j = 0; j < 9; j++) {
    const y = horizonY + Math.pow(j + 1, 2) * 5.2;
    grid += `<line x1="0" y1="${fmt(y)}" x2="${W}" y2="${fmt(y)}" stroke="#38F3FF" stroke-width="1.2" opacity="${fmt(0.28 - j * 0.026)}"/>`;
  }
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#cyanTL)', 240, 120, 620, 400, 1, 'b50'),
    glowBlob('url(#magBR)', 1720, 980, 640, 380, 1, 'b50'),
    `<g filter="url(#b6)">${grid}</g>`,
    `<rect x="0" y="${horizonY - 2}" width="${W}" height="4" fill="url(#horizon)"/>`,
    `<rect x="0" y="${horizonY - 14}" width="${W}" height="28" fill="url(#horizon)" opacity="0.35" filter="url(#b6)"/>`,
    particles(rng, { n: 150, x: 0, y: 0, w: W, h: horizonY - 40, colors: ['#38F3FF', '#7DD3FC', '#FFFFFF'], rMin: 0.7, rMax: 2.4, oMin: 0.15, oMax: 0.8 }),
    ring(960, 640, 520, 170, '#38F3FF', 1.5, 0.14),
    bottomShade(),
  ].join('');
  return frame('科技蓝', defs, body);
}

/* 学术青：深青绿 + 柔光 + 星轨连线 */
function themeTealAcademic() {
  const rng = mulberry32(5005);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#03211D'], [0.55, '#0A4A40'], [1, '#062B27']]),
    rg('mintGlow', 960, -60, 640, [[0, '#7CF5D3', 0.55], [0.5, '#2BB99B', 0.2], [1, '#2BB99B', 0]]),
    lg('mbeam', 0, 0, 0, 880, [[0, '#D8FFF2', 0.65], [1, '#D8FFF2', 0]]),
    blurF('b36', 36), blurF('b10', 10),
    shadeDefs,
  ].join('');
  const pts = [];
  for (let i = 0; i < 26; i++) pts.push([rnum(rng, 80, W - 80), rnum(rng, 120, 880)]);
  let links = '';
  for (let i = 0; i < pts.length - 1; i += 2) {
    links += `<line x1="${fmt(pts[i][0])}" y1="${fmt(pts[i][1])}" x2="${fmt(pts[i + 1][0])}" y2="${fmt(pts[i + 1][1])}" stroke="#B9F5E4" stroke-width="1" opacity="0.14"/>`;
  }
  const dots = pts.map((p) => `<circle cx="${fmt(p[0])}" cy="${fmt(p[1])}" r="${fmt(rnum(rng, 1.4, 3.4))}" fill="#D8FFF2" opacity="${fmt(rnum(rng, 0.25, 0.7))}"/>`).join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#mintGlow)', 960, -60, 660, 440, 1),
    beam('mbeam', 780, -80, 620, 380, 0.14, 'b36'),
    beam('mbeam', 1140, -80, 1320, 380, 0.14, 'b36'),
    `<g filter="url(#b10)">${dotGrid(rng, { x0: 120, y0: 760, cols: 42, rows: 7, dx: 40, dy: 42, colors: ['#8CF3D6', '#D8FFF2'], r: 2, oMin: 0.04, oMax: 0.16 })}</g>`,
    `<g>${links}${dots}</g>`,
    glowBlob('#7CF5D3', 1660, 980, 420, 220, 0.16, 'b36'),
    bottomShade(),
  ].join('');
  return frame('学术青', defs, body);
}

/* 金色大厅：深棕金 + 顶部金光放射 + 金尘 */
function themeGoldenHall() {
  const rng = mulberry32(6006);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#120A02'], [0.5, '#3D2807'], [1, '#160D03']]),
    rg('sun', 960, -60, 620, [[0, '#FFE9A8', 0.95], [0.4, '#D9A941', 0.4], [1, '#D9A941', 0]]),
    blurF('b14', 14), blurF('b60', 60),
    shadeDefs,
  ].join('');
  let rays = '';
  for (let i = 0; i < 26; i++) {
    const a = (Math.PI * i) / 25;
    const dx = Math.cos(a - Math.PI) * 1300;
    rays += `<polygon points="960,-40 ${fmt(960 + dx - 42)},${H} ${fmt(960 + dx + 42)},${H}" fill="#FFD777" opacity="${fmt(rnum(rng, 0.05, 0.16))}"/>`;
  }
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#sun)', 960, -60, 640, 420, 1),
    `<g filter="url(#b14)">${rays}</g>`,
    glowBlob('#FFD777', 300, 1000, 380, 220, 0.2, 'b60'),
    glowBlob('#FFD777', 1640, 1000, 380, 220, 0.2, 'b60'),
    particles(rng, { n: 160, x: 0, y: 0, w: W, h: H, colors: ['#FFD777', '#FFF3C4', '#E8B64B'], rMin: 0.7, rMax: 2.8, oMin: 0.2, oMax: 0.8 }),
    ring(960, 580, 660, 215, '#FFD777', 2, 0.14),
    bottomShade(),
  ].join('');
  return frame('金色大厅', defs, body);
}

/* 红绸迎宾：深红底 + 金色流光绸带 */
function themeRedSilk() {
  const rng = mulberry32(7007);
  const defs = [
    lg('bg', 0, 0, W, H, [[0, '#6E0E0E'], [0.5, '#A81F1F'], [1, '#620B0B']]),
    rg('silkGlow', 960, 60, 760, [[0, '#FF9E7B', 0.5], [1, '#FF9E7B', 0]]),
    lg('ribbon', 0, 0, W, 0, [[0, '#FFD777', 0], [0.5, '#FFD777', 0.75], [1, '#FFD777', 0]]),
    blurF('b24', 24), blurF('b8', 8),
    shadeDefs,
  ].join('');
  const ribbon = (y0, amp, op, blurId) =>
    `<path d="M -80 ${fmt(y0)} C 420 ${fmt(y0 - amp)}, 720 ${fmt(y0 + amp)}, 1020 ${fmt(y0)} S 1760 ${fmt(y0 - amp)}, 2020 ${fmt(y0 + amp * 0.4)}" stroke="url(#ribbon)" stroke-width="52" fill="none" opacity="${op}"${blurId ? ` filter="url(#${blurId})"` : ''} stroke-linecap="round"/>`;
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#silkGlow)', 960, 60, 780, 420, 1),
    ribbon(300, 130, 0.5, 'b24'), ribbon(420, 150, 0.4, 'b24'), ribbon(560, 120, 0.32, 'b24'),
    ribbon(340, 140, 0.55, 'b8'), ribbon(500, 130, 0.4, 'b8'),
    particles(rng, { n: 120, x: 0, y: 60, w: W, h: 880, colors: ['#FFD777', '#FFF3C4', '#FF9E7B'], rMin: 0.8, rMax: 3, oMin: 0.15, oMax: 0.7 }),
    bottomShade(),
  ].join('');
  return frame('红绸迎宾', defs, body);
}

/* 深蓝光柱：深海蓝 + 中央天光束 + 光池 + 星尘 */
function themeBluePillar() {
  const rng = mulberry32(8008);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#010A18'], [0.6, '#0A2B5A'], [1, '#04122C']]),
    lg('pillar', 880, 0, 1040, 0, [[0, '#9CD4FF', 0], [0.5, '#CFE9FF', 0.9], [1, '#9CD4FF', 0]]),
    rg('pool', 960, 1000, 520, [[0, '#B9E4FF', 0.75], [0.55, '#3E8CFF', 0.25], [1, '#3E8CFF', 0]]),
    blurF('b40', 40), blurF('b12', 12),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    particles(rng, { n: 140, x: 0, y: 0, w: W, h: 520, colors: ['#FFFFFF', '#A9CEFF'], rMin: 0.6, rMax: 1.8, oMin: 0.1, oMax: 0.6 }),
    `<rect x="860" y="-60" width="200" height="${H + 120}" fill="url(#pillar)" filter="url(#b40)" opacity="0.85"/>`,
    `<rect x="930" y="-60" width="60" height="${H + 120}" fill="#EAF6FF" filter="url(#b12)" opacity="0.8"/>`,
    glowBlob('url(#pool)', 960, 1010, 560, 180, 1),
    particles(rng, { n: 80, x: 720, y: 300, w: 480, h: 640, colors: ['#B9E4FF', '#FFFFFF', '#7FB9FF'], rMin: 0.9, rMax: 3, oMin: 0.2, oMax: 0.85 }),
    ring(960, 760, 340, 90, '#B9E4FF', 2, 0.2),
    bottomShade(),
  ].join('');
  return frame('深蓝光柱', defs, body);
}

/* 峰会灰蓝：高级灰蓝 + 斜向柔光 + 细线条 */
function themeSlate() {
  const rng = mulberry32(9009);
  const defs = [
    lg('bg', 0, 0, W, H, [[0, '#141E30'], [0.5, '#2C3F5E'], [1, '#16233A']]),
    rg('slateGlow', 480, 200, 760, [[0, '#89A9D9', 0.45], [1, '#89A9D9', 0]]),
    rg('slateGlow2', 1560, 920, 720, [[0, '#5E84C4', 0.4], [1, '#5E84C4', 0]]),
    blurF('b70', 70), blurF('b18', 18),
    shadeDefs,
  ].join('');
  let lines = '';
  for (let i = 0; i < 14; i++) {
    const y = 90 + i * 66;
    lines += `<line x1="0" y1="${y}" x2="${W}" y2="${fmt(y - 300)}" stroke="#C7DAF5" stroke-width="1" opacity="0.07"/>`;
  }
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#slateGlow)', 480, 200, 760, 420, 1, 'b70'),
    glowBlob('url(#slateGlow2)', 1560, 920, 720, 420, 1, 'b70'),
    `<g filter="url(#b18)">`,
    `<polygon points="1380,-40 1920,-40 560,1120 40,1120" fill="#9DB8E4" opacity="0.1"/>`,
    `<polygon points="1620,-40 1920,-40 900,1120 640,1120" fill="#C7DAF5" opacity="0.08"/>`,
    `</g>`,
    `<g>${lines}</g>`,
    dotGrid(rng, { x0: 100, y0: 140, cols: 12, rows: 4, dx: 46, dy: 46, colors: ['#C7DAF5'], r: 1.8, oMin: 0.05, oMax: 0.16 }),
    particles(rng, { n: 60, x: 0, y: 0, w: W, h: H, colors: ['#C7DAF5', '#FFFFFF'], rMin: 0.8, rMax: 2, oMin: 0.1, oMax: 0.45 }),
    `<rect x="0" y="1010" width="${W}" height="3" fill="#9DB8E4" opacity="0.3"/>`,
    bottomShade(),
  ].join('');
  return frame('峰会灰蓝', defs, body);
}

/* 暖橙礼遇：琥珀橙 + 大光圈虚化 + 暖尘 */
function themeWarmOrange() {
  const rng = mulberry32(1010);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#2A0E02'], [0.55, '#7C320B'], [1, '#2A0E02']]),
    rg('warmGlow', 960, 60, 700, [[0, '#FFB35C', 0.6], [0.5, '#D97B2B', 0.22], [1, '#D97B2B', 0]]),
    blurF('b12', 12), blurF('b30', 30), blurF('b50', 50),
    shadeDefs,
  ].join('');
  const bokeh = (blurId, n, rMin, rMax, oMin, oMax, colors) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      s += `<circle cx="${fmt(rnum(rng, -40, W + 40))}" cy="${fmt(rnum(rng, -40, H + 40))}" r="${fmt(rnum(rng, rMin, rMax))}" fill="${pick(rng, colors)}" opacity="${fmt(rnum(rng, oMin, oMax))}"/>`;
    }
    return `<g filter="url(#${blurId})">${s}</g>`;
  };
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#warmGlow)', 960, 40, 720, 440, 1),
    bokeh('b50', 14, 60, 130, 0.06, 0.14, ['#FFB35C', '#FFD777', '#FF8A3B']),
    bokeh('b30', 20, 26, 60, 0.08, 0.2, ['#FFB35C', '#FFD777', '#FF8A3B', '#FFF3C4']),
    bokeh('b12', 16, 6, 22, 0.12, 0.34, ['#FFD777', '#FFF3C4']),
    particles(rng, { n: 90, x: 0, y: 0, w: W, h: H, colors: ['#FFD777', '#FFF3C4'], rMin: 0.8, rMax: 2.6, oMin: 0.15, oMax: 0.7 }),
    bottomShade(),
  ].join('');
  return frame('暖橙礼遇', defs, body);
}

/* ------------------------------------------------------------------ */
/* 参考图同系：绸缎流光 + 城市剪影（亮调为主，鎏金大气）                  */
/* ------------------------------------------------------------------ */

/* 12 红金筑梦：赤红天幕 + 鎏金绸带 + 金色城市剪影 */
function themeRedGoldCity() {
  const rng = mulberry32(1212);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#8A1220'], [0.45, '#B7232E'], [0.8, '#7E101B'], [1, '#5C070F']]),
    rg('sunGold', 960, 60, 900, [[0, '#FFE9A8', 0.9], [0.4, '#F0B45C', 0.4], [1, '#F0B45C', 0]]),
    lg('silkG', 0, 0, W, 0, [[0, '#FFE9A8', 0], [0.35, '#FFD777', 0.85], [0.65, '#FFF3C4', 0.6], [1, '#FFD777', 0]]),
    lg('silkR', 0, 0, W, 0, [[0, '#FF9E7B', 0], [0.5, '#FFB98E', 0.55], [1, '#FF9E7B', 0]]),
    blurF('b40', 40), blurF('b8', 8), blurF('b4', 4),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#sunGold)', 960, 80, 980, 520, 1),
    silkRibbon('silkG', 320, 150, 120, 0.5, 'b40'),
    silkRibbon('silkR', 430, 170, 90, 0.4, 'b40'),
    silkRibbon('silkG', 540, 130, 60, 0.55, 'b40'),
    silkRibbon('silkG', 380, 140, 26, 0.7, 'b8'),
    silkRibbon('silkG', 500, 150, 16, 0.8, 'b4'),
    citySkyline(rng, { x1: W + 40, y: 1060, w: 1160, hMin: 60, hMax: 260, color: '#3D0A0E', opacity: 0.85 }),
    citySkyline(rng, { x1: W + 60, y: 1080, w: 900, hMin: 30, hMax: 130, color: '#F0B45C', opacity: 0.35, blurId: 'b8' }),
    particles(rng, { n: 110, x: 0, y: 0, w: W, h: 900, colors: ['#FFD777', '#FFF3C4', '#FF9E66'], rMin: 0.8, rMax: 2.8, oMin: 0.15, oMax: 0.7 }),
    ring(960, 620, 700, 240, '#FFD777', 2, 0.12),
    bottomShade(),
  ].join('');
  return frame('红金筑梦', defs, body);
}

/* 13 蓝金致远：宝蓝天幕 + 香槟金绸带 + 金色城市剪影 */
function themeBlueGoldCity() {
  const rng = mulberry32(1313);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#0A1F4E'], [0.45, '#1B3D8F'], [0.8, '#0E2A66'], [1, '#071740']]),
    rg('sunBlue', 960, 40, 860, [[0, '#BFD9FF', 0.8], [0.45, '#4D84E0', 0.32], [1, '#4D84E0', 0]]),
    lg('silkB', 0, 0, W, 0, [[0, '#FFE9A8', 0], [0.4, '#F0C77F', 0.8], [0.7, '#FFF3C4', 0.55], [1, '#F0C77F', 0]]),
    lg('silkC', 0, 0, W, 0, [[0, '#9CC7FF', 0], [0.5, '#CFE6FF', 0.5], [1, '#9CC7FF', 0]]),
    blurF('b40', 40), blurF('b8', 8), blurF('b4', 4),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#sunBlue)', 960, 40, 920, 480, 1),
    silkRibbon('silkB', 340, 160, 110, 0.45, 'b40'),
    silkRibbon('silkC', 450, 170, 80, 0.35, 'b40'),
    silkRibbon('silkB', 560, 140, 50, 0.5, 'b40'),
    silkRibbon('silkB', 390, 150, 24, 0.65, 'b8'),
    silkRibbon('silkC', 520, 140, 14, 0.6, 'b4'),
    citySkyline(rng, { x1: W + 40, y: 1060, w: 1160, hMin: 60, hMax: 250, color: '#050E28', opacity: 0.85 }),
    citySkyline(rng, { x1: W + 60, y: 1080, w: 900, hMin: 30, hMax: 120, color: '#F0C77F', opacity: 0.3, blurId: 'b8' }),
    particles(rng, { n: 100, x: 0, y: 0, w: W, h: 880, colors: ['#FFE9A8', '#CFE6FF', '#FFFFFF'], rMin: 0.8, rMax: 2.6, oMin: 0.15, oMax: 0.7 }),
    ring(960, 600, 720, 250, '#F0C77F', 1.8, 0.12),
    bottomShade(),
  ].join('');
  return frame('蓝金致远', defs, body);
}

/* 14 青云致远：浅青天光 + 白玉绸带 + 淡墨城市剪影 */
function themeTealDawn() {
  const rng = mulberry32(1414);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#BFE4DC'], [0.5, '#E8F5F0'], [1, '#CFEAE2']]),
    rg('mintSun', 960, 80, 900, [[0, '#FFFFFF', 0.9], [0.5, '#D8F5EA', 0.35], [1, '#D8F5EA', 0]]),
    lg('silkT', 0, 0, W, 0, [[0, '#7BD4BE', 0], [0.4, '#A9E8D5', 0.7], [0.7, '#EAFBF4', 0.6], [1, '#7BD4BE', 0]]),
    lg('silkW', 0, 0, W, 0, [[0, '#FFFFFF', 0], [0.5, '#FFFFFF', 0.8], [1, '#FFFFFF', 0]]),
    blurF('b40', 40), blurF('b8', 8),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#mintSun)', 960, 80, 940, 500, 1),
    silkRibbon('silkT', 340, 150, 120, 0.55, 'b40'),
    silkRibbon('silkW', 430, 160, 90, 0.5, 'b40'),
    silkRibbon('silkT', 560, 130, 40, 0.5, 'b40'),
    silkRibbon('silkW', 470, 140, 20, 0.75, 'b8'),
    citySkyline(rng, { x1: W + 40, y: 1060, w: 1100, hMin: 60, hMax: 240, color: '#4A7A70', opacity: 0.4, blurId: 'b8' }),
    citySkyline(rng, { x1: W + 60, y: 1080, w: 880, hMin: 30, hMax: 120, color: '#2E5A52', opacity: 0.5 }),
    particles(rng, { n: 70, x: 0, y: 0, w: W, h: 860, colors: ['#FFFFFF', '#A9E8D5'], rMin: 0.9, rMax: 2.6, oMin: 0.15, oMax: 0.6 }),
    bottomShade(),
  ].join('');
  return frame('青云致远', defs, body);
}

/* 15 晨曦鎏光：浅香槟晨光 + 粉金绸带 + 暖灰城市剪影（参考图的姊妹款） */
function themeDawnChampagne() {
  const rng = mulberry32(1515);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#C9D8EF'], [0.42, '#FDF2E2'], [1, '#F3E2C8']]),
    rg('dawnSun', 960, 60, 860, [[0, '#FFFDF5', 0.95], [0.5, '#FFE9C4', 0.4], [1, '#FFE9C4', 0]]),
    lg('silkP', 0, 0, W, 0, [[0, '#F2B88A', 0], [0.4, '#F8D3A8', 0.75], [0.7, '#FFF3E0', 0.6], [1, '#F2B88A', 0]]),
    lg('silkW2', 0, 0, W, 0, [[0, '#FFFFFF', 0], [0.5, '#FFFFFF', 0.85], [1, '#FFFFFF', 0]]),
    blurF('b40', 40), blurF('b8', 8),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#dawnSun)', 960, 60, 900, 480, 1),
    silkRibbon('silkP', 320, 160, 130, 0.5, 'b40'),
    silkRibbon('silkW2', 440, 170, 90, 0.55, 'b40'),
    silkRibbon('silkP', 560, 140, 46, 0.5, 'b40'),
    silkRibbon('silkW2', 490, 150, 22, 0.8, 'b8'),
    citySkyline(rng, { x1: W + 40, y: 1060, w: 1120, hMin: 60, hMax: 240, color: '#8A7360', opacity: 0.35, blurId: 'b8' }),
    citySkyline(rng, { x1: W + 60, y: 1080, w: 860, hMin: 30, hMax: 110, color: '#6A5A4A', opacity: 0.4 }),
    particles(rng, { n: 80, x: 0, y: 0, w: W, h: 860, colors: ['#FFE9C4', '#FFFFFF', '#F8C98E'], rMin: 0.9, rMax: 2.6, oMin: 0.15, oMax: 0.6 }),
    bottomShade(),
  ].join('');
  return frame('晨曦鎏光', defs, body);
}

/* 16 朱红盛典：亮朱红绸面 + 浓金粒子 + 金色星芒 */
function themeVermilion() {
  const rng = mulberry32(1616);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#B3202A'], [0.5, '#D5303A'], [1, '#8E1620']]),
    rg('redSun', 960, 100, 820, [[0, '#FF8A6A', 0.7], [0.5, '#E05248', 0.3], [1, '#E05248', 0]]),
    lg('silkV', 0, 0, W, 0, [[0, '#FFD777', 0], [0.45, '#FFE9A8', 0.7], [0.75, '#FFF3C4', 0.5], [1, '#FFD777', 0]]),
    blurF('b30', 30), blurF('b6', 6),
    shadeDefs,
  ].join('');
  const starburst = (cx, cy, r) => {
    let s = `<circle cx="${cx}" cy="${cy}" r="4" fill="#FFF3C4"/>`;
    for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const dx = Math.cos(a) * r; const dy = Math.sin(a) * r;
      s += `<line x1="${fmt(cx - dx)}" y1="${fmt(cy - dy)}" x2="${fmt(cx + dx)}" y2="${fmt(cy + dy)}" stroke="#FFE9A8" stroke-width="2.4" stroke-linecap="round" opacity="0.9"/>`;
    }
    return `<g filter="url(#b6)">${s}</g>`;
  };
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#redSun)', 960, 100, 860, 500, 1),
    silkRibbon('silkV', 330, 150, 110, 0.4, 'b30'),
    silkRibbon('silkV', 470, 160, 70, 0.45, 'b30'),
    silkRibbon('silkV', 420, 140, 20, 0.65, 'b6'),
    starburst(360, 220, 60), starburst(1560, 180, 80), starburst(1280, 420, 40),
    particles(rng, { n: 180, x: 0, y: 0, w: W, h: H, colors: ['#FFD777', '#FFF3C4', '#FFE9A8'], rMin: 0.8, rMax: 3, oMin: 0.2, oMax: 0.85 }),
    bottomShade(),
  ].join('');
  return frame('朱红盛典', defs, body);
}

/* 17 深空鎏金：极深藏青 + 鎏金粒子雨 + 金色地平线 */
function themeDeepNavyGold() {
  const rng = mulberry32(1717);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#04060E'], [0.6, '#0B1226'], [1, '#04060E']]),
    lg('goldHorizon', 0, 0, W, 0, [[0, '#FFD777', 0], [0.5, '#FFD777', 0.9], [1, '#FFD777', 0]]),
    rg('goldMid', 960, 720, 700, [[0, '#F0B45C', 0.35], [1, '#F0B45C', 0]]),
    blurF('b20', 20), blurF('b4', 4),
    shadeDefs,
  ].join('');
  const rain = (blurId, n, oMin, oMax) => particles(rng, { n, x: 0, y: 0, w: W, h: H, colors: ['#FFD777', '#FFF3C4', '#F0B45C'], rMin: 0.7, rMax: 2.4, oMin, oMax });
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#goldMid)', 960, 760, 800, 320, 1),
    `<rect x="0" y="760" width="${W}" height="3" fill="url(#goldHorizon)"/>`,
    `<rect x="0" y="750" width="${W}" height="22" fill="url(#goldHorizon)" opacity="0.3" filter="url(#b20)"/>`,
    `<g filter="url(#b4)">${rain('b4', 260, 0.1, 0.5)}</g>`,
    rain(null, 120, 0.25, 0.8),
    ring(960, 720, 620, 190, '#FFD777', 1.5, 0.16),
    bottomShade(),
  ].join('');
  return frame('深空鎏金', defs, body);
}

/* 18 霁蓝轻纱：浅蓝白天光 + 白绸带 + 淡蓝城市剪影 */
function themeAzureVeil() {
  const rng = mulberry32(1818);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#AFC9EE'], [0.5, '#E4EFFB'], [1, '#C9DDF4']]),
    rg('azureSun', 960, 60, 880, [[0, '#FFFFFF', 0.95], [0.5, '#D8E8FA', 0.4], [1, '#D8E8FA', 0]]),
    lg('silkA', 0, 0, W, 0, [[0, '#7FA9DE', 0], [0.4, '#A9C8EE', 0.7], [0.7, '#EAF3FD', 0.65], [1, '#7FA9DE', 0]]),
    lg('silkW3', 0, 0, W, 0, [[0, '#FFFFFF', 0], [0.5, '#FFFFFF', 0.85], [1, '#FFFFFF', 0]]),
    blurF('b40', 40), blurF('b8', 8),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#azureSun)', 960, 60, 920, 480, 1),
    silkRibbon('silkA', 330, 150, 120, 0.5, 'b40'),
    silkRibbon('silkW3', 440, 165, 90, 0.55, 'b40'),
    silkRibbon('silkA', 555, 135, 44, 0.5, 'b40'),
    silkRibbon('silkW3', 480, 145, 22, 0.8, 'b8'),
    citySkyline(rng, { x1: W + 40, y: 1060, w: 1100, hMin: 60, hMax: 230, color: '#5A7AAE', opacity: 0.35, blurId: 'b8' }),
    citySkyline(rng, { x1: W + 60, y: 1080, w: 860, hMin: 30, hMax: 110, color: '#3A5A8E', opacity: 0.4 }),
    particles(rng, { n: 70, x: 0, y: 0, w: W, h: 860, colors: ['#FFFFFF', '#C9E0FA'], rMin: 0.9, rMax: 2.4, oMin: 0.15, oMax: 0.6 }),
    bottomShade(),
  ].join('');
  return frame('霁蓝轻纱', defs, body);
}

/* 19 墨玉华章：深墨绿 + 金色弧线与立柱光 */
function themeInkJade() {
  const rng = mulberry32(1919);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#061410'], [0.55, '#0D2B22'], [1, '#071811']]),
    rg('jadeGlow', 960, -40, 720, [[0, '#7BD4BE', 0.5], [0.5, '#2B6B5A', 0.22], [1, '#2B6B5A', 0]]),
    lg('goldLine', 0, 0, W, 0, [[0, '#FFD777', 0], [0.5, '#FFE9A8', 0.9], [1, '#FFD777', 0]]),
    blurF('b30', 30), blurF('b8', 8),
    shadeDefs,
  ].join('');
  let arcs = '';
  for (let i = 0; i < 5; i++) {
    const rx = 480 + i * 160; const ry = 130 + i * 42;
    arcs += `<path d="M ${960 - rx} 1080 A ${rx} ${ry} 0 0 1 ${960 + rx} 1080" stroke="url(#goldLine)" stroke-width="2" fill="none" opacity="${fmt(0.3 - i * 0.045)}"/>`;
  }
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#jadeGlow)', 960, -40, 740, 460, 1),
    `<g filter="url(#b30)">${beam('goldLine', 700, -60, 560, 320, 0.1, 'b30')}${beam('goldLine', 1220, -60, 1360, 320, 0.1, 'b30')}</g>`,
    `<g>${arcs}</g>`,
    particles(rng, { n: 100, x: 0, y: 0, w: W, h: 920, colors: ['#FFE9A8', '#7BD4BE', '#FFF3C4'], rMin: 0.8, rMax: 2.6, oMin: 0.15, oMax: 0.7 }),
    bottomShade(),
  ].join('');
  return frame('墨玉华章', defs, body);
}

/* 20 盛世红轴：深红天地 + 中央金色光轴竖幅 */
function themeRedScroll() {
  const rng = mulberry32(2020);
  const defs = [
    lg('bg', 0, 0, 0, H, [[0, '#4A060C'], [0.5, '#7E101B'], [1, '#4A060C']]),
    lg('scroll', 860, 0, 1060, 0, [[0, '#FFD777', 0], [0.5, '#FFE9A8', 0.85], [1, '#FFD777', 0]]),
    rg('redGlow', 960, 60, 780, [[0, '#E05248', 0.7], [1, '#E05248', 0]]),
    blurF('b40', 40), blurF('b10', 10),
    shadeDefs,
  ].join('');
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`,
    glowBlob('url(#redGlow)', 960, 60, 800, 460, 1),
    `<rect x="830" y="-60" width="260" height="${H + 120}" fill="url(#scroll)" filter="url(#b40)" opacity="0.6"/>`,
    `<rect x="940" y="-60" width="40" height="${H + 120}" fill="#FFF3C4" filter="url(#b10)" opacity="0.75"/>`,
    particles(rng, { n: 130, x: 0, y: 0, w: W, h: H, colors: ['#FFD777', '#FFF3C4', '#FF9E66'], rMin: 0.8, rMax: 2.8, oMin: 0.15, oMax: 0.75 }),
    ring(960, 1080, 700, 220, '#FFD777', 2, 0.14),
    bottomShade(),
  ].join('');
  return frame('盛世红轴', defs, body);
}

/* ------------------------------------------------------------------ */
const THEMES = [
  ['01.png', '鎏金风华', null], // 用户选定参考图（PNG 复制）
  ['02.svg', '盛典蓝', themeBlueGala],
  ['03.svg', '喜庆红', themeRedGala],
  ['04.svg', '紫金会宴', themePurpleGold],
  ['05.svg', '科技蓝', themeTechBlue],
  ['06.svg', '学术青', themeTealAcademic],
  ['07.svg', '金色大厅', themeGoldenHall],
  ['08.svg', '红绸迎宾', themeRedSilk],
  ['09.svg', '深蓝光柱', themeBluePillar],
  ['10.svg', '峰会灰蓝', themeSlate],
  ['11.svg', '暖橙礼遇', themeWarmOrange],
  ['12.svg', '红金筑梦', themeRedGoldCity],
  ['13.svg', '蓝金致远', themeBlueGoldCity],
  ['14.svg', '青云致远', themeTealDawn],
  ['15.svg', '晨曦鎏光', themeDawnChampagne],
  ['16.svg', '朱红盛典', themeVermilion],
  ['17.svg', '深空鎏金', themeDeepNavyGold],
  ['18.svg', '霁蓝轻纱', themeAzureVeil],
  ['19.svg', '墨玉华章', themeInkJade],
  ['20.svg', '盛世红轴', themeRedScroll],
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 清掉旧的编号素材，保证目录与 manifest 一一对应
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/^\d{2}\.(jpg|png|svg)$/i.test(f)) { fs.unlinkSync(path.join(OUT_DIR, f)); console.log(`✖ 清理旧文件 ${f}`); }
  }
  const manifest = [];
  for (const [file, label, build] of THEMES) {
    if (file === '01.png') {
      if (fs.existsSync(REF_PNG)) {
        fs.copyFileSync(REF_PNG, path.join(OUT_DIR, file));
        const bytes = fs.statSync(path.join(OUT_DIR, file)).size;
        manifest.push({ file, label, source: '用户提供参考图（教务系统/LED背景）', sizeBytes: bytes });
        console.log(`✔ ${file} ${label}（参考图复制，${(bytes / 1024).toFixed(0)} KB）`);
      } else {
        console.error(`!! 参考图缺失：${REF_PNG}，01.png 未生成`);
      }
      continue;
    }
    const svg = build();
    fs.writeFileSync(path.join(OUT_DIR, file), svg, 'utf8');
    const bytes = Buffer.byteLength(svg);
    manifest.push({ file, label, source: '程序化自绘（CC0，scripts/gen-welcome-bg.js 生成）', sizeBytes: bytes });
    console.log(`✔ ${file} ${label} ${(bytes / 1024).toFixed(1)} KB`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`\n完成：${manifest.length} 套背景 → ${OUT_DIR}`);
}

main();
