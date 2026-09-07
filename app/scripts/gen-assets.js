/* 生成应用图标：纯 Node 实现 PNG 编码与 ICO 打包，无第三方依赖
 * 产物：build/icon.ico（安装/窗口图标）、resources/icon.png（托盘/窗口） */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 绘制 ---------- */
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function roundRectSDF(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bars = [
    { cx: 0.30, h: 0.38 },
    { cx: 0.50, h: 0.64 },
    { cx: 0.70, h: 0.50 },
  ];
  const bw = size * 0.14;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      // 圆角方形底板（留 4% 边距）
      const m = size * 0.04;
      const d = roundRectSDF(px, py, size / 2, size / 2, size / 2 - m, size / 2 - m, size * 0.22);
      let a = clamp01(0.5 - d);
      if (a <= 0) continue;
      // 蓝紫渐变底
      const t = py / size;
      let R = Math.round(76 + (122 - 76) * t);
      let G = Math.round(141 + (92 - 141) * t);
      let B = Math.round(255 + (255 - 255) * t);
      // 白色均衡器条
      for (const b of bars) {
        const bh = size * b.h;
        const db = roundRectSDF(px, py, size * b.cx, size / 2, bw / 2, bh / 2, bw / 2);
        if (db < 0) { R = 255; G = 255; B = 255; break; }
      }
      const i = (y * size + x) * 4;
      rgba[i] = R; rgba[i + 1] = G; rgba[i + 2] = B; rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

/* ---------- ICO 打包（PNG 内嵌，Vista+ 支持） ---------- */
function encodeICO(pngs) {
  const count = pngs.length;
  const head = Buffer.alloc(6);
  head[0] = 0; head[1] = 0; head[2] = 1; head[3] = 0;
  head[4] = count & 0xff; head[5] = 0;
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const datas = [];
  pngs.forEach((p, i) => {
    const e = entries.subarray(i * 16, i * 16 + 16);
    e[0] = p.size >= 256 ? 0 : p.size;
    e[1] = p.size >= 256 ? 0 : p.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.png.length;
    datas.push(p.png);
  });
  return Buffer.concat([head, entries, ...datas]);
}

/* ---------- 输出 ---------- */
const root = path.join(__dirname, '..');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, png: encodePNG(s, drawIcon(s)) }));

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), encodeICO(pngs));
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), pngs.find((p) => p.size === 32).png);
console.log('icon.ico + icon.png 生成完成');
