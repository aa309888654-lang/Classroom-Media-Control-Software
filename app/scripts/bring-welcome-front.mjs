/* 把主面板与欢迎窗都拉到前台等截屏 */
import http from 'node:http';
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
const send = (m, p = {}, s) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s || undefined })); });

let list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const main = list.find((t) => t.url.includes('index.html'));
const mainAtt = await send('Target.attachToTarget', { targetId: main.id, flatten: true });
// 开启欢迎屏（带文字/背景 6 城市夜色 / 样式 7 霓虹）
await send('Runtime.evaluate', { expression: `window.api.invoke('welcome:toggle', { text: '欢迎张局莅临指导', bg: 6, style: 7 })`, awaitPromise: true }, mainAtt.result.sessionId);
await sleep(1800);
list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
console.log('targets:', list.map((t) => t.url.slice(0, 46)));
process.exit(0);
