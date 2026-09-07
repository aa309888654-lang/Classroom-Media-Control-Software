/* 20 套欢迎背景逐张上屏渲染存档（test-artifacts/bg-preview/01..20.png）
 * 只开一次大屏窗，用 CDP 在 welcome.html 页内 navigate 切换 bg 参数逐张截图，
 * 避免反复开/关屏导致 index 渲染进程在大屏全屏时偶发 IPC 卡顿。
 * 前置：electron . --remote-debugging-port=9247
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const PORT = '9247';
const OUT = path.join(process.cwd(), 'test-artifacts', 'bg-preview');
fs.mkdirSync(OUT, { recursive: true });

const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}, session) => new Promise((res) => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: session || undefined }));
});
async function findTarget(urlPart) {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  return list.find((t) => t.url.includes(urlPart));
}

const mainT = await findTarget('index.html');
const mainAtt = await send('Target.attachToTarget', { targetId: mainT.id, flatten: true });
const mainSid = mainAtt.result.sessionId;
const mainEval = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, mainSid);

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'resources', 'welcome-bg', 'manifest.json'), 'utf8'));
const bgDir = path.join(process.cwd(), 'resources', 'welcome-bg');
const wlFile = path.join(process.cwd(), 'src', 'renderer', 'welcome.html');
const fileUrlOf = (p) => 'file:///' + String(p).replace(/\\/g, '/');

// 开一次大屏（bg=1），随后只在该窗口内 navigate 切换 bg
await mainEval(`window.api.invoke('welcome:toggle', { text: '欢迎各位领导莅临指导', sub: '背景预览', bg: 1, style: 1, font: 1 })`);
await sleep(1500);
const wl = await findTarget('welcome.html');
if (!wl) { console.error('大屏窗未打开'); process.exit(1); }
const att = await send('Target.attachToTarget', { targetId: wl.id, flatten: true });
const sid = att.result.sessionId;
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sid);

let ok = 0;
for (let i = 1; i <= manifest.length; i++) {
  const { file, label } = manifest[i - 1];
  const url = `${fileUrlOf(wlFile)}?text=${encodeURIComponent('欢迎各位领导莅临指导')}&sub=${encodeURIComponent('第 ' + i + '/20 套 ' + label)}&bg=${i}&style=1&font=1&lpos=tl&bgpath=${encodeURIComponent(path.join(bgDir, file))}`;
  await send('Page.navigate', { url }, sid);
  await sleep(1100);
  const shot = await Promise.race([
    send('Page.captureScreenshot', { format: 'png' }, sid),
    sleep(4000).then(() => null),
  ]);
  if (!shot || !shot.result) { console.log(`✖ ${i} ${label}：截图超时跳过`); continue; }
  const out = path.join(OUT, `${String(i).padStart(2, '0')}-${label}.png`);
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  ok++;
  console.log(`✔ ${out}`);
}

// 关屏：在 welcome 页内直接 invoke（不经过 index）
try { await send('Runtime.evaluate', { expression: `window.api.invoke('welcome:winClose')`, awaitPromise: true }, sid); } catch {}
console.log(`\n完成：${ok}/${manifest.length} 张`);
try { ws.close(); } catch {}
process.exit(0);
