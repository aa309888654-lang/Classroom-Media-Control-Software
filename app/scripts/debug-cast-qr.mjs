/* 排查二维码未绘制与 E2E attach 问题 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

const ver = await getJson('http://127.0.0.1:9236/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const sessions = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (session, method, params = {}) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params, sessionId: session || undefined }));
});
const ev = async (session, expr) => {
  const r = await send(session, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
  return r.result?.result?.value;
};

const list = await getJson('http://127.0.0.1:9236/json/list');
console.log('targets:', list.map((t) => t.url.slice(0, 60)));
const main = list.find((x) => x.url.includes('index.html'));
const mainAtt = await send(null, 'Target.attachToTarget', { targetId: main.id, flatten: true });
const mainS = mainAtt.result.sessionId;

console.log('QRLite type:', await ev(mainS, 'typeof window.QRLite'));
console.log('CastReceiver type:', await ev(mainS, 'typeof window.CastReceiver'));
console.log('encode sample:', await ev(mainS, '(() => { try { const m = window.QRLite.encode("http://192.168.100.4:18333"); return m ? "size=" + m.size : "null"; } catch (e) { return "ERR: " + e.message; } })()'));
console.log('castShown:', await ev(mainS, 'document.getElementById("castInfo").style.display'));
console.log('castUrl text:', await ev(mainS, 'document.getElementById("castUrl").textContent'));
console.log('btnCast text:', await ev(mainS, 'document.getElementById("btnCast").textContent'));
console.log('qr painted:', await ev(mainS, '(() => { const c = document.getElementById("castQr"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) n++; return n; })()'));
process.exit(0);
