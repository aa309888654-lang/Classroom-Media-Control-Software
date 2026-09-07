/* 验证同屏修复：带 origin 豁免的 Chrome 走 LAN IP 应能拿到 getDisplayMedia 并出图 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

// 面板 CDP
const list = await getJson('http://127.0.0.1:9247/json/list');
const main = list.find((x) => x.url.includes('index.html'));
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let mid = 0; const mp = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && mp.has(m.id)) { mp.get(m.id)(m); mp.delete(m.id); } };
const mainEval = (expr) => new Promise((res) => {
  const i = ++mid; mp.set(i, res);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
}).then((m) => m.result?.result?.value);

// 等面板就绪
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  ready = await mainEval(`!!(window.api && document.getElementById('btnCast'))`).catch(() => false);
  if (!ready) await sleep(500);
}
let cur = await mainEval(`window.api.invoke('cast:state')`);
if (!cur || !cur.running) { await mainEval(`window.api.invoke('cast:toggle')`); await sleep(1200); cur = await mainEval(`window.api.invoke('cast:state')`); }
if (!cur || !cur.url) { console.log('同屏服务未启动', JSON.stringify(cur)); process.exit(1); }
const url = cur.url;
const origin = new URL(url).origin;
console.log('同屏 URL =', url);

// ① /fix.bat 可下载且内容含豁免参数
const bat = await new Promise((res) => {
  http.get(origin + '/fix.bat', (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, body: d })); }).on('error', () => res({ code: 0, body: '' }));
});
check('fix.bat 可下载且含豁免参数', bat.code === 200 && bat.body.includes('unsafely-treat-insecure-origin-as-secure'), `code=${bat.code} len=${bat.body.length} flag=${bat.body.includes('unsafely')}`);

// ② 带豁免参数的 Chrome 走 LAN IP：getDisplayMedia 应恢复
const chromeExe = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const tmp = fs.mkdtempSync(os.tmpdir() + '/cast-fix-');
const chrome = spawn(chromeExe, [
  `--unsafely-treat-insecure-origin-as-secure=${origin}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--remote-debugging-port=9333', '--user-data-dir=' + tmp,
  '--no-first-run', '--new-window', url + '/?auto=1',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 20 && !targets; i++) {
  await sleep(1000);
  targets = await getJson('http://127.0.0.1:9333/json/list').catch(() => null);
}
const sender = targets && targets.find((t) => t.url.includes(':18333'));
check('发送端页打开', !!sender);
if (sender) {
  const sws = new WebSocket(sender.webSocketDebuggerUrl);
  await new Promise((r) => (sws.onopen = r));
  const sev = (expr) => new Promise((res) => {
    const h = (e) => { const m = JSON.parse(e.data); if (m.id === 7) { sws.removeEventListener('message', h); res(m.result?.result?.value); } };
    sws.addEventListener('message', h);
    sws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  await sleep(2000);
  const probe = JSON.parse(await sev(`JSON.stringify({
    isSecureContext: window.isSecureContext,
    hasGDM: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
    st: document.getElementById('st').textContent,
  })`));
  check('豁免后 getDisplayMedia 恢复', probe.isSecureContext === true && probe.hasGDM === true, JSON.stringify(probe));
  sws.close();
}

// ③ 接收端应出图
let shot = 'no-frame';
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  const recvList = await getJson('http://127.0.0.1:9247/json/list').catch(() => []);
  const recv = recvList.find((t) => t.url.includes('caster.html'));
  if (!recv) continue;
  const rws = new WebSocket(recv.webSocketDebuggerUrl);
  await new Promise((r) => (rws.onopen = r));
  const vs = await new Promise((res) => {
    rws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 3) res(m.result?.result?.value); };
    rws.send(JSON.stringify({ id: 3, method: 'Runtime.evaluate', params: { expression: `JSON.stringify({vw:document.getElementById('v').videoWidth,rs:document.getElementById('v').readyState})`, returnByValue: true } }));
  });
  rws.close();
  if (vs && JSON.parse(vs).vw > 0) { shot = vs; break; }
}
check('接收端收到视频帧（LAN 全链路）', shot !== 'no-frame', shot);

try { chrome.kill(); } catch { }
await mainEval(`window.api.invoke('cast:toggle')`).catch(() => { });
ws.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
console.log(results.every(Boolean) ? 'CAST_FIX_OK' : 'CAST_FIX_FAIL');
process.exit(results.every(Boolean) ? 0 : 1);
