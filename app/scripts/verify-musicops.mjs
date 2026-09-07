/* 验证：添加音乐按钮 / 隐藏内置音乐 / 曲目行竖拖排序 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + n + (d ? ' | ' + d : '')); };

const PORT = '9243';
const list0 = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const page = list0.find((t) => t.url.includes('index.html'));
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

/* 1. 添加音乐按钮：可读、所有分类都有 */
const impInfo = await ev(`(() => { const t = [...document.querySelectorAll('.cat-import')].map(e => ({ text: e.textContent.trim(), has: !!e.querySelector('.ico svg') })); return { count: t.length, sample: t[0] }; })()`);
check('每类都有「添加音乐」按钮（含图标）', impInfo.count >= 9 && impInfo.sample.has && impInfo.sample.text.includes('添加音乐'), JSON.stringify(impInfo));

/* 2. 隐藏内置音乐：关闭后曲库只剩用户添加的（本机未添加 → 应为空或近空） */
await ev(`window.api.invoke('config:save', { builtinMusicEnabled: false })`);
await sleep(400);
await ev(`window.api.invoke('library:scan')`).catch(() => ({}));
await send('Page.reload');
await sleep(2500);
const builtinHidden = await ev(`(() => {
  const cats = window.engine.categories.map(c => ({ name: c.category, n: c.tracks.length }));
  const bundle = cats.filter(c => ['暖场','背景音乐','冥想音乐','庆典','颁奖','上舞台','下舞台','轻松'].includes(c.name));
  return { cats, hasBuiltin: bundle.reduce((s, c) => s + c.n, 0) };
})()`);
check('关闭后内置音乐全部隐藏', builtinHidden.hasBuiltin === 0, '剩余内置曲目: ' + builtinHidden.hasBuiltin);
await ev(`window.api.invoke('config:save', { builtinMusicEnabled: true })`);
await sleep(400);
await send('Page.reload');
for (let i = 0; i < 40; i++) {
  const n = await ev(`document.querySelectorAll('#catCards .cat-card:not(.cat-add)').length`).catch(() => 0);
  if (n >= 6) break;
  await sleep(500);
}

/* 3. 曲目行竖拖排序：上舞台 第0首拖到第2首后面 */
const before = await ev(`[...document.querySelector('#catCards .cat-card:not(.cat-add)').querySelectorAll('.cat-track .t-name')].map(e=>e.textContent)`);
const pt = await ev(`(() => {
  const card = document.querySelector('#catCards .cat-card:not(.cat-add)');
  const rows = [...card.querySelectorAll('.cat-track')];
  const r0 = rows[0].getBoundingClientRect(), r2 = rows[2].getBoundingClientRect();
  return { ax: Math.round(r0.x + r0.width / 2), ay: Math.round(r0.y + 3), bx: Math.round(r2.x + r2.width / 2), by: Math.round(r2.y + r2.height / 2 + 2) };
})()`);
await mouse('mousePressed', pt.ax, pt.ay);
await sleep(200);
for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', pt.ax + 2, Math.round(pt.ay + (pt.by - pt.ay) * i / 6)); await sleep(45); }
await sleep(100);
await mouse('mouseReleased', pt.bx + 2, pt.by);
await sleep(500);
const after = await ev(`[...document.querySelector('#catCards .cat-card:not(.cat-add)').querySelectorAll('.cat-track .t-name')].map(e=>e.textContent)`);
check('第0首确实移到了第3位', before[0] === after[2] && before[1] === after[0], JSON.stringify({ before, after }));
const savedMap = await ev(`(async () => { const c = await window.api.invoke('config:save', {}); return c.catTrackOrder || {}; })()`);
check('顺序已保存 catTrackOrder', Object.keys(savedMap || {}).length > 0, JSON.stringify(Object.keys(savedMap || {})));
await ev(`window.api.invoke('config:save', { catTrackOrder: null })`);

console.log(results.every(Boolean) ? 'MUSICOPS_PASS' : 'MUSICOPS_FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
