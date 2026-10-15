/* castServer 集成测试（BUG-01/06/07 的直接防线）：真实 forge 证书 + 真实 HTTP 服务。
 * 覆盖：鉴权 401/Cookie/X-Token、CORS 反射、超体 413、Range 开区间/后缀/越界/HEAD。 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { installElectron } = require('./helpers');
installElectron();

// 先关掉证书自动导入，避免测试里真的写 Windows 根证书存储
const config = require('../src/main/config.js');
config.load();
config.save({ castAutoTrustCert: false });

const castServer = require('../src/main/castServer.js');
let port = 0;
let token = '';
const cmds = [];

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

before(async () => {
  castServer.setCommandHandler((c) => cmds.push(c));
  const r = await castServer.start(() => { });
  assert.ok(r.ok, `start 失败: ${JSON.stringify(r)}`);
  port = r.port;
  token = r.token;
});

after(() => castServer.stop());

test('首页下发 Set-Cookie 令牌', async () => {
  const r = await req('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.match(String(r.headers['set-cookie'] || ''), /dshcast=/);
});

test('无令牌访问 API → 401；Cookie 与 X-Token → 200', async () => {
  assert.strictEqual((await req('GET', '/api/remote/state')).status, 401);
  assert.strictEqual((await req('GET', '/api/remote/state', { Cookie: `dshcast=${token}` })).status, 200);
  assert.strictEqual((await req('GET', '/api/remote/state', { 'X-Token': token })).status, 200);
});

test('CORS 反射请求源而非通配 *', async () => {
  const r = await req('OPTIONS', '/api/remote/cmd', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
  assert.strictEqual(r.headers['access-control-allow-origin'], 'https://evil.example');
});

test('跨源无令牌遥控 → 401 且回调不触发；带令牌 → 200 且触发', async () => {
  const before = cmds.length;
  const evil = await req('POST', '/api/remote/cmd', { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, JSON.stringify({ target: 'ppt', cmd: 'next' }));
  assert.strictEqual(evil.status, 401);
  assert.strictEqual(cmds.length, before);
  const ok = await req('POST', '/api/remote/cmd', { Cookie: `dshcast=${token}`, 'Content-Type': 'application/json' }, JSON.stringify({ target: 'ppt', cmd: 'next', page: 0 }));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(cmds.length, before + 1);
});

test('超体请求 → 413（不再直接 RST）', async () => {
  const r = await req('POST', '/api/remote/cmd', { Cookie: `dshcast=${token}`, 'Content-Type': 'application/json' }, 'x'.repeat(20000));
  assert.strictEqual(r.status, 413);
});

test('上传 → 媒体 Range 全形态', async () => {
  const CK = { Cookie: `dshcast=${token}` };
  const up = await req('POST', '/api/upload?name=c.mp4&type=video%2Fmp4', CK, 'HELLO-WORLD-VIDEO-DATA');
  assert.strictEqual(up.status, 200);
  const id = JSON.parse(up.body).id;
  const full = await req('GET', `/media/${id}`, CK);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.headers['accept-ranges'], 'bytes');
  assert.strictEqual(full.body, 'HELLO-WORLD-VIDEO-DATA');
  const part = await req('GET', `/media/${id}`, { ...CK, Range: 'bytes=5-' });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers['content-range'], 'bytes 5-21/22');
  assert.strictEqual(part.body, '-WORLD-VIDEO-DATA');
  const suffix = await req('GET', `/media/${id}`, { ...CK, Range: 'bytes=-5' });
  assert.strictEqual(suffix.status, 206);
  assert.strictEqual(suffix.body, '-DATA');
  const oob = await req('GET', `/media/${id}`, { ...CK, Range: 'bytes=100-200' });
  assert.strictEqual(oob.status, 416);
  const head = await req('HEAD', `/media/${id}`, CK);
  assert.strictEqual(head.status, 200);
  assert.strictEqual(Number(head.headers['content-length']), 22);
  assert.strictEqual(head.body, '');
  // URL 签名（<img>/<video> 发不出请求头）
  const signed = await req('GET', `/media/${id}?k=${token}`);
  assert.strictEqual(signed.status, 200);
  // 无令牌 → 401
  assert.strictEqual((await req('GET', `/media/${id}`)).status, 401);
});

test('stop 后令牌作废', async () => {
  castServer.stop();
  const r = await castServer.start(() => { });
  port = r.port; token = r.token;
  assert.ok(r.ok);
  assert.ok(token.length >= 32);
});
