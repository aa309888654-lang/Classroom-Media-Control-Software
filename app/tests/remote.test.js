/* 遥控功能端到端验证（node --test 可跑，electron 桩）：
   起 castServer → 模拟手机同 WiFi 访问 → 验证 /remote 页、token 鉴权、音乐/视频/PPT 命令转发。 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { installElectron } = require('./helpers');
installElectron();
// 先关掉证书自动导入，避免测试里真的写 Windows 根证书存储
const config = require('../src/main/config.js');
config.load();
config.save({ castAutoTrustCert: false });

const castServer = require('../src/main/castServer');
let port = 0, token = '';
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
  port = r.port; token = r.token;
});

after(() => castServer.stop());

test('遥控页可访问且下发 SameSite Cookie；页面含音乐/视频/PPT 控制按钮', async () => {
  const r = await req('GET', '/remote');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /无线遥控/);
  assert.match(r.body, /cmd\('music','toggle'\)/, '应有音乐播放/暂停按钮');
  assert.match(r.body, /cmd\('music','next'\)/, '应有音乐下一首按钮');
  assert.match(r.body, /cmd\('video','toggle'\)/, '应有视频播放/暂停按钮');
  assert.match(r.body, /cmd\('ppt','next'\)/, '应有 PPT 翻页按钮');
  assert.match(String(r.headers['set-cookie'] || ''), /dshcast=.*SameSite=Strict/);
});

test('带 Cookie 令牌的音乐全量命令被接受并触发回调', async () => {
  const CK = { Cookie: `dshcast=${token}`, 'Content-Type': 'application/json' };
  const before = cmds.length;
  for (const cmd of ['toggle', 'prev', 'next', 'volUp', 'volDown', 'mute']) {
    const r = await req('POST', '/api/remote/cmd', CK, JSON.stringify({ target: 'music', cmd }));
    assert.strictEqual(r.status, 200, `music/${cmd}`);
  }
  assert.strictEqual(cmds.length, before + 6, '6 条音乐命令应全部到达回调');
  assert.ok(cmds.slice(before).every((c) => c.target === 'music'), '回调 target 应为 music');
});

test('带 Cookie 令牌的视频全量命令被接受并触发回调', async () => {
  const CK = { Cookie: `dshcast=${token}`, 'Content-Type': 'application/json' };
  const before = cmds.length;
  for (const cmd of ['toggle', 'stop', 'volUp', 'volDown']) {
    const r = await req('POST', '/api/remote/cmd', CK, JSON.stringify({ target: 'video', cmd }));
    assert.strictEqual(r.status, 200, `video/${cmd}`);
  }
  assert.strictEqual(cmds.length, before + 4, '4 条视频命令应全部到达回调');
});

test('带 Cookie 令牌的 PPT 命令被接受并触发回调', async () => {
  const CK = { Cookie: `dshcast=${token}`, 'Content-Type': 'application/json' };
  const before = cmds.length;
  for (const cmd of ['prev', 'next', 'exit']) {
    const r = await req('POST', '/api/remote/cmd', CK, JSON.stringify({ target: 'ppt', cmd }));
    assert.strictEqual(r.status, 200, `ppt/${cmd}`);
  }
  assert.strictEqual(cmds.length, before + 3, '3 条 PPT 命令应全部到达回调');
});

test('非法命令被拒 400；遥控状态查询可用', async () => {
  const CK = { Cookie: `dshcast=${token}`, 'Content-Type': 'application/json' };
  const bad = await req('POST', '/api/remote/cmd', CK, JSON.stringify({ target: 'music', cmd: 'shutdown' }));
  assert.strictEqual(bad.status, 400);
  const st = await req('GET', '/api/remote/state', CK);
  assert.strictEqual(st.status, 200);
});
