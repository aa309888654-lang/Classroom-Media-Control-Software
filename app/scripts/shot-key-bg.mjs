/* 抓取关键几张新背景上屏截图（01参考 / 12红金筑梦 / 13蓝金致远 / 15晨曦鎏光 / 18霁蓝轻纱）
 * 用按钮点击开屏（不等 invoke 返回，避免大屏抢焦后 index IPC 回包卡住），
 * 在 welcome 会话内截图（race 超时），再用 ✕ 按钮关屏（已验证可靠）。 */
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

const targets = [
  [1, '鎏金风华'], [12, '红金筑梦'], [13, '蓝金致远'], [15, '晨曦鎏光'], [18, '霁蓝轻纱'],
];
let ok = 0;
for (const [bgIdx, label] of targets) {
  // 点选背景 chip → 点开屏按钮（wlOpen 异步，click 不等返回，避免卡住）
  await mainEval(`(() => {
    const chips = document.querySelectorAll('#wlBgs .wl-bg-chip');
    if (chips[${bgIdx - 1}]) chips[${bgIdx - 1}].click();
  })()`);
  await sleep(200);
  await mainEval(`document.getElementById('btnWelcomeOpen').click()`);
  await sleep(1500);
  const wl = await findTarget('welcome.html');
  if (!wl) { console.log(`✖ ${bgIdx} ${label}：未开屏`); continue; }
  const att = await send('Target.attachToTarget', { targetId: wl.id, flatten: true });
  const sid = att.result.sessionId;
  const shot = await Promise.race([
    send('Page.captureScreenshot', { format: 'png' }, sid),
    sleep(8000).then(() => null),
  ]);
  // 用 ✕ 按钮关屏（welcome 会话内 invoke，可靠）
  try { await send('Runtime.evaluate', { expression: `document.getElementById('wClose').click()` }, sid); } catch {}
  await sleep(900);
  if (!shot || !shot.result) { console.log(`✖ ${bgIdx} ${label}：截图超时`); continue; }
  const out = path.join(OUT, `${String(bgIdx).padStart(2, '0')}-${label}.png`);
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  ok++;
  console.log(`✔ ${out}`);
}
console.log(`完成 ${ok}/${targets.length}`);
try { ws.close(); } catch {}
process.exit(0);
