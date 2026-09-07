/* 品牌密钥模块（随包发行）。由 scripts/protect-brand.mjs 生成/同步，请勿手改。 */
const KEY_B64 = 'DvOR6cKj1cN1iSU8R0LZLWfggXJq8yc8u2gWSNuZflDKZ74aBKTZJ0Vf2dYHAR+2';

module.exports = {
  key() { return Buffer.from(KEY_B64, 'base64'); },
};
