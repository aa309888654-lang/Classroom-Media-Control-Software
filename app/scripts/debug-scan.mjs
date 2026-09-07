/* 排查曲库扫描：library:scan 与 app:getInit 的真实返回/报错 */
import http from 'node:http';
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
console.log('library:scan =>', await invokeResult('library:scan'));
console.log('app:getInit =>', await invokeResult('app:getInit'));
async function invokeResult(ch) {
  const r = await send('Runtime.evaluate', {
    expression: `window.api.invoke(${JSON.stringify(ch)}).then(x => JSON.stringify(x, null, 0).slice(0, 400)).catch(e => 'REJECT:' + e.message)`,
    returnByValue: true, awaitPromise: true,
  });
  return r.result?.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.exception?.description || '')) : r.result?.result?.value;
}
process.exit(0);
