/* 迷你模式验证：进入变形 → 按钮代理可用 → 右下角停靠收起/展开 → 退出还原
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

try {
  for (let i = 0; i < 40; i++) {
    // 等按钮事件绑定完成（元素先渲染、bindUI 后绑定，只等元素会抢跑）
    if (await ev(`!!(window.api && document.getElementById('btnMini') && typeof document.getElementById('btnMini').onclick === 'function')`).catch(() => false)) break;
    await sleep(500);
  }

  // ① 顶栏「迷你」按钮存在；设置里有自动隐藏开关
  check('顶栏迷你按钮存在', await ev(`!!document.getElementById('btnMini')`));
  check('设置里迷你自动隐藏开关存在', await ev(`!!document.getElementById('setMiniAutoHide')`));

  // ② 预置右下角停靠位置（横排条 540×132，按主屏 DIP 2560×1440 算角落），再进入迷你模式；进入可能是异步的，轮询等它生效
  await ev(`window.api.invoke('config:save', { miniBounds: { x: 2008, y: 1296, width: 540, height: 132 } })`);
  await ev(`document.getElementById('btnMini').click()`);
  let entered = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    entered = await ev(`({
      mini: document.body.classList.contains('mini-mode'),
      dockShown: !document.getElementById('miniDock').hidden,
      contentHidden: getComputedStyle(document.querySelector('.content')).display === 'none',
      topbarHidden: getComputedStyle(document.querySelector('.topbar')).display === 'none',
      w: window.innerWidth, h: window.innerHeight,
    })`);
    if (entered.mini && entered.w <= 560) break;
  }
  check('进入迷你模式：横排小条且业务区隐藏', entered.mini && entered.dockShown && entered.contentHidden && entered.topbarHidden && entered.w <= 560 && entered.h <= 200, JSON.stringify(entered));

  // ③ 迷你按钮代理：切分类 → 播放/暂停（状态行跟随）
  await ev(`document.getElementById('miniCat').click()`);
  await sleep(1800);
  const st1 = await ev(`document.getElementById('miniStatus').textContent`);
  check('迷你「切分类」直接开播', /♪/.test(st1 || ''), st1);
  await ev(`document.getElementById('miniPlay').click()`);
  await sleep(500);
  const st2 = await ev(`document.getElementById('miniStatus').textContent`);
  check('迷你「播放」暂停生效', /已暂停/.test(st2 || ''), st2);

  // ④ 右下角停靠：收起 → 小把手（Windows 系统最小窗宽约 136px，断 ≤150）；靠近 → 展开还原
  const col = await ev(`window.api.invoke('window:miniCollapse')`);
  await sleep(500);
  const collapsedW = await ev(`window.innerWidth`);
  check('停靠右下角时可收起成把手', !!(col && col.ok) && collapsedW <= 150, `${JSON.stringify(col)} w=${collapsedW}`);
  const exp = await ev(`window.api.invoke('window:miniExpand')`);
  await sleep(500);
  const expandedW = await ev(`window.innerWidth`);
  check('靠近展开还原迷你条尺寸', !!(exp && exp.ok) && expandedW >= 460 && expandedW <= 560, `ok=${exp && exp.ok} w=${expandedW}`);

  // ⑤ 退出迷你模式 → 还原正常尺寸
  await ev(`document.getElementById('miniExpand').click()`);
  await sleep(1000);
  const exited = await ev(`({
    mini: document.body.classList.contains('mini-mode'),
    contentShown: getComputedStyle(document.querySelector('.content')).display !== 'none',
    w: window.innerWidth,
  })`);
  check('退出迷你模式：完整面板还原', !exited.mini && exited.contentShown && exited.w >= 900, JSON.stringify(exited));

  await ev(`window.api.invoke('config:save', { miniMode: false })`).catch(() => { });
} catch (e) {
  check('执行异常', false, String(e));
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 项通过`);
try { ws.close(); } catch { }
process.exit(pass === results.length ? 0 : 1);
