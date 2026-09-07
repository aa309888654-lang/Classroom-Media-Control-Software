/* 曲目拖拽一体化诊断：坐标-命中-拖拽-日志-终态（不做中途 reload） */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const PORT = '9244';
const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const page = list.find((t) => t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
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

/* 就绪 */
for (let i = 0; i < 40; i++) {
  const n = await ev(`document.querySelectorAll('#catCards .cat-card:not(.cat-add)').length`).catch(() => 0);
  if (n >= 6) break;
  await sleep(500);
}

/* 插桩 */
await ev(`(() => {
  window.__log = { start: [], finish: [], targets: [], rowsNow: [] };
  const s0 = startTrackDrag, f0 = finishTrackDrag, t0 = trackTargetAt;
  startTrackDrag = (row, cat, idx, y) => { window.__log.start.push([cat.category, idx]); return s0(row, cat, idx, y); };
  finishTrackDrag = (y, cat) => { window.__log.finish.push(Math.round(y)); return f0(y, cat); };
  trackTargetAt = (y, cat) => { const t = t0(y, cat); window.__log.targets.push(t ? [t.idx, t.before] : null); return t; };
  const rows = [...document.querySelector('#catCards .cat-card:not(.cat-add)').querySelectorAll('.cat-track')];
  window.__log.rowsNow = rows.map(r => { const x = r.getBoundingClientRect(); return [Math.round(x.x), Math.round(x.y), Math.round(x.width), Math.round(x.height)]; });
})()`);

const info = await ev(`(() => {
  const cards = document.querySelectorAll('#catCards .cat-card:not(.cat-add)');
  const rows0 = [...cards[0].querySelectorAll('.cat-track')];
  const rc = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y) }; };
  return {
    ax: rc(rows0[0]).x, ay: rc(rows0[0]).y + 4,
    bx: rc(rows0[2]).x, by: rc(rows0[2]).y + Math.round(rows0[2].getBoundingClientRect().height / 2 + 2),
    hit: (document.elementFromPoint(rc(rows0[0]).x, rc(rows0[0]).y + 4) || {}).className || 'none',
  };
})()`);
console.log('hit:', info.hit, 'ax/ay:', info.ax, info.ay, 'bx/by:', info.bx, info.by);

await mouse('mousePressed', info.ax, info.ay);
await sleep(200);
for (let i = 1; i <= 6; i++) {
  await mouse('mouseMoved', info.ax + 2, Math.round(info.ay + (info.by - info.ay) * i / 6));
  await sleep(45);
}
await sleep(100);
await mouse('mouseReleased', info.bx + 2, info.by);
await sleep(500);

console.log('log:', JSON.stringify(await ev('window.__log')));
console.log('终态曲目:', JSON.stringify(await ev('[...document.querySelector(\'#catCards .cat-card:not(.cat-add)\').querySelectorAll(\'.cat-track .t-name\')].map(e => e.textContent)')));
process.exit(0);
