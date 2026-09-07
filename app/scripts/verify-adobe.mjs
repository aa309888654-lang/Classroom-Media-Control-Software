/* 视觉验证：对运行中的主界面截图（需先以 --remote-debugging-port=9242 启动） */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const targets = await get('http://127.0.0.1:9242/json');
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('NO_PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

await send('Page.enable');
await sleep(1200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/30-adobe-theme.png', Buffer.from(shot.result.data, 'base64'));
console.log('SHOT_OK');
process.exit(0);
