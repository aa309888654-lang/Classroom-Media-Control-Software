/* 排查卡片不渲染：dump 面板状态与 console 错误 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const PORT = '9241';
const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const page = list.find((t) => t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || 'eval err' };
  return r.result?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await sleep(4000);

const info = await ev(`(() => ({
  engineCats: (window.engine && window.engine.categories ? window.engine.categories.length : 'NA'),
  cardEls: document.querySelectorAll('#catCards').length,
  catCardKids: document.querySelector('#catCards') ? document.querySelector('#catCards').children.length : -1,
  bodyClasses: document.body.className,
  initOk: !!document.querySelector('#nowTrack'),
}))()`);
console.log('INFO:', JSON.stringify(info, null, 1));

// 获取最近的 console 错误
const errs = await ev(`window.__errs ? window.__errs.slice(-5) : null`);
console.log('ERRS:', JSON.stringify(errs));
process.exit(0);
