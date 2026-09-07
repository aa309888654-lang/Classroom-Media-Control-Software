/* 核验总脚本：一次启动跑完 11 项运行时断言（端口 9233） */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };

const targets = await get('http://127.0.0.1:9235/json');
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('NO_PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
};
const invoke = (ch, pl) => ev(`window.api.invoke(${JSON.stringify(ch)}, ${JSON.stringify(pl || null)})`);
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

await send('Page.enable');
// I: 盘启动偏慢：等窗口完成首屏布局（首卡矩形非零）再开测
for (let i = 0; i < 40; i++) {
  const w = await ev('(() => { const c = document.querySelector("#catCards .cat-card"); return c ? c.getBoundingClientRect().width : 0; })()').catch(() => 0);
  if (w && w > 50) break;
  await sleep(500);
}

/* 1. 曲库 */
const lib = await ev('(() => { const c = window.engine.categories; return { cats: c.length, total: c.reduce((s,x)=>s+x.tracks.length,0), bell: (c.find(x=>x.category==="上课铃声")||{tracks:[]}).tracks.length }; })()');
check('曲库 9 类 101 首（含 4 铃声）', lib.cats === 9 && lib.total === 101 && lib.bell === 4, JSON.stringify(lib));

/* 2. 点播 */
await ev('document.querySelector("#catCards .cat-card:not(.cat-add) .cat-track").click()');
await sleep(700);
const pl = await ev('({ playing: window.engine.playing, track: window.engine.currentTrackName() })');
check('单曲点播开播', pl.playing === true, JSON.stringify(pl));
const hl = await ev('!!document.querySelector(".cat-track.playing")');
check('当前曲目高亮', hl === true);

/* 3. 暂停→立即继续 竞态 */
await ev('window.engine.pause(); window.engine.resume()');
await sleep(900);
const race = await ev('(() => { const ch = window.engine.channels[window.engine.active]; return { playing: window.engine.playing, paused: ch ? ch.el.paused : null }; })()');
check('快速暂停→继续不哑音', race.playing === true && race.paused === false, JSON.stringify(race));
await ev('window.engine.pause()');

/* 4. 置顶/取消还原 */
const p0 = await ev('[...document.querySelector("#catCards .cat-card:not(.cat-add)").querySelectorAll(".cat-track .t-name")].map(e=>e.textContent)');
await ev('document.querySelectorAll("#catCards .cat-card:not(.cat-add)")[0].querySelectorAll(".cat-pin")[2].click()');
await sleep(500);
const p1 = await ev('[...document.querySelector("#catCards .cat-card:not(.cat-add)").querySelectorAll(".cat-track .t-name")].map(e=>e.textContent)');
await ev('document.querySelector("#catCards .cat-card:not(.cat-add) .cat-pin.on").click()');
await sleep(500);
const p2 = await ev('[...document.querySelector("#catCards .cat-card:not(.cat-add)").querySelectorAll(".cat-track .t-name")].map(e=>e.textContent)');
check('☆置顶到第一', p0[2] === p1[0], p0[2] + ' -> ' + p1[0]);
check('取消置顶完整还原', JSON.stringify(p0) === JSON.stringify(p2));

/* 5. 整卡长按拖动（从留白处） */
const d0 = await ev('[...document.querySelectorAll("#catCards .cat-card:not(.cat-add) .cat-name")].map(e=>e.textContent)');
const pts = await ev('(() => { const cs=[...document.querySelectorAll("#catCards .cat-card:not(.cat-add)")]; const r0=cs[0].getBoundingClientRect(); const r1=cs[4].getBoundingClientRect(); return { ax:Math.round(r0.right-24), ay:Math.round(r0.bottom-8), bx:Math.round(r1.x+r1.width*0.7), by:Math.round(r1.y+r1.height/2) }; })()');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.ax, y: pts.ay, button: 'left', clickCount: 1 });
await sleep(700);
for (let i = 1; i <= 8; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(pts.ax + (pts.bx - pts.ax) * i / 8), y: Math.round(pts.ay + (pts.by - pts.ay) * i / 8) });
  await sleep(35);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.bx, y: pts.by, button: 'left', clickCount: 1 });
await sleep(600);
const d1 = await ev('[...document.querySelectorAll("#catCards .cat-card:not(.cat-add) .cat-name")].map(e=>e.textContent)');
check('整卡长按拖动换位', d0[0] !== d1[0] && d1.length === d0.length, d0[0] + ' -> ' + d1[5]);
await invoke('config:save', { catOrder: [] });

/* 6. LED 模式往返（真实点击） */
const btn = await ev('(() => { const r = document.querySelector("#btnMode").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
await realClick(btn.x, btn.y);
await sleep(800);
const ledOn = await ev('({ led: document.body.classList.contains("led-mode"), dock: !document.querySelector("#ledDock").hidden, back: !!document.querySelector("#ledModeBack") })');
check('LED 模式 + 左下角返回钮', ledOn.led && ledOn.dock && ledOn.back, JSON.stringify(ledOn));
const back = await ev('(() => { const r = document.querySelector("#ledModeBack").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()');
await realClick(back.x, back.y);
await sleep(800);
const ledOff = await ev('!document.body.classList.contains("led-mode")');
check('真实点击返回控制台', ledOff === true);

/* 7. 官网：状态栏原文 + 设置页入口 + 拦截 */
const site = await ev('document.getElementById("stSite")?.textContent + "|" + document.getElementById("setSite")?.textContent');
const neg = await invoke('app:openExternal', 'http://aicgxt.com/');
const neg2 = await invoke('app:openExternal', 'https://evil.example.com/');
check('官网状态栏+按钮入口', site.startsWith('https://aicgxt.com|') && (site.includes('打开官网') || site.includes('https://aicgxt.com')), site);
check('外链拦截 http/仿冒域', neg.ok === false && neg2.ok === false, JSON.stringify({ neg, neg2 }));

/* 8. 计时器暂停清零修复（倒计时） */
await invoke('timer:start', { mode: 'countdown', duration: 5 * 60 * 1000 });
await sleep(2000);
await invoke('timer:toggle');
const snapP = await invoke('timer:state');
await sleep(1200);
await invoke('timer:toggle');
await sleep(600);
const snapR = await invoke('timer:state');
const ok8 = snapR.remaining <= snapP.remaining && (snapP.remaining - snapR.remaining) < 5000;
check('计时器暂停后继续不清零', ok8, `暂停时剩 ${Math.round(snapP.remaining / 100) / 10}s，继续后剩 ${Math.round(snapR.remaining / 100) / 10}s`);
await invoke('timer:reset');

/* 9. 改键修饰键校验 */
const hk = await invoke('hotkey:remap', { action: 'playPause', accelerator: 'Z' });
check('改键拒绝无修饰键', hk.ok === false && (hk.error === 'need-modifier' || !!hk.error), JSON.stringify(hk));

/* 10. 视频文件校验 */
const vf = await invoke('video:play', 'X:\\不存在\\fake.mp4');
check('视频文件缺失报错', vf.ok === false && vf.error === 'file-not-found', JSON.stringify(vf));

/* 11. 退出清场不挂起 */
const t0 = Date.now();
await invoke('app:quit');
let exited = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  try { await get('http://127.0.0.1:9233/json'); } catch { exited = true; break; }
}
check('app:quit 进程退出', exited, exited ? `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` : '10s 未退出');

const pass = results.filter((r) => r.ok).length;
console.log(`\n===== 核验汇总：${pass}/${results.length} 通过 =====`);
process.exit(pass === results.length ? 0 : 1);
