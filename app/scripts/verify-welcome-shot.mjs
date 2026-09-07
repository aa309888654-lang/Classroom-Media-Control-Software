/* 欢迎屏大屏截图（欢迎接收窗已开着） */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

const PORT = '9247';
const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}, session) => new Promise((res) => {
  const i = ++id;
  pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: session || undefined }));
});
// 先确保欢迎窗开着（主面板会话里直接 invoke welcome:toggle）
let list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const main = list.find((t) => t.url.includes('index.html'));
const mainAtt = await send('Target.attachToTarget', { targetId: main.id, flatten: true });
await send('Runtime.evaluate', {
  expression: `window.api.invoke('welcome:toggle', { text: '欢迎张局莅临指导', bg: 6, style: 7 })`,
  awaitPromise: true,
}, mainAtt.result.sessionId);
await sleep(1800);

list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const recv = list.find((t) => t.url.includes('welcome.html'));
if (!recv) { console.error('no welcome window target'); process.exit(1); }
const att = await send('Target.attachToTarget', { targetId: recv.id, flatten: true });
const sess = att.result.sessionId;
await sleep(800);
const shot = await send('Page.captureScreenshot', { format: 'png' }, sess);
fs.writeFileSync('test-artifacts/60-welcome-screen.png', Buffer.from(shot.result.data, 'base64'));
const txt = await send('Runtime.evaluate', { expression: 'document.getElementById("title").innerText', returnByValue: true }, sess);
console.log('接收窗文字:', JSON.stringify(txt.result?.result?.value));
console.log('WELCOME_SHOT_OK');
process.exit(0);
