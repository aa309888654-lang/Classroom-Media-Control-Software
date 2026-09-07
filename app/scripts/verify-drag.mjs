/* 验证：分类卡片长按拖动排序（真实鼠标事件模拟长按） */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const targets = await get('http://127.0.0.1:9226/json');
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
};

await send('Page.enable');
await sleep(4000); // 曲库扫描偏慢，多等初始化

const order0 = await ev(`[...document.querySelectorAll('#catCards .cat-card:not(.cat-add) .cat-name')].map(e => e.textContent)`);
console.log('初始顺序:', JSON.stringify(order0));

// 取第 0 张与第 4 张卡片头部中心坐标
const pts = await ev(`(() => {
  const cs = [...document.querySelectorAll('#catCards .cat-card:not(.cat-add)')];
  const c = (el) => { const r = el.querySelector('.cat-head').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  return { a: c(cs[0]), b: c(cs[4]) };
})()`);
console.log('拖拽坐标:', JSON.stringify(pts));

// 模拟长按：按下不动 650ms 触发拖拽，再移动到目标卡片右半区，松开
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.a.x, y: pts.a.y, button: 'left', clickCount: 1 });
await sleep(700);
const steps = 8;
for (let i = 1; i <= steps; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(pts.a.x + (pts.b.x - pts.a.x) * i / steps) + 8,
    y: Math.round(pts.a.y + (pts.b.y - pts.a.y) * i / steps),
  });
  await sleep(40);
}
await sleep(150);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/52-drag-after.png', Buffer.from(shot.result.data, 'base64'));
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.b.x + 8, y: pts.b.y, button: 'left', clickCount: 1 });
await sleep(600);

const order1 = await ev(`[...document.querySelectorAll('#catCards .cat-card:not(.cat-add) .cat-name')].map(e => e.textContent)`);
console.log('拖拽后顺序:', JSON.stringify(order1));

const moved = order0[0] !== order1[0];
const kept = order1.length === order0.length && order1.every((n) => order0.includes(n));
const savedCfg = await ev(`(await window.api.invoke('config:save', {})).catOrder || []`);
console.log('配置里的顺序:', JSON.stringify(savedCfg));

console.log(moved && kept ? 'DRAG_PASS' : 'DRAG_FAIL');
process.exit(moved && kept ? 0 : 1);
