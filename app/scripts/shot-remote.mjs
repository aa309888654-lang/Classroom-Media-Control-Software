/* 补拍：视频遥控条样式 + 暂停文案验证（不重开视频窗口，纯样式覆盖） */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const targets = await get('http://127.0.0.1:9222/json');
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
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
await send('Page.enable');

// 1) 验证暂停文案
await ev(`window.engine.playCategory('暖场')`);
await sleep(800);
await ev(`window.engine.pause()`);
await sleep(900);
const pausedText = await ev(`document.querySelector('#nowCat').textContent`);
console.log('暂停文案:', pausedText);

// 2) 遥控条样式截图（临时显示，不开视频窗口）
await ev(`document.querySelector('#videoRemote').style.display = 'flex'`);
await ev(`document.querySelector('#btnStopVideo').disabled = false`);
await ev(`document.querySelector('#videoHint').textContent = '投放中：示例视频.mp4（投影屏全屏）'`);
await ev(`document.querySelector('.content').scrollTop = 9999`);
await sleep(300);
const r = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/13-美化-视频遥控条.png', Buffer.from(r.result.data, 'base64'));
await ev(`document.querySelector('#videoRemote').style.display = 'none'`);
await ev(`document.querySelector('#btnStopVideo').disabled = true`);
await ev(`document.querySelector('#videoHint').textContent = ''`);
console.log('截图完成');
process.exit(0);
