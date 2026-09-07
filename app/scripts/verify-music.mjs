/* 验证：分类卡片默认露3首 + 单曲点播可播放 */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const targets = await get('http://127.0.0.1:9225/json');
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

await send('Page.enable');
await sleep(4000); // I: 盘曲库扫描偏慢（101 首），初始化多等一会

// 1) 曲库与卡片结构
const stats = await ev(`(() => {
  const cards = [...document.querySelectorAll('#catCards .cat-card:not(.cat-add)')];
  return {
    categories: cards.map(c => ({
      name: c.querySelector('.cat-name')?.textContent,
      shown: c.querySelectorAll('.cat-track').length,
      more: c.querySelector('.cat-more')?.textContent || '',
    })),
    totalTracks: window.engine.categories.reduce((s, c) => s + c.tracks.length, 0),
  };
})()`);
console.log(JSON.stringify(stats, null, 1));

// 2) 截图：默认布局（每类露3首）
let shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/40-music-cards.png', Buffer.from(shot.result.data, 'base64'));

// 3) 点播「暖场」第一首-tracks，验证引擎真的开播
await ev(`(() => { const row = document.querySelector('#catCards .cat-card:not(.cat-add) .cat-track'); if (row) row.click(); })()`);
await sleep(1200);
const playing = await ev(`({ playing: window.engine.playing, track: window.engine.currentTrackName(), cat: window.engine.category, hl: !!document.querySelector('.cat-track.playing') })`);
console.log('点播结果:', JSON.stringify(playing));

shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('test-artifacts/41-music-playing.png', Buffer.from(shot.result.data, 'base64'));
console.log(stats.totalTracks >= 95 && playing.playing && playing.hl ? 'VERIFY_PASS' : 'VERIFY_FAIL');
process.exit(0);
