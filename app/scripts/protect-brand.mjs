/* 品牌资产加密生成器：把 软件名/LOGO/版本/官网/赞助 打包 AES-256-GCM 加密。
 * 密钥策略：随包发行（内嵌 src/main/brand.key.js）——安装即用，不依赖外部文件。
 * 历史备份：首台开发机的 I:\教务系统\密钥\brand.key 仅作运营留存，不再被运行时读取。
 * 用法：node scripts/protect-brand.mjs */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const BRAND = {
  name: '小天AIGC',
  version: '0.1.0',
  site: 'https://aicgxt.com',
  sponsor: 'https://aicgxt.cn/sponsor',
  officialHosts: ['aicgxt.com', 'aicgxt.cn'],
};

// 密钥来源：优先复用开发机留存的 I:\教务系统\密钥\brand.key（保持旧密文可解）；
// 否则读已发行的 src/main/brand.key.js；两者都没有才生成新密钥。
const KEY_MODULE = path.resolve(import.meta.dirname, '..', 'src', 'main', 'brand.key.js');
function backupKeyFile() {
  return path.join('I:\\', '教务系统', '密钥', 'brand.key');
}
function ensureKey() {
  const bak = backupKeyFile();
  if (fs.existsSync(bak)) return fs.readFileSync(bak);
  if (fs.existsSync(KEY_MODULE)) {
    const m = fs.readFileSync(KEY_MODULE, 'utf8').match(/KEY_B64 = '([A-Za-z0-9+/=]+)'/);
    if (m) return Buffer.from(m[1], 'base64');
  }
  const k = crypto.randomBytes(48);
  try { fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.writeFileSync(bak, k, { mode: 0o600 }); } catch { }
  console.log('已生成新密钥并留存备份:', bak);
  return k;
}

const logoPath = path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'assets', 'logo.png');
const payload = {
  ...BRAND,
  logoB64: fs.readFileSync(logoPath).toString('base64'),
};

const key = ensureKey();
const salt = crypto.randomBytes(24);
const iv = crypto.randomBytes(12);
const aesKey = crypto.pbkdf2Sync(key, salt, 210000, 32, 'sha512');
const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

const out = `/* 品牌资产密文（由 scripts/protect-brand.mjs 生成）
 * 密钥内嵌在 brand.key.js，随包发行；任何字段篡改都会触发 AES-GCM 校验失败 → 应用拒绝启动。 */
module.exports = {
  v: 1,
  salt: '${salt.toString('base64')}',
  iv: '${iv.toString('base64')}',
  tag: '${tag.toString('base64')}',
  data: '${enc.toString('base64')}',
};
`;

const keyModuleOut = `/* 品牌密钥模块（随包发行）。由 scripts/protect-brand.mjs 生成/同步，请勿手改。 */
const KEY_B64 = '${key.toString('base64')}';

module.exports = {
  key() { return Buffer.from(KEY_B64, 'base64'); },
};
`;

const target = path.resolve(import.meta.dirname, '..', 'src', 'main', 'brand.data.js');
fs.writeFileSync(target, out, 'utf8');
fs.writeFileSync(KEY_MODULE, keyModuleOut, 'utf8');
console.log('已生成 brand.data.js (', Math.round(out.length / 1024), 'KB) + brand.key.js（随包发行）。');
