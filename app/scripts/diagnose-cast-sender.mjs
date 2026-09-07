/* 同屏根因确认：发送端页面在 LAN IP（非 localhost）下的 API 可用性
 * 假设：getDisplayMedia 只在 secure context（https / localhost / 127.0.0.1）可用，
 *       http://192.168.x.x 下 navigator.mediaDevices 被浏览器整个拿掉 → 无法发起共享
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

// 通过面板 CDP 开同屏，拿 URL
const list = await getJson('http://127.0.0.1:9247/json/list');
const main = list.find((x) => x.url.includes('index.html'));
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const mainEval = (expr) => new Promise((res) => {
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m.result?.result?.value); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
let cur = await mainEval(`window.api.invoke('cast:state')`);
if (!cur || !cur.running) { await mainEval(`window.api.invoke('cast:toggle')`); await sleep(800); cur = await mainEval(`window.api.invoke('cast:state')`); }
const url = cur.url;
console.log('同屏 URL =', url);
ws.close();

// 起一个带调试口的 Chrome 访问 LAN IP 发送端
const chromeExe = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
console.log('浏览器 =', chromeExe);
const tmp = fs.mkdtempSync(os.tmpdir() + '/cast-sender-');
const chrome = spawn(chromeExe, [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--remote-debugging-port=9333', '--user-data-dir=' + tmp,
  '--no-first-run', '--new-window', url + '/?auto=1',
], { stdio: 'ignore' });

// 等调试口起来（最多 20s）
let targets = null;
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  try { targets = await getJson('http://127.0.0.1:9333/json/list'); break; } catch { }
}
if (!targets) { console.log('发送端 Chrome 调试口未起'); try { chrome.kill(); } catch {} process.exit(1); }
const sender = targets.find((t) => t.url.includes(':18333'));
if (!sender) { console.log('发送端页未找到，现有:', targets.map((t) => t.url)); try { chrome.kill(); } catch {} process.exit(1); }

const sws = new WebSocket(sender.webSocketDebuggerUrl);
await new Promise((r) => (sws.onopen = r));
const senderEval = (expr) => new Promise((res) => {
  sws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 7) res(m.result?.result?.value); };
  sws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
await sleep(1500);
const probe = await senderEval(`JSON.stringify({
  st: document.getElementById('st').textContent,
  isSecureContext: window.isSecureContext,
  hasMediaDevices: !!navigator.mediaDevices,
  hasGDM: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
})`);
console.log('LAN 发送端探测 =', probe);
sws.close();
try { chrome.kill(); } catch { }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
process.exit(0);
