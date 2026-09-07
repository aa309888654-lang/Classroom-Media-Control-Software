/* 综合验证：PPT 课件文件夹 + 视频/课件长按拖动排序 + 同屏退出交互
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

try {
  let mainSid = null;
  for (let i = 0; i < 40 && !mainSid; i++) { mainSid = await attach('index.html').catch(() => null); if (!mainSid) await sleep(500); }
  check('主面板目标存在', !!mainSid);

  // ① 设置里有「课件文件夹」行且路径非空
  await evalIn(mainSid, `document.getElementById('btnSettings').click()`);
  await sleep(600);
  const pptRow = await evalIn(mainSid, `(() => {
    const el = document.getElementById('setPptDir');
    const btn = document.getElementById('btnPickPptDir');
    const row = el && el.closest('.form-row');
    return { path: el && el.textContent, hasBtn: !!btn, label: row && row.querySelector('label') && row.querySelector('label').textContent };
  })()`);
  check('设置含「课件文件夹」行且有默认路径', !!(pptRow && pptRow.hasBtn && pptRow.label === '课件文件夹' && pptRow.path), JSON.stringify(pptRow));
  await evalIn(mainSid, `document.getElementById('btnCloseSettings').click()`);
  await sleep(400);

  // ② 课件库芯片渲染（测试假文件 3 个），点选设为当前课件
  const pptChips = await evalIn(mainSid, `Array.from(document.querySelectorAll('#pptChips .ppt-chip')).map((c) => c.dataset.file)`);
  check('课件库渲染 3 个芯片', pptChips.length === 3, JSON.stringify(pptChips.map((f) => f && f.split('\\\\').pop())));
  await evalIn(mainSid, `document.querySelectorAll('#pptChips .ppt-chip')[1].click()`);
  await sleep(300);
  const cur = await evalIn(mainSid, `document.getElementById('pptFile').textContent`);
  const selOk = await evalIn(mainSid, `document.querySelectorAll('#pptChips .ppt-chip')[1].classList.contains('sel')`);
  check('点选课件芯片 → 当前课件跟随', selOk && !/未选择/.test(cur || ''), cur);

  // ③ 视频库芯片渲染
  const vids = await evalIn(mainSid, `Array.from(document.querySelectorAll('#videoChips .video-chip')).map((c) => c.dataset.file)`);
  check('视频库渲染 3 个芯片', vids.length === 3, JSON.stringify(vids.map((f) => f && f.split('\\\\').pop())));

  // ④ 长按拖动排序：把第 1 个视频芯片拖到第 3 个上
  const dragOk = await evalIn(mainSid, `(async () => {
    const chips = document.querySelectorAll('#videoChips .video-chip');
    if (chips.length < 3) return 'chips<3';
    const from = chips[0], to = chips[2];
    const rf = from.getBoundingClientRect(), rt = to.getBoundingClientRect();
    const sx = rf.left + rf.width / 2, sy = rf.top + rf.height / 2;
    const tx = rt.left + rt.width / 2, ty = rt.top + rt.height / 2;
    const pev = (type, x, y, target) => (target || from).dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y,
    }));
    const first = from.dataset.file;
    pev('pointerdown', sx, sy);
    await new Promise((r) => setTimeout(r, 650)); // 长按 0.5s 阈值 + 余量
    pev('pointermove', sx + 40, sy, window); // 横移确认拖拽（listeners 挂在 window）
    pev('pointermove', tx, ty, window);
    pev('pointerup', tx, ty, window);
    await new Promise((r) => setTimeout(r, 400));
    const now = Array.from(document.querySelectorAll('#videoChips .video-chip')).map((c) => c.dataset.file);
    return { first, now: now.map((f) => f.split('\\\\').pop()), movedToEnd: now[now.length - 1] === first };
  })()`);
  check('长按拖动：第 1 个视频移到了最后', !!(dragOk && dragOk.movedToEnd), JSON.stringify(dragOk));
  const savedOrder = await evalIn(mainSid, `window.api.invoke('config:save', {}).then((c) => (c.videoOrder || []).map((f) => f.split('\\\\').pop()))`);
  check('videoOrder 已持久化到 config', Array.isArray(savedOrder) && savedOrder.length === 3, JSON.stringify(savedOrder));

  // ⑤ 同屏：开 → ✕ 钮存在且开屏先显 → 闲置隐藏 → 靠近右上角显现 → ✕ 关屏 → 面板状态复位
  const castOn = await evalIn(mainSid, `window.api.invoke('cast:toggle')`);
  check('同屏开启', !!(castOn && castOn.ok && castOn.running), JSON.stringify(castOn && { ok: castOn.ok, running: castOn.running }));
  await sleep(1500);
  const castSid = await attach('caster.html');
  check('同屏接收窗已打开', !!castSid);
  if (castSid) {
    const c1 = await evalIn(castSid, `({
      hasClose: !!document.getElementById('castClose'),
      visibleAtOpen: document.body.classList.contains('cast-ui'),
      hasApi: !!window.castApi,
    })`);
    check('接收窗 ✕ 钮存在且开屏先显', c1.hasClose && c1.visibleAtOpen && c1.hasApi, JSON.stringify(c1));
    const hidden = await evalIn(castSid, `new Promise((r) => setTimeout(() => r(document.body.classList.contains('cast-ui')), 3200))`);
    check('闲置 2.6 秒后 ✕ 自动隐藏', hidden === false, `cast-ui=${hidden}`);
    const again = await evalIn(castSid, `(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: innerWidth - 10, clientY: 10 }));
      return document.body.classList.contains('cast-ui');
    })()`);
    check('鼠标靠近右上角 ✕ 重新显现', again === true, `cast-ui=${again}`);
    await evalIn(castSid, `document.getElementById('castClose').click()`);
    await sleep(900);
    check('✕ 点击关屏', (await findTarget('caster.html')) === undefined);
    const castOff = await evalIn(mainSid, `window.api.invoke('cast:state')`);
    check('关窗后同屏服务已停止', !!(castOff && castOff.running === false), JSON.stringify(castOff && castOff.running));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' }, mainSid);
  fs.writeFileSync(path.join(process.cwd(), 'test-artifacts', '64-ppt-lib-sort.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('✔ 截图存档 test-artifacts/64-ppt-lib-sort.png');
} catch (e) {
  check('执行异常', false, String(e));
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 项通过`);
try { ws.close(); } catch {}
process.exit(pass === results.length ? 0 : 1);
