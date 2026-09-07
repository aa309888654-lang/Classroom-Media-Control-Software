/* 验证 LED 模式出口：切换到 LED（截图）→ 点悬浮条「返回控制台」（再截图） */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const targets = await get('http://127.0.0.1:9223/json');
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('NO_PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
await send('Page.enable');
await sleep(1200);

// 1) 切到 LED 模式
await ev(`document.querySelector('#btnMode').click()`);
await sleep(800);
const ledState = await ev(`({ led: document.body.classList.contains('led-mode'), dockHidden: document.querySelector('#ledDock').hidden, backVisible: !!document.querySelector('#ledModeBack') })`);
console.log('LED状态:', JSON.stringify(ledState));
let shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/31-led-mode.png', Buffer.from(shot.result.data, 'base64'));

// 2) 点「返回控制台」
await ev(`document.querySelector('#ledModeBack').click()`);
await sleep(800);
const backState = await ev(`({ led: document.body.classList.contains('led-mode'), dockHidden: document.querySelector('#ledDock').hidden })`);
console.log('返回后:', JSON.stringify(backState));
shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/32-back-control.png', Buffer.from(shot.result.data, 'base64'));

console.log('VERIFY_DONE');
process.exit(ledState.led && !ledState.dockHidden && ledState.backVisible && !backState.led ? 0 : 1);
