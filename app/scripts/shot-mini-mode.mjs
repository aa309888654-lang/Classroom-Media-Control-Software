/* 迷你模式截图留档 */
import http from 'node:http';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

const list = await getJson('http://127.0.0.1:9247/json/list');
const main = list.find((x) => x.url.includes('index.html'));
if (!main) { console.error('主面板不在'); process.exit(1); }
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((m) => m.result?.result?.value);

await ev(`window.api.invoke('config:save', { miniBounds: { x: 2008, y: 1296, width: 540, height: 132 } })`);
// 等按钮事件绑定完成再点（元素先渲染、bindUI 后绑定）
for (let i = 0; i < 40; i++) { await sleep(400); if (await ev(`typeof document.getElementById('btnMini').onclick === 'function'`)) break; }
await ev(`document.getElementById('btnMini').click()`);
for (let i = 0; i < 20; i++) { await sleep(400); if (await ev(`document.body.classList.contains('mini-mode')`)) break; }
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/65-mini-mode.png', Buffer.from(shot.result.data, 'base64'));
console.log('OK test-artifacts/65-mini-mode.png');
await ev(`document.getElementById('miniExpand').click()`).catch(() => {});
ws.close();
process.exit(0);
