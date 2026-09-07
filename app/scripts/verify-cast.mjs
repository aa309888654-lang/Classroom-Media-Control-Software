/* 无线同屏 E2E：真开启服务 → 拉发送端页 → 假摄像头源发起共享 → 接收端出图 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ status: r.statusCode, body: d })); }).on('error', rej);
});

const PORT = '9236';
const ver = await get(`http://127.0.0.1:${PORT}/json/version`);
const rootWs = new WebSocket(JSON.parse(ver.body).webSocketDebuggerUrl);
await new Promise((r) => (rootWs.onopen = r));
let id = 0;
const pending = new Map();
const sessions = new Map(); // name → sessionId
rootWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(session, method, params = {}) {
  return new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    rootWs.send(JSON.stringify({ id: i, method, params, sessionId: session || undefined }));
  });
}
async function attach(name, urlPart) {
  const list = JSON.parse((await get(`http://127.0.0.1:${PORT}/json/list`)).body);
  const t = list.find((x) => x.url.includes(urlPart));
  if (!t) throw new Error('no target ' + urlPart);
  const r = await send(null, 'Target.attachToTarget', { targetId: t.id, flatten: true });
  sessions.set(name, r.result.sessionId);
  return r.result.sessionId;
}
const evIn = async (name, expr) => {
  const r = await send(sessions.get(name), 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
};

await attach('main', 'index.html');
await send(sessions.get('main'), 'Page.enable');
await sleep(4500);

// 1) 开启同屏
const r0 = await evIn('main', `window.api.invoke('cast:toggle')`);
console.log('开启:', JSON.stringify(r0 && { ok: r0.ok, running: r0.running, url: r0.url, inline: r0.inline }));
const portNum = r0.url ? Number(new URL(r0.url).port) : 0;

// 2) 发送端页面可访问
const page = await get(`http://127.0.0.1:${portNum}/`);
console.log('发送端页面:', page.status, page.body.includes('开始共享屏幕') ? '含开始按钮' : '缺按钮');

// 3) 二维码已绘制（画布非纯白）
await sleep(600);
const qrPainted = await evIn('main', `(() => { const c = document.getElementById('castQr'); const ctx = c.getContext('2d'); const d = ctx.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++; } return n; })()`);
console.log('二维码非白像素:', qrPainted);

// 4) E2E：发送端（本机，安全上下文）发起共享
const created = await send(null, 'Target.createTarget', { url: `http://127.0.0.1:${portNum}/` });
console.log('创建发送端标签页:', JSON.stringify(created.result || created.error || created));
await sleep(3000);
await attach('sender', `http://127.0.0.1:${portNum}/`);
await send(sessions.get('sender'), 'Page.enable');
await evIn('sender', `document.getElementById('startBtn').click()`);
console.log('发送端已点【开始共享屏幕】(fake-ui 自动放行)');

// 5) 等接收端窗口就绪并出图
let recv = null;
for (let i = 0; i < 16; i++) {
  await sleep(1000);
  const list = JSON.parse((await get(`http://127.0.0.1:${PORT}/json/list`)).body);
  const t = list.find((x) => x.url.includes('caster.html'));
  if (t && !recv) {
    const att = await send(null, 'Target.attachToTarget', { targetId: t.id, flatten: true });
    sessions.set('recv', att.result.sessionId);
    recv = 'attached';
  }
  if (recv) {
    try {
      const st = await evIn('recv', `(() => { const v = document.getElementById('v'); return { rs: v.readyState, vw: v.videoWidth, paused: v.paused, obj: !!v.srcObject }; })()`);
      if (st && st.vw > 0) { console.log('接收端出图:', JSON.stringify(st)); break; }
      if (i % 4 === 0) console.log('等待流…', JSON.stringify(st));
    } catch (e) { /* 页面加载中 */ }
  }
}

// 6) 状态徽标
const badge = await evIn('main', `document.getElementById('castBadge').textContent`);
console.log('状态徽标:', badge);

// 收尾：关掉假共享页与服务
await evIn('main', `window.api.invoke('cast:toggle')`);
const ok = r0.ok && r0.running === true && page.status === 200 && qrPainted > 400 && badge.includes('已');
console.log(ok ? 'CAST_E2E_PASS' : 'CAST_E2E_FAIL');
process.exit(ok ? 0 : 1);
