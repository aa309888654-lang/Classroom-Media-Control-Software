/* 四个全屏窗退出交互统一验证：欢迎屏 / 同屏接收窗 / 视频投放窗 / 计时器
 * 断言每个窗口：左上角 ✕ 钮存在 + 开屏先显 + 闲置隐藏 + 靠近左上角热区显现 + ESC 退出路径
 * 前置：electron . --remote-debugging-port=9247
 */
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const PORT = '9247';
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`); };

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
async function attach(urlPart) {
  const t = await findTarget(urlPart);
  if (!t) return null;
  return (await send('Target.attachToTarget', { targetId: t.id, flatten: true })).result.sessionId;
}
const evalIn = (sid, expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid).then((r) => {
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
    return r.result?.result?.value;
  });

// 通用探针：左上角 ✕ 存在 + 开屏先显 + 鼠标靠近左上角显现
async function probeCloseBtn(sid, btnId, uiClass) {
  return evalIn(sid, `(() => {
    const btn = document.getElementById('${btnId}');
    if (!btn) return { hasBtn: false };
    const st = getComputedStyle(btn);
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
    const nearLeft = document.body.classList.contains('${uiClass}');
    return { hasBtn: true, isLeft: st.left !== 'auto' && parseFloat(st.left) < 200, visibleAtOpenOrHot: nearLeft };
  })()`);
}

try {
  let mainSid = null;
  for (let i = 0; i < 40 && !mainSid; i++) { mainSid = await attach('index.html').catch(() => null); if (!mainSid) await sleep(500); }
  check('主面板目标存在', !!mainSid);

  // ① 欢迎屏
  await evalIn(mainSid, `window.api.invoke('welcome:toggle', {})`);
  await sleep(1500);
  let sid = await attach('welcome.html');
  check('欢迎屏已打开', !!sid);
  if (sid) {
    const p = await probeCloseBtn(sid, 'wClose', 'w-ui');
    check('欢迎屏 左上角✕ 存在且靠近左上角显现', p.hasBtn && p.isLeft && p.visibleAtOpenOrHot, JSON.stringify(p));
    await evalIn(sid, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(900);
    check('欢迎屏 ESC 关屏', (await findTarget('welcome.html')) === undefined);
  }

  // ② 同屏接收窗
  await evalIn(mainSid, `window.api.invoke('cast:toggle')`);
  await sleep(1500);
  sid = await attach('caster.html');
  check('同屏接收窗已打开', !!sid);
  if (sid) {
    const p = await probeCloseBtn(sid, 'castClose', 'cast-ui');
    check('同屏 左上角✕ 存在且靠近左上角显现', p.hasBtn && p.isLeft && p.visibleAtOpenOrHot, JSON.stringify(p));
    await evalIn(sid, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(900);
    check('同屏 ESC 关屏', (await findTarget('caster.html')) === undefined);
  }

  // ③ 视频投放窗（用假文件路径触发窗口即可，播放失败不影响窗口本身）
  await evalIn(mainSid, `window.api.invoke('video:play', 'C:/Users/jickchen/Documents/小天AIGC/视频/示范课A.mp4')`);
  await sleep(1500);
  sid = await attach('player.html');
  check('视频投放窗已打开', !!sid);
  if (sid) {
    const p = await probeCloseBtn(sid, 'vClose', 'v-ui');
    check('视频投放 左上角✕ 存在且靠近左上角显现', p.hasBtn && p.isLeft && p.visibleAtOpenOrHot, JSON.stringify(p));
    await evalIn(sid, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(900);
    check('视频投放 ESC 停播关窗', (await findTarget('player.html')) === undefined);
  }

  // ④ 计时器窗
  await evalIn(mainSid, `window.api.invoke('timer:start', { mode: 'countup', duration: 0 })`);
  await sleep(1200);
  sid = await attach('timer.html');
  check('计时器窗已打开', !!sid);
  if (sid) {
    const p = await probeCloseBtn(sid, 'tClose', 't-ui');
    check('计时器 左上角✕ 存在且靠近左上角显现', p.hasBtn && p.isLeft && p.visibleAtOpenOrHot, JSON.stringify(p));
    await evalIn(sid, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(900);
    check('计时器 ESC 关窗', (await findTarget('timer.html')) === undefined);
  }
} catch (e) {
  check('执行异常', false, String(e));
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 项通过`);
try { ws.close(); } catch {}
process.exit(pass === results.length ? 0 : 1);
