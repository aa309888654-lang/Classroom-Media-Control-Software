/* 同屏故障复现：用真实局域网 IP（非 127.0.0.1）模拟「同一 WiFi 的另一台设备」
 * 排查：①发送端页面可达 ②发起共享后接收端是否出图
 * 前置：electron . --remote-debugging-port=9247
 */
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const ver = await getJson('http://127.0.0.1:9247/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}, session) => new Promise((res) => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: session || undefined }));
});
async function attach(urlPart) {
  const list = await getJson(`http://127.0.0.1:9247/json/list`);
  const t = list.find((x) => x.url.includes(urlPart));
  if (!t) return null;
  return (await send('Target.attachToTarget', { targetId: t.id, flatten: true })).result.sessionId;
}
const evalIn = (sid, expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
  .then((r) => r.result?.result?.value);

const mainSid = await attach('index.html');
check('主面板就绪', !!mainSid);

// 开同屏
const r0 = await evalIn(mainSid, `window.api.invoke('cast:toggle')`);
check('同屏服务开启', !!(r0 && r0.ok && r0.running), JSON.stringify(r0));
const url = r0.url; // 例如 http://192.168.100.3:18333
console.log('同屏 URL =', url);

// ① 用局域网 IP 拉发送端页面（等价于手机/另一台电脑访问）
const page = await new Promise((res) => {
  http.get(url + '/', (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, len: d.length })); })
    .on('error', (e) => res({ code: 0, err: String(e) }));
});
check('LAN IP 发送端页面可达', page.code === 200, JSON.stringify(page));

// ② 用真实 Chrome 以 LAN IP 发起共享（假媒体源），看接收端是否出图
const chromeExe = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const chrome = spawn(chromeExe, [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--new-window',
  url + '/?auto=1',
], { stdio: 'ignore' });
console.log('发送端 Chrome 已起（LAN IP 模式）pid', chrome.pid);

let badge = '';
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  badge = await evalIn(mainSid, `(document.getElementById('castBadge')||{textContent:''}).textContent`).catch(() => '');
  if (badge.includes('接入') || badge.includes('播放')) break;
}
check('徽标进入 接入/播放', badge.includes('接入') || badge.includes('播放'), badge);

let shot = 'no-frame';
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  const recvS = await attach('caster.html').catch(() => null);
  if (!recvS) continue;
  const vs = await evalIn(recvS, `(() => { const v = document.getElementById('v'); return { vw: v.videoWidth, rs: v.readyState }; })()`).catch(() => null);
  if (vs && vs.vw > 0) { shot = JSON.stringify(vs); break; }
}
check('接收端收到视频帧', shot !== 'no-frame', shot);

try { chrome.kill(); } catch { }
await evalIn(mainSid, `window.api.invoke('cast:toggle')`).catch(() => {});
console.log(results.every(Boolean) ? 'CAST_LAN_OK' : 'CAST_LAN_FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
