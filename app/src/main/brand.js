/* 品牌资产解密器（主进程侧）
 * 密钥内嵌于 brand.key.js，随包发行——安装即可用，不依赖外部密钥文件。
 * 密文被篡改 / brand.key.js 被改 / brand.data.js 缺失 → unlock() 抛错，应用拒绝启动。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const brandKey = require('./brand.key.js');

let cached = null;

function key() {
  return brandKey.key();
}

function unlock() {
  if (cached) return cached;
  const blob = require('./brand.data.js');
  const k = crypto.pbkdf2Sync(key(), Buffer.from(blob.salt, 'base64'), 210000, 32, 'sha512');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  let plain;
  try {
    plain = Buffer.concat([d.update(Buffer.from(blob.data, 'base64')), d.final()]);
  } catch {
    const err = new Error('brand-tampered');
    err.code = 'BRAND_TAMPERED';
    throw err;
  }
  cached = JSON.parse(plain.toString('utf8'));
  return cached;
}

// LOGO 解密后落临时目录，渲染层以 file:// 引用（不进配置、不可持久偷窥）
let logoPath = null;
function logoFile() {
  if (logoPath && fs.existsSync(logoPath)) return logoPath;
  const { app } = require('electron');
  const dir = path.join(app.getPath('temp'), 'xiaotian-brand');
  fs.mkdirSync(dir, { recursive: true });
  logoPath = path.join(dir, 'logo.png');
  fs.writeFileSync(logoPath, Buffer.from(unlock().logoB64, 'base64'));
  return logoPath;
}

module.exports = { unlock, logoFile };
