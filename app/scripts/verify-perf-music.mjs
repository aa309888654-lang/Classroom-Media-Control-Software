/* 性能优化回归：进度条按需运行（空闲停/播放跑）+ 音乐播放状态防抖重建不破坏功能
 * 前置：electron . --remote-debugging-port=9247
 */
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

const list = await getJson('http://127.0.0.1:9247/json/list');
const main = list.find((x) => x.url.includes('index.html'));
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expr) => new Promise((res) => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
}).then((m) => m.result?.result?.value);

// 等面板就绪
for (let i = 0; i < 30; i++) {
  if (await ev(`!!(window.api && document.getElementById('npProgress'))`).catch(() => false)) break;
  await sleep(500);
}

// ① 空闲时进度循环应是停的（无在播曲目时不占帧）
const idleProbe = await ev(`(() => {
  const hidden = document.getElementById('npProgress').style.display === 'none';
  return { hidden };
})()`);
check('空闲时进度条隐藏', idleProbe.hidden === true, JSON.stringify(idleProbe));

// ② 点播一个分类 → 播放开始 → 进度条出现且推进
await ev(`(() => { const head = document.querySelector('#catCards .cat-card .cat-head') || document.querySelector('#catCards .cat-card'); if (head) head.click(); return true; })()`);
await sleep(2500);
const playProbe = await ev(`(() => {
  const p = document.getElementById('npProgress');
  const w1 = document.getElementById('npFill').style.width;
  return new Promise((res) => setTimeout(() => {
    res({ visible: p.style.display, w1, w2: document.getElementById('npFill').style.width,
          track: document.getElementById('nowTrack').textContent });
  }, 900));
})()`);
check('播放后进度条可见且推进', playProbe.visible === 'block' && playProbe.w1 !== playProbe.w2, JSON.stringify(playProbe));

// ③ 暂停：状态文本更新（防抖后的 onMusicState 仍工作）
await ev(`document.getElementById('btnPlay').click()`);
await sleep(400);
const pauseProbe = await ev(`document.getElementById('nowCat').textContent`);
check('暂停后状态文本正确（防抖渲染未破坏）', /已暂停/.test(pauseProbe || ''), pauseProbe);

// 恢复播放再停掉，收尾
await ev(`document.getElementById('btnPlay').click()`).catch(() => { });
await sleep(300);

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 项通过`);
try { ws.close(); } catch { }
process.exit(pass === results.length ? 0 : 1);
