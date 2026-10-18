/* 品牌防护验证：正常渲染字段 + 官网白名单拦截 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const list = await getJson('http://127.0.0.1:9245/json/list');
const page = list.find((t) => t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
  return r.result?.result?.value;
};
await sleep(2500);

console.log('stVer =', await ev('document.getElementById("stVer").textContent'));
console.log('stSite =', await ev('document.getElementById("stSite").textContent'));
console.log('brand-name =', await ev('document.querySelector(".brand-name").textContent'));
console.log('topbar logo src =', (await ev('document.querySelector(".topbar .logo").src')).slice(0, 64));
console.log('document.title =', await ev('document.title'));
console.log('badhost 拒绝 =', JSON.stringify(await ev('window.api.invoke("app:openExternal", "https://evil.example.com/")')));
process.exit(0);
