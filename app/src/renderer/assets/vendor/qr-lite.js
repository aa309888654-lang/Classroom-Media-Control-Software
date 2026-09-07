/* QRLite —— 最小二维码编码器（自研，零依赖）
 * 覆盖范围：字节模式、纠错级别 L、掩码 0、版本 1~3（单块，无交织）。
 * 适用：把局域网网址（≤53 字节）渲染为二维码。
 * 用法：QRLite.encode("http://192.168.1.1:18333/") → { size, dark(r,c) } 或 null。 */
(function () {
  'use strict';

  /* ---------- 版本表（EC=L，单块） ---------- */
  const VERSIONS = {
    1: { dataCw: 19, eccCw: 7, align: null },
    2: { dataCw: 34, eccCw: 10, align: 18 },
    3: { dataCw: 55, eccCw: 15, align: 22 },
  };

  /* ---------- GF(256) 域（本原多项式 0x11D） ---------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* ---------- Reed-Solomon ---------- */
  function rsGenerator(deg) {
    let gen = [1];
    for (let i = 0; i < deg; i++) {
      const poly = [1, EXP[i]];
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gfMul(gen[j], poly[0]);
        next[j + 1] ^= gfMul(gen[j], poly[1]);
      }
      gen = next;
    }
    return gen;
  }

  function rsRemainder(data, eccLen) {
    const gen = rsGenerator(eccLen);
    const msg = data.concat(new Array(eccLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef === 0) continue;
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
    return msg.slice(data.length);
  }

  /* ---------- 位流工具 ---------- */
  function BitWriter() {
    this.bytes = [];
    this.bitLen = 0;
    this.acc = 0;
  }
  BitWriter.prototype.write = function (val, numBits) {
    for (let i = numBits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((val >>> i) & 1);
      this.bitLen++;
      if (this.bitLen % 8 === 0) {
        this.bytes.push(this.acc & 0xFF);
        this.acc = 0;
      }
    }
  };
  BitWriter.prototype.padToByte = function () {
    if (this.bitLen % 8 !== 0) {
      this.acc <<= (8 - (this.bitLen % 8));
      this.bytes.push(this.acc & 0xFF);
      this.acc = 0;
      this.bitLen = Math.ceil(this.bitLen / 8) * 8;
    }
  };

  /* ---------- 编码主流程 ---------- */
  function encode(text) {
    const utf8 = new TextEncoder().encode(text);
    let version = 0;
    for (const v of [1, 2, 3]) {
      const bits = 4 + 8 + utf8.length * 8;
      const bitsCap = VERSIONS[v].dataCw * 8;
      if (bits + Math.min(4, bitsCap - bits) <= bitsCap && bits <= bitsCap) { version = v; break; }
    }
    if (!version) return null;

    const ver = VERSIONS[version];
    const bw = new BitWriter();
    bw.write(0b0100, 4);              // 字节模式
    bw.write(utf8.length, 8);         // v1-9 为 8 位计数
    utf8.forEach((b) => bw.write(b, 8));
    bw.write(0, Math.min(4, ver.dataCw * 8 - bw.bitLen)); // 终止符（不足 4 位则取余量）
    bw.padToByte();
    let padEven = true;
    while (bw.bytes.length < ver.dataCw) { // 交替填充 0xEC 0x11，恒定以 0xEC 起
      bw.bytes.push(padEven ? 0xEC : 0x11);
      padEven = !padEven;
    }
    const ecc = rsRemainder(bw.bytes, ver.eccCw);
    const codewords = bw.bytes.concat(ecc);

    const size = 17 + version * 4;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));

    const setF = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFunc[y][x] = true;
    };

    /* 定时线（先画，寻像图形后画会自然覆盖交叠区，符合规范） */
    for (let i = 0; i < size; i++) {
      setF(6, i, i % 2 === 0);
      setF(i, 6, i % 2 === 0);
    }

    /* 寻像图形（三角） */
    const drawFinder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const xx = cx + dx, yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setF(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    };
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    /* 校正版（v2/v3 各一个） */
    if (ver.align != null) {
      const c = ver.align;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setF(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    /* 格式信息区占位（写码前先标记为功能区，防止数据覆写） */
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) { isFunc[8][i] = true; isFunc[i][8] = true; }
    }
    for (let i = 0; i < 8; i++) {
      isFunc[8][size - 1 - i] = true;
      isFunc[size - 1 - i][8] = true;
    }

    /* 固定暗模块 */
    setF(8, size - 8, true);

    /* 数据位 Z 字形写入 */
    let bitIdx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) {
        const y = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (isFunc[y][x] || bitIdx >= codewords.length * 8) continue;
          modules[y][x] = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
      }
    }

    /* 掩码 0（(x+y) 为偶 → 反转），只作用于数据区 */
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunc[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x];
      }
    }

    /* 格式信息（EC=L / 掩码 0），BCH(15,5) */
    const fmtData = (0b01 << 3) | 0;
    let rem = fmtData;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ (((rem >>> 9) & 1) ? 0x537 : 0);
    }
    const fmtBits = ((fmtData << 10) | (rem & 0x3FF)) ^ 0x5412;
    const getBit = (i) => ((fmtBits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) setF(8, i, getBit(i));
    setF(8, 7, getBit(6));
    setF(8, 8, getBit(7));
    setF(7, 8, getBit(8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, getBit(i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, getBit(i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, getBit(i));
    setF(8, size - 8, true);

    return {
      size,
      dark: (r, c) => !!modules[r] && !!modules[r][c],
    };
  }

  const api = { encode };
  if (typeof window !== 'undefined') window.QRLite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
