/* 拖动 v3 验证：快拖立即跟手 / 长按可拖 / 竖划不误拖 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + n + (d ? ' | ' + d : '')); };

const PORT = '9241';
const list0 = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const page0 = list0.find((t) => t.url.includes('index.html'));
const ws = new WebSocket(page0.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
  return r.result?.result?.value;
};
const mouse = async (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? undefined : 'left', clickCount: type === 'mouseMoved' ? undefined : 1 });
const orderOf = () => ev(`[...document.querySelectorAll('#catCards .cat-card:not(.cat-add) .cat-name')].map(e => e.textContent)`);
const cardPoint = (idx, part) => ev(`(() => { const cs = [...document.querySelectorAll('#catCards .cat-card:not(.cat-add)')]; const r = cs[${idx}].getBoundingClientRect(); return { x: Math.round(r.x + r.width * ${part}), y: Math.round(r.bottom - 8) }; })()`);

/* 就绪等待：I: 盘扫描慢，等到卡片真的渲染出来 */
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const n = await ev(`document.querySelectorAll('#catCards .cat-card:not(.cat-add)').length`).catch(() => 0);
    if (n >= 6) return n;
    await sleep(500);
  }
  throw new Error('cards not ready');
}

await waitReady();
const o0 = await orderOf();
const a = await cardPoint(0, 0.5), b = await cardPoint(4, 0.7);
await mouse('mousePressed', a.x, a.y);
await sleep(150);
await mouse('mouseMoved', Math.round(a.x + (b.x - a.x) / 3), a.y);
await sleep(80);
await mouse('mouseMoved', Math.round(a.x + ((b.x - a.x) * 2) / 3), a.y);
await sleep(80);
await mouse('mouseMoved', b.x, b.y);
await sleep(120);
await mouse('mouseReleased', b.x, b.y);
await sleep(500);
const o1 = await orderOf();
check('按下快拖即换位', o0[0] !== o1[0], `${o0[0]} -> >不等待 <150ms`);

/* 2. 长按不挪手后还能拖（0.6s 静止再移） */
await ev(`window.api.invoke('config:save', { catOrder: [] })`);
await send('Page.reload');
await waitReady();
const o2 = await orderOf();
const a2 = await cardPoint(0, 0.5), b2 = await cardPoint(4, 0.7);
await mouse('mousePressed', a2.x, a2.y);
await sleep(650);
await mouse('mouseMoved', Math.round((a2.x + b2.x) / 2), a2.y);
await sleep(60);
await mouse('mouseMoved', b2.x, b2.y);
await sleep(100);
await mouse('mouseReleased', b2.x, b2.y);
await sleep(500);
const o3 = await orderOf();
check('长按静止后拖动换位', o2[0] !== o3[0], `${o2[0]} -> 长按470ms+`);

/* 3. 竖划不误拖 */
await ev(`window.api.invoke('config:save', { catOrder: [] })`);
await send('Page.reload');
await waitReady();
const o4 = await orderOf();
const a3 = await cardPoint(1, 0.5);
await mouse('mousePressed', a3.x, a3.y);
await sleep(150);
for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', a3.x, a3.y - i * 60); await sleep(40); }
await sleep(100);
await mouse('mouseReleased', a3.x, a3.y - 330);
await sleep(400);
const o5 = await orderOf();
check('竖向滑动不触发拖动', JSON.stringify(o4) === JSON.stringify(o5));

await ev(`window.api.invoke('config:save', { catOrder: [] })`);
await send('Page.reload');
console.log(results.every(Boolean) ? 'DRAG3_PASS' : 'DRAG3_FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
