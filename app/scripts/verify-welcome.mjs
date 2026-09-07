/* 欢迎屏 E2E 简化版 */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + n + (d ? ' | ' + d : '')); };

const PORT = '9247';
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

for (let i = 0; i < 40; i++) {
  const n = await ev(`document.querySelectorAll('#catCards .cat-card:not(.cat-add)').length`).catch(() => 0);
  if (n >= 6) break;
  await sleep(500);
}

await ev(`document.getElementById('btnWelcome').click()`);
await sleep(700);
check('弹窗打开', await ev(`!document.getElementById('welcomeOverlay').hidden`));

const meta = await ev(`(() => ({
  text: document.getElementById('wlText').value,
  bgCount: document.querySelectorAll('#wlBgs .wl-bg-chip').length,
  styleCount: document.querySelectorAll('#wlStyles .wl-style-chip').length,
}))()`);
check('默认文字来自配置', meta.text.includes('欢迎'));
check('10 背景/10 样式就绪', meta.bgCount === 10 && meta.styleCount === 10, `${meta.bgCount}/${meta.styleCount}`);

await ev(`(() => {
  const t = document.getElementById('wlText');
  t.value = '欢迎张局莅临指导';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelectorAll('#wlStyles .wl-style-chip')[6].click();
  document.querySelectorAll('#wlBgs .wl-bg-chip')[5].click();
})()`);
await sleep(700);
const prev = await ev(`(() => ({
  cls: document.getElementById('wlPreview').className,
  title: (document.querySelector('#wlPreview .w-title') || {}).textContent || '',
  bg: ((document.querySelector('#wlPreview .w-bg') || {}).style || {}).backgroundImage || '',
}))()`);
check('预览类名切到 ts7', prev.cls.includes('ts7'), prev.cls);
check('预览文字跟随编辑', prev.title.includes('张局'), prev.title);
check('预览背景切到 06.jpg', prev.bg.includes('06.jpg'));

await ev(`document.getElementById('btnWelcomeOpen').click()`);
await sleep(2500);
const list2 = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const recv = list2.find((t) => t.url.includes('welcome.html'));
check('欢迎接收窗口已创建', !!recv);

const st = await ev(`window.api.invoke('welcome:state')`);
check('welcome:state = open', st && st.open === true, JSON.stringify(st));

if (recv) {
  const att = await send(null, 'Target.attachToTarget', { targetId: recv.id, flatten: true });
  const recvS = att.result.sessionId;
  const shot = await send(recvS, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test-artifacts/60-welcome-screen.png', Buffer.from(shot.result.data, 'base64'));
  const titleR = await send(recvS, 'Runtime.evaluate', {
    expression: 'document.getElementById("title").innerText',
    returnByValue: true,
  });
  console.log('接收窗文字:', JSON.stringify(titleR.result?.result?.value));
}

console.log(results.every(Boolean) ? 'WELCOME_PASS' : 'WELCOME_FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
