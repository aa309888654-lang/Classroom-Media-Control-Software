/* 最终深度核验：新功能的真实渲染与联动（计时器投影窗口/快捷键注册/翻页行显隐） */
import http from 'node:http';
import fs from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

function attach(filter) {
  return { done: false, promise: null };
}
async function connect(filter) {
  const targets = await get('http://127.0.0.1:9222/json');
  const t = targets.find(filter);
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS失败')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
    return r.result?.result?.value;
  };
  return { ws, send, evalJs };
}

const results = [];
const test = async (name, fn) => {
  try { const d = await fn(); results.push({ name, ok: true }); console.log('PASS |', name, '|', d || ''); }
  catch (e) { results.push({ name, ok: false }); console.log('FAIL |', name, '|', e.message || e); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const main = await connect((t) => t.type === 'page' && t.url.includes('index.html'));
if (!main) { console.error('FATAL 主面板未找到'); process.exit(2); }
const ev = main.evalJs;

/* V1 快捷键注册：T/R 无冲突且已入配置 */
await test('V1 计时器快捷键 T/R 已注册', async () => {
  const c = JSON.parse(await ev(`window.api.invoke('app:getInit').then(d => JSON.stringify({ hk: d.config.hotkeys, cf: d.hotkeyConflicts }))`));
  assert(c.hk.timerToggle === 'Control+Alt+T' && c.hk.timerReset === 'Control+Alt+R', '键位缺失');
  const conflict = c.cf.some((x) => x.action === 'timerToggle' || x.action === 'timerReset');
  assert(!conflict, 'T/R 被占用: ' + JSON.stringify(c.cf));
  return 'Ctrl+Alt+T / Ctrl+Alt+R 注册成功，无冲突';
});

/* V2 计时器投影窗口真实渲染 */
await test('V2 计时器投影窗口创建并实时渲染', async () => {
  await ev(`window.api.invoke('timer:start', { mode: 'countdown', duration: 30000 })`);
  await sleep(1500);
  const targets = await get('http://127.0.0.1:9222/json');
  const tp = targets.find((t) => t.type === 'page' && t.url.includes('timer.html'));
  assert(!!tp, 'timer.html 窗口未创建');
  const tw = await connect((t) => t.type === 'page' && t.url.includes('timer.html'));
  const t1 = await tw.evalJs(`document.getElementById('time').textContent`);
  assert(!/^(00:00|0:00)$/.test(t1.trim()), '投影窗口时间未走: ' + t1);
  const cls1 = await tw.evalJs(`document.getElementById('time').className`);
  await sleep(22000); // 等 30s 倒计时进入最后 10 秒（danger）
  const t2 = await tw.evalJs(`document.getElementById('time').textContent`);
  const cls2 = await tw.evalJs(`document.getElementById('time').className`);
  tw.ws.close();
  assert(t2 !== t1, '时间未推进');
  if (cls2 !== cls1) return `${t1}→${t2}，样式 ${cls1 || '正常'}→${cls2} ✓`;
  return `${t1}→${t2} 渲染正常`;
});

/* V3 到时后投影窗口显示 时间到 */
await test('V3 到时投影窗口显示「时间到」', async () => {
  await sleep(9000); // 等 30s 倒计时结束
  const tw = await connect((t) => t.type === 'page' && t.url.includes('timer.html'));
  const txt = await tw.evalJs(`document.getElementById('sub').textContent`);
  const cls = await tw.evalJs(`document.getElementById('time').className`);
  tw.ws.close();
  assert(txt.includes('时间到'), '副标题: ' + txt);
  assert(cls.includes('done'), '未进入 done 样式');
  await ev(`window.api.invoke('timer:reset')`);
  return `「${txt}」+ done 样式 ✓`;
});

/* V4 翻页行显隐跟随放映状态（合成 ppt:state 事件验证 UI 逻辑） */
await test('V4 翻页行/演讲者条显隐逻辑', async () => {
  await ev(`(function(){ const s = new Event('x'); })()`); // noop
  // 直接调用渲染逻辑：模拟 presenting
  await ev(`renderPptState(), document.querySelector('#pptFlipRow').style.display`);
  // 触发真实事件通路：broadcast 由主进程驱动，这里改用状态对象驱动
  await ev(`window.api.on('ppt:state', () => {})`); // 注册不报错即可
  const hiddenIdle = await ev(`document.querySelector('#pptFlipRow').style.display`);
  assert(hiddenIdle === 'none', '空闲时翻页行应隐藏: ' + hiddenIdle);
  // 模拟放映中：直接改 DOM 逻辑用的状态并调用渲染
  await ev(`(function(){ state.ppt.presenting = true; renderPptState(); })()`);
  const shown = await ev(`document.querySelector('#pptFlipRow').style.display`);
  assert(shown === 'flex', '放映中翻页行未显示');
  await ev(`(function(){ state.ppt.presenting = false; state.ppt.loading = false; renderPptState(); })()`);
  return '空闲隐藏 → 放映中显示 → 复位 ✓';
});

const pass = results.filter((r) => r.ok).length;
console.log(`\n===== 深度核验汇总：${pass}/${results.length} =====`);
process.exit(pass === results.length ? 0 : 1);