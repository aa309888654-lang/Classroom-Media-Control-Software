/* 上传上屏：超限必须 413 且**不留半成品**（2026-10-20 全面检查发现的 fd/文件泄漏防线）
 *
 * 背景：超限分支原来只 req.destroy()。不带 error 参数销毁请求流时，
 * pipe 的 dest 既收不到 'end' 也收不到 'error' → 写流的 'finish'/'close' 都不触发，
 * 那段「把半成品清掉」的清理代码成了死代码：每次超限在系统盘留下最多 500MB 残片 + fd 不关。
 * token 在落地页就下发给每个访客，等于无门槛可触发。
 *
 * 本测试用真实 HTTP 服务 + 真实文件写入走完整条路径（不是复刻模式）。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { installElectron } = require('./helpers');
const { userData } = installElectron();

// 先关掉证书自动导入，避免测试里真的写 Windows 根证书存储
const config = require('../src/main/config.js');
config.load();
config.save({ castAutoTrustCert: false });

const castServer = require('../src/main/castServer.js');

const LIMIT = 64 * 1024;            // 测试用上限 64KB
const uploadsDir = path.resolve(userData, 'tmp-temp', 'xiaotian-aigc-uploads');
let port = 0;
let token = '';

function req(method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: headers || {}, agent: false }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: '', err: e.code }));
    if (body) r.write(body);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uploadDirFiles() {
  try { return fs.readdirSync(uploadsDir); } catch { return []; }
}

before(async () => {
  const r = await castServer.start(() => { }, { uploadMax: LIMIT });
  assert.ok(r.ok, `start 失败: ${JSON.stringify(r)}`);
  port = r.port;
  token = r.token;
});

after(() => castServer.stop());

test('超限上传 → 413，且磁盘上不留半成品', async () => {
  const CK = { Cookie: `dshcast=${token}` };
  const big = 'x'.repeat(LIMIT * 4);   // 远超上限
  const r = await req('POST', '/api/upload?name=big.mp4&type=video%2Fmp4', CK, big);
  assert.strictEqual(r.status, 413, '超限必须回 413');
  // 断流后写流的收尾是异步的，等它跑完再查盘
  await sleep(500);
  const left = uploadDirFiles();
  assert.deepStrictEqual(left, [], `超限上传后不应留下任何文件，实际残留: ${JSON.stringify(left)}`);
});

test('正常上传仍然成功并落盘（修复没把正常路径打死）', async () => {
  const CK = { Cookie: `dshcast=${token}` };
  const small = 'A'.repeat(1024);
  const r = await req('POST', '/api/upload?name=ok.mp4&type=video%2Fmp4', CK, small);
  assert.strictEqual(r.status, 200);
  const id = JSON.parse(r.body).id;
  assert.ok(id);
  const got = await req('GET', `/media/${id}`, CK);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body, small);
  await sleep(200);
  // 正常上传的文件应当在（这是对照组：证明「目录为空」不是因为目录没建）
  assert.ok(uploadDirFiles().length >= 1, '正常上传应留下文件');
});
