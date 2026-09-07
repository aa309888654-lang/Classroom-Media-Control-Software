/* 长按拖动 v2：从卡片非标题区（底部留白处）长按也必须能拖动 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const PORT = process.argv[2] || '9232';
const targets = await get(`http://127.0.0.1:${PORT}/json`);
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('NO_PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
};
await send('Page.enable');
await sleep(4200);

const order0 = await ev(`[...document.querySelectorAll('#catCards .cat-card:not(.cat-add) .cat-name')].map(e => e.textContent)`);
console.log('初始:', JSON.stringify(order0));

// 第0张卡片「底部留白区」坐标（避开标题行/曲目行/更多链接），第4张卡片中心
const pts = await ev(`(() => {
  const cs = [...document.querySelectorAll('#catCards .cat-card:not(.cat-add)')];
  const r0 = cs[0].getBoundingClientRect();
  const r1 = cs[4].getBoundingClientRect();
  return {
    ax: Math.round(r0.right - 24), ay: Math.round(r0.bottom - 8),
    bx: Math.round(r1.x + r1.width * 0.7), by: Math.round(r1.y + r1.height / 2),
    aHit: (document.elementFromPoint(Math.round(r0.right - 24), Math.round(r0.bottom - 8)) || {}).className || 'none',
  };
})()`);
console.log('按下点命中元素:', pts.aHit, '坐标:', JSON.stringify(pts));

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.ax, y: pts.ay, button: 'left', clickCount: 1 });
await sleep(700);
for (let i = 1; i <= 8; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(pts.ax + (pts.bx - pts.ax) * i / 8),
    y: Math.round(pts.ay + (pts.by - pts.ay) * i / 8),
  });
  await sleep(40);
}
await sleep(120);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.bx, y: pts.by, button: 'left', clickCount: 1 });
await sleep(600);

const order1 = await ev(`[...document.querySelectorAll('#catCards .cat-card:not(.cat-add) .cat-name')].map(e => e.textContent)`);
console.log('拖后:', JSON.stringify(order1));
const moved = order0[0] !== order1[0];
console.log(moved ? 'DRAG2_PASS' : 'DRAG2_FAIL');
process.exit(moved ? 0 : 1);
