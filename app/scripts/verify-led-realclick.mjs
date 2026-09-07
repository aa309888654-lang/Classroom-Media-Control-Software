/* 真实鼠标事件验证：LED 模式下悬浮条按钮必须真的点得着（含遮挡检查） */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const targets = await get('http://127.0.0.1:9224/json');
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
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

await send('Page.enable');
await sleep(1200);

// 1) 真实点击「切到LED投屏」（顶栏按钮）
const btnRect = await ev(`(() => { const r = document.querySelector('#btnMode').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await realClick(Math.round(btnRect.x), Math.round(btnRect.y));
await sleep(900);
const ledOn = await ev(`document.body.classList.contains('led-mode')`);
console.log('进入LED:', ledOn);

// 2) 遮挡检查：🖥 按钮中心点命中的必须是按钮自身
await ev(`document.querySelector('#ledDockToggle').click()`); // 顺手展开控制条，模拟最乱状态
await sleep(400);
const hit = await ev(`(() => {
  const b = document.querySelector('#ledModeBack');
  const r = b.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const el = document.elementFromPoint(cx, cy);
  return { cx: Math.round(cx), cy: Math.round(cy), hitId: el ? el.id || el.className : 'NULL' };
})()`);
console.log('命中检测:', JSON.stringify(hit));

// 3) 真实点击 🖥 返回控制台
await realClick(hit.cx, hit.cy);
await sleep(900);
const backOk = await ev(`!document.body.classList.contains('led-mode')`);
console.log('返回控制台:', backOk);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/33-realclick-back.png', Buffer.from(shot.result.data, 'base64'));
const pass = ledOn && hit.hitId === 'ledModeBack' && backOk;
console.log(pass ? 'REAL_CLICK_PASS' : 'REAL_CLICK_FAIL');
process.exit(pass ? 0 : 1);
