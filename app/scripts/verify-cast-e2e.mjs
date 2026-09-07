/* 无线同屏 E2E v2：真实 Chrome（假媒体源 + auto=1）做发送端，跑通共享→接收→出图 */
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

const ver = await getJson('http://127.0.0.1:9236/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (session, method, params = {}) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params, sessionId: session || undefined }));
});
async function attachName(urlPart) {
  const list = await getJson('http://127.0.0.1:9236/json/list');
  const t = list.find((x) => x.url.includes(urlPart));
  if (!t) return null;
  const r = await send(null, 'Target.attachToTarget', { targetId: t.id, flatten: true });
  return r.result.sessionId;
}
const ev = async (session, expr) => {
  const r = await send(session, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
  return r.result?.result?.value;
};

const mainS = await attachName('index.html');
await send(mainS, 'Page.enable');
await sleep(1200);

/* A. 干净开启同屏 */
let st = await ev(mainS, `document.getElementById('btnCast').textContent`);
if (st.includes('⏹')) { await ev(mainS, `window.api.invoke('cast:toggle')`); await sleep(800); }
const r0 = await ev(mainS, `window.api.invoke('cast:toggle')`);
const url = r0 && r0.url ? r0.url : '';
check('A 同屏服务开启', !!(r0 && r0.ok && r0.running === true && url), url);
check('B 控制台模式走外部接收窗', r0.inline === false, String(r0.inline));

/* B. 发送端路由 */
const portNum = Number(new URL(url).port);
const page = await new Promise((res) => {
  http.get(`http://127.0.0.1:${portNum}/`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, body: d })); })
    .on('error', () => res({ code: 0, body: '' }));
});
check('C 发送端页面 200 含按钮', page.code === 200 && page.body.includes('开始共享屏幕'), `code=${page.code}`);

/* C. 二维码已绘制 */
await sleep(600);
const qr = await ev(mainS, `(() => { const c = document.getElementById('castQr'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++; } return n; })()`);
check('D 二维码已绘制', qr > 400, `${qr} 非白像素`);

/* D. 真实 Chrome 做发送端（假媒体源自动授权屏幕共享） */
const chromeExe = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const chrome = spawn(chromeExe, [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--new-window',
  `http://127.0.0.1:${portNum}/?auto=1`,
], { stdio: 'ignore' });
console.log('发送端已起:', chromeExe, 'pid', chrome.pid);

/* E. 等主面板徽标进入 建链/播放 */
let badge = '';
for (let i = 0; i < 16; i++) {
  await sleep(1000);
  badge = await ev(mainS, `document.getElementById('castBadge').textContent`).catch(() => '');
  if (badge.includes('播放中') || badge.includes('接入')) break;
}
check('E 徽标进入 建链/播放 状态', badge.includes('接入') || badge.includes('播放中'), badge);

/* F. 接收端窗口出图（fake 源 320x240 刻钟图案） */
let shot = 'no-frame';
for (let i = 0; i < 16; i++) {
  await sleep(1000);
  try {
    const recvS = await attachName('caster.html');
    if (!recvS) continue;
    const vs = await ev(recvS, `(() => { const v = document.getElementById('v'); return { vw: v.videoWidth, rs: v.readyState }; })()`);
    if (vs && vs.vw > 0) { shot = JSON.stringify(vs); break; }
  } catch { }
}
check('F 接收端收到视频帧', shot !== 'no-frame', shot);

/* 收尾 */
try { chrome.kill(); } catch { }
await ev(mainS, `window.api.invoke('cast:toggle')`).catch(() => { });

const pass = results.every(Boolean);
console.log(pass ? 'CAST_E2E_PASS' : 'CAST_E2E_FAIL');
process.exit(pass ? 0 : 1);
