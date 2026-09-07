/* 小天AIGC · CDP 第二轮全面测试（补充覆盖）
 * 前置：应用已以 --remote-debugging-port=9222 启动 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ART = path.join(process.cwd(), 'test-artifacts');
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGetJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});
const sendKeys = (s) => execSync(`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys('${s}')"`);

function makeEval(ws, send) {
  return async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error('EVAL: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };
}
async function attach(filter) {
  const targets = await httpGetJson('http://127.0.0.1:9222/json');
  const t = targets.find(filter);
  if (!t) throw new Error('目标页面未找到: ' + targets.map((x) => x.url).join(', '));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 失败')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  return { ws, send, evalJs: makeEval(ws, send) };
}

const main = await attach((t) => t.type === 'page' && t.url.includes('index.html'));
const evalJs = main.evalJs;
const errors = [];
main.ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'unknown');
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
});

/* 等初始化 */
let ready = false;
for (let i = 0; i < 30; i++) {
  try { ready = await evalJs(`!!window.api && document.querySelectorAll('.cat-card').length > 0`); } catch { }
  if (ready) break;
  await sleep(500);
}
if (!ready) { console.error('FATAL: 应用未就绪'); process.exit(3); }

const results = [];
const test = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true }); console.log('PASS |', name, '|', detail || ''); }
  catch (e) { results.push({ name, ok: false }); console.log('FAIL |', name, '|', e.message || e); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ---------- R2-T1 上一首 ---------- */
await test('R2-T1 上一首 prev()', async () => {
  await evalJs(`window.engine.playCategory('暖场')`);
  await sleep(600);
  const i1 = await evalJs(`window.engine.idx`);
  await evalJs(`window.engine.prev()`);
  await sleep(300);
  const i2 = await evalJs(`window.engine.idx`);
  assert(i2 === (i1 - 1 + 3) % 3, `索引 ${i1}→${i2}`);
  return `idx ${i1}→${i2}（回绕正常）`;
});

/* ---------- R2-T2 单曲循环 ---------- */
await test('R2-T2 单曲循环 el.loop 生效', async () => {
  await evalJs(`window.engine.setLoopMode('single')`);
  const loop = await evalJs(`window.engine.channels[window.engine.active].el.loop`);
  const btn = await evalJs(`document.querySelector('#btnLoop').textContent`);
  assert(loop === true, 'el.loop 未置 true');
  assert(btn.includes('单曲'), '按钮文案: ' + btn);
  await evalJs(`window.engine.setLoopMode('list')`);
  return 'el.loop=true ✓ 按钮显示 循环：单曲 ✓ 已还原';
});

/* ---------- R2-T3 分类快捷键 Ctrl+Alt+1/2 ---------- */
await test('R2-T3 全局快捷键 Ctrl+Alt+1/2 切分类', async () => {
  await evalJs(`window.engine.playCategory('轻松')`);
  await sleep(400);
  sendKeys('^%1'); // 切到分类1=暖场
  await sleep(900);
  const cat1 = await evalJs(`window.engine.category`);
  assert(cat1 === '暖场', '^%1 后分类: ' + cat1);
  sendKeys('^%2');
  await sleep(900);
  const cat2 = await evalJs(`window.engine.category`);
  assert(cat2 === '轻松', '^%2 后分类: ' + cat2);
  return `暖场 → 轻松 ✓`;
});

/* ---------- R2-T4 音量快捷键 + OSD ---------- */
await test('R2-T4 Ctrl+Alt+↑/↓ 音量与 OSD 气泡', async () => {
  const v0 = await evalJs(`window.engine.volume`);
  sendKeys('^%{UP}');
  await sleep(700);
  const v1 = await evalJs(`window.engine.volume`);
  const osdShown = await evalJs(`!document.querySelector('#osd').hidden`);
  const osdText = await evalJs(`document.querySelector('#osd').textContent`);
  assert(Math.abs(v1 - v0 - 0.1) < 0.001, `音量 ${v0}→${v1}`);
  assert(osdShown === true, 'OSD 未显示');
  sendKeys('^%{DOWN}');
  await sleep(700);
  const v2 = await evalJs(`window.engine.volume`);
  assert(Math.abs(v2 - v0) < 0.001, '未回落: ' + v2);
  return `音量 ${v0}→${v1}→${v2}，OSD「${osdText}」✓`;
});

/* ---------- R2-T5 放映联动：duck → 无Office降级 → exit 恢复 ---------- */
await test('R2-T5 放映联动（音乐淡出→降级提示→退出恢复）', async () => {
  const r = JSON.parse(await evalJs(`(async () => {
    window.engine.playCategory('暖场');
    await new Promise(r => setTimeout(r, 700));
    const wasPlaying = window.engine.playing;
    const res = await window.api.invoke('ppt:present', null);   // 使用上次选中的真实课件
    await new Promise(r => setTimeout(r, 500));
    const ducked = !window.engine.playing;                       // 放映动作触发了音乐淡出
    const btnPresentEnabled = !document.querySelector('#btnPresent').disabled;
    const btnExitDisabled = document.querySelector('#btnExitPresent').disabled;
    const pstate = await window.api.invoke('ppt:status');
    await window.api.invoke('ppt:exit');
    await new Promise(r => setTimeout(r, 900));
    const restored = window.engine.playing;                      // 退出投屏自动恢复音乐
    return JSON.stringify({ wasPlaying, presentOk: res.ok, ducked, btnPresentEnabled, btnExitDisabled, psOk: pstate.psOk, restored });
  })()`));
  assert(r.wasPlaying === true, '起点未在播放');
  assert(r.presentOk === false, '本机无Office应返回失败(降级)');
  assert(r.ducked === true, '放映动作未触发音乐淡出');
  assert(r.btnPresentEnabled === true, '失败后放映按钮未复位');
  assert(r.btnExitDisabled === true, '退出按钮不应可用');
  assert(r.psOk === true, 'PS 通路异常');
  assert(r.restored === true, '退出投屏后音乐未恢复');
  return 'duck→降级复位→自动恢复 全链路 ✓';
});

/* ---------- R2-T6 Ctrl+Alt+Esc 退出投屏快捷键（幂等无害） ---------- */
await test('R2-T6 Ctrl+Alt+Esc 退出投屏快捷键', async () => {
  const before = await evalJs(`document.querySelector('#btnExitPresent').disabled`);
  sendKeys('^%{ESC}');
  await sleep(1200);
  const after = await evalJs(`document.querySelector('#btnExitPresent').disabled`);
  const stMode = await evalJs(`document.querySelector('#stMode').textContent`);
  assert(before === true && after === true, '退出按钮状态异常');
  assert(!stMode.includes('放映'), '状态栏异常: ' + stMode);
  return `空闲时触发退出投屏：无副作用，状态「${stMode.trim()}」✓`;
});

/* ---------- R2-T7 最近课件选中 ---------- */
await test('R2-T7 点击最近课件芯片选中', async () => {
  const has = await evalJs(`document.querySelectorAll('.recent-chip').length`);
  if (has === 0) return '无历史课件，跳过（合理）';
  const name = await evalJs(`document.querySelector('.recent-chip').textContent`);
  await evalJs(`document.querySelector('.recent-chip').click()`);
  await sleep(150);
  const shown = await evalJs(`document.querySelector('#pptFile').textContent`);
  assert(shown.includes(name.slice(0, 4)), `选中后显示: ${shown}`);
  return `「${name}」选中显示 ✓`;
});

/* ---------- R2-T8 无线投屏占位按钮 ---------- */
await test('R2-T8 无线投屏按钮为 M4 占位（禁用）', async () => {
  const disabled = await evalJs(`document.querySelector('#btnCast').disabled`);
  const badge = await evalJs(`document.querySelector('#btnCast').parentElement.querySelector('.badge')?.textContent || ''`);
  assert(disabled === true, '按钮未禁用');
  return `disabled ✓ 标签「${badge}」`;
});

/* ---------- R2-T9 视频播放进度遥控（player 页 CDP） ---------- */
await test('R2-T9 video:control 进度遥控（±10s）', async () => {
  const mp3 = await evalJs(`window.engine.categories[0].tracks[0]`);
  await evalJs(`window.api.invoke('video:play', ${JSON.stringify(mp3)})`);
  await sleep(2500);
  const player = await attach((t) => t.url.includes('player.html'));
  const t1 = await player.evalJs(`document.getElementById('v').currentTime`);
  await evalJs(`window.api.invoke('video:control', 'fwd')`);
  await sleep(400);
  const t2 = await player.evalJs(`document.getElementById('v').currentTime`);
  await evalJs(`window.api.invoke('video:control', 'back')`);
  await sleep(400);
  const t3 = await player.evalJs(`document.getElementById('v').currentTime`);
  player.ws.close();
  await evalJs(`window.api.invoke('video:stop')`);
  await sleep(600);
  assert(t2 - t1 >= 9.5, `快进失效 ${t1}→${t2}`);
  assert(Math.abs(t3 - t1) < 1.5, `回退失效 ${t2}→${t3}`);
  return `进度 ${t1.toFixed(1)} → ${t2.toFixed(1)} → ${t3.toFixed(1)}s ✓`;
});

/* ---------- R2-T10 用户曲库热加载 ---------- */
await test('R2-T10 用户曲库热加载（丢文件→出现分类）', async () => {
  const cfg = JSON.parse(await evalJs(`window.api.invoke('app:getInit').then(d => JSON.stringify(d.config))`));
  const catDir = path.join(cfg.musicDir, '自动测试分类');
  fs.mkdirSync(catDir, { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), 'resources', 'music', '暖场', 'Bright Wish.mp3'), path.join(catDir, '测试曲目.mp3'));
  const scan1 = JSON.parse(await evalJs(`window.api.invoke('library:scan').then(d => JSON.stringify(d))`));
  const found = scan1.music.find((c) => c.category === '自动测试分类');
  assert(found && found.tracks.length === 1, '新分类未出现');
  await evalJs(`window.engine.setCategories(${JSON.stringify(scan1.music)})`);
  fs.rmSync(catDir, { recursive: true, force: true });
  const scan2 = JSON.parse(await evalJs(`window.api.invoke('library:scan').then(d => JSON.stringify(d))`));
  const gone = !scan2.music.find((c) => c.category === '自动测试分类');
  assert(gone, '清理后分类仍在');
  await evalJs(`window.engine.setCategories(${JSON.stringify(scan2.music)})`);
  return '新增「自动测试分类」1 首 → 清理消失 ✓';
});

/* ---------- R2-T11 快捷键改键 UI ---------- */
await test('R2-T11 改键：点击键帽→按 Ctrl+Alt+Y→生效落盘→还原', async () => {
  const original = 'Control+Alt+Left';
  await evalJs(`document.querySelector('#btnSettings').click()`);
  await sleep(150);
  await evalJs(`document.querySelector('.hk-key[data-action="prev"]').click()`); // 进入捕获
  const capturing = await evalJs(`document.querySelector('.hk-key[data-action="prev"]').classList.contains('capturing')`);
  assert(capturing === true, '未进入捕获态');
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, altKey: true, bubbles: true }))`);
  await sleep(900);
  const changed = await evalJs(`window.api.invoke('app:getInit').then(d => d.config.hotkeys.prev)`);
  assert(changed === 'Control+Alt+Y', '改键未生效: ' + changed);
  // 还原
  await evalJs(`document.querySelector('.hk-key[data-action="prev"]').click()`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true, altKey: true, bubbles: true }))`);
  await sleep(900);
  const restored = await evalJs(`window.api.invoke('app:getInit').then(d => d.config.hotkeys.prev)`);
  assert(restored === original, '还原失败: ' + restored);
  await evalJs(`document.querySelector('#btnCloseSettings').click()`);
  return `prev: ${original} → Control+Alt+Y → ${restored} ✓（全局注册同步换绑）`;
});

/* ---------- R2-T12 播放按钮 UI 联动 ---------- */
await test('R2-T12 面板播放按钮 ⏸/▶ 联动', async () => {
  await evalJs(`window.engine.pause()`); // 先归位到暂停，playCategory 才是"从头播放"语义
  await sleep(800);
  await evalJs(`window.engine.playCategory('暖场')`);
  await sleep(600);
  const t1 = await evalJs(`document.querySelector('#btnPlay').textContent`);
  await evalJs(`document.querySelector('#btnPlay').click()`);
  await sleep(800);
  const t2 = await evalJs(`document.querySelector('#btnPlay').textContent`);
  const p2 = await evalJs(`window.engine.playing`);
  await evalJs(`document.querySelector('#btnPlay').click()`);
  await sleep(800);
  const p3 = await evalJs(`window.engine.playing`);
  assert(t1.includes('⏸') && p2 === false && t2.includes('▶') && p3 === true, `⏸/▶ 联动异常 ${t1}/${t2}`);
  return '⏸ ↔ ▶ 与播放状态同步 ✓';
});

/* ---------- R2-T13 状态栏实时模式 ---------- */
await test('R2-T13 状态栏实时显示播放状态', async () => {
  const playingMode = await evalJs(`document.querySelector('#stMode').textContent`);
  assert(playingMode.includes('音乐'), '播放中状态栏: ' + playingMode);
  await evalJs(`window.engine.pause()`);
  await sleep(300);
  const idleMode = await evalJs(`document.querySelector('#stMode').textContent`);
  assert(idleMode.includes('空闲'), '暂停后状态栏: ' + idleMode);
  return `「音乐播放中」↔「空闲」✓`;
});

/* ---------- R2-T14 视频遥控条 ---------- */
await test('R2-T14 视频遥控条（面板遥控投影窗口）', async () => {
  const mp3 = await evalJs(`window.engine.categories[0].tracks[0]`);
  await evalJs(`window.api.invoke('video:play', ${JSON.stringify(mp3)})`);
  await sleep(2200);
  const visible = await evalJs(`document.querySelector('#videoRemote').style.display`);
  assert(visible === 'flex', '播放中遥控条未显示');
  const player = await attach((t) => t.url.includes('player.html'));
  await evalJs(`document.querySelector('#btnVToggle').click()`);
  await sleep(500);
  const paused = await player.evalJs(`document.getElementById('v').paused`);
  await evalJs(`document.querySelector('#btnVToggle').click()`);
  await sleep(500);
  const resumed = await player.evalJs(`document.getElementById('v').paused`);
  const v0 = await player.evalJs(`document.getElementById('v').volume`);
  await evalJs(`document.querySelector('#btnVVolDown').click()`); // 初始音量=1，用"−"验证
  await sleep(400);
  const v1 = await player.evalJs(`document.getElementById('v').volume`);
  player.ws.close();
  await evalJs(`window.api.invoke('video:stop')`);
  await sleep(600);
  const hidden = await evalJs(`document.querySelector('#videoRemote').style.display`);
  assert(paused === true && resumed === false, `暂停/继续失效 ${paused}/${resumed}`);
  assert(v0 - v1 >= 0.09, `音量遥控失效 ${v0}→${v1}`);
  assert(hidden === 'none', '停止后遥控条未隐藏');
  return '遥控条 显示→暂停→继续→音量+ →停止隐藏 ✓';
});

/* ---------- R2-T15 Esc 停止视频 ---------- */
await test('R2-T15 Esc 停止视频投放', async () => {
  const mp3 = await evalJs(`window.engine.categories[0].tracks[0]`);
  await evalJs(`window.api.invoke('video:play', ${JSON.stringify(mp3)})`);
  await sleep(2200);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(800);
  const stopped = await evalJs(`document.querySelector('#btnStopVideo').disabled`);
  assert(stopped === true, 'Esc 后视频未停止');
  return 'Esc → 视频停止 ✓';
});

/* ---------- R2-T16 界面密度切换 ---------- */
await test('R2-T16 界面密度切换（紧凑↔宽松）', async () => {
  await evalJs(`document.querySelector('#btnSettings').click()`);
  await evalJs(`(function(){ const s = document.querySelector('#setDensity'); s.value = 'roomy'; document.querySelector('#btnSaveSettings').click(); })()`);
  await sleep(700);
  const roomy = await evalJs(`document.body.classList.contains('roomy')`);
  assert(roomy === true, '宽松未生效');
  await evalJs(`document.querySelector('#btnSettings').click()`);
  await evalJs(`(function(){ const s = document.querySelector('#setDensity'); s.value = 'compact'; document.querySelector('#btnSaveSettings').click(); })()`);
  await sleep(700);
  const back = await evalJs(`document.body.classList.contains('roomy')`);
  assert(back === false, '还原紧凑失败');
  return '紧凑 → 宽松 → 紧凑 ✓';
});

/* ---------- R2-T17 播放进度条 ---------- */
await test('R2-T17 播放进度条显示与点击跳转', async () => {
  await evalJs(`window.engine.playCategory('暖场')`);
  await sleep(1200);
  const shown = await evalJs(`document.querySelector('#npProgress').style.display`);
  assert(shown === 'block', '进度条未显示');
  const t1 = await evalJs(`window.engine.channels[window.engine.active].el.currentTime`);
  await evalJs(`document.querySelector('#npProgress').click()`); // 无坐标点击 → 跳回开头
  await sleep(400);
  const t2 = await evalJs(`window.engine.channels[window.engine.active].el.currentTime`);
  assert(t2 < t1, `跳转失效 ${t1}→${t2}`);
  const time = await evalJs(`document.querySelector('#npTime').textContent`);
  assert(/\d+:\d{2} \/ \d+:\d{2}/.test(time), '时间格式异常: ' + time);
  return `显示 ✓ 回跳 ${t1.toFixed(1)}→${t2.toFixed(1)}s ✓ 时间「${time}」`;
});

/* ---------- R2-T18 音量/循环模式记忆 ---------- */
await test('R2-T18 音量与循环模式写入配置', async () => {
  await evalJs(`window.engine.setVolume(0.66)`);
  await evalJs(`window.engine.setLoopMode('single')`);
  await sleep(1300); // 等 800ms 防抖落盘
  const c = JSON.parse(await evalJs(`window.api.invoke('app:getInit').then(d => JSON.stringify(d.config))`));
  assert(Math.abs(c.volume - 0.66) < 0.001, '音量未记忆: ' + c.volume);
  assert(c.loopMode === 'single', '循环模式未记忆: ' + c.loopMode);
  await evalJs(`window.engine.setVolume(0.7)`);
  await evalJs(`window.engine.setLoopMode('list')`);
  await sleep(1300);
  return 'volume=0.66 loop=single 已落盘 → 已还原';
});

/* ---------- R2-T19 自定义分类：添加与删除 ---------- */
await test('R2-T19 自定义分类：添加→出现→删除→消失', async () => {
  // 添加（走面板「＋添加分类」卡片输入流）
  await evalJs(`document.querySelector('.cat-add').click()`);
  await sleep(200);
  await evalJs(`(function(){ const i = document.querySelector('.cat-input'); i.value = '课间律动'; })()`);
  await evalJs(`document.querySelectorAll('.cat-add .icon-btn')[0].click()`); // ✓ 确定
  await sleep(700);
  const names1 = await evalJs(`Array.from(document.querySelectorAll('.cat-card .cat-name')).map(e => e.textContent)`);
  assert(names1.includes('课间律动'), '添加后未出现: ' + names1.join(','));
  // 内置分类不应有删除按钮
  const builtinHasDel = await evalJs(`(function(){ const c = Array.from(document.querySelectorAll('.cat-card')).find(x => x.textContent.includes('暖场')); return !!c.querySelector('.cat-del'); })()`);
  assert(builtinHasDel === false, '内置分类不应显示删除按钮');
  // 删除（× → 确认弹层 → 确认）
  await evalJs(`(function(){ const c = Array.from(document.querySelectorAll('.cat-card')).find(x => x.textContent.includes('课间律动')); c.querySelector('.cat-del').click(); })()`);
  await sleep(200);
  const confirmShown = await evalJs(`!document.querySelector('#confirmOverlay').hidden`);
  assert(confirmShown, '确认弹层未出现');
  await evalJs(`document.querySelector('#btnConfirmOk').click()`);
  await sleep(900);
  const names2 = await evalJs(`Array.from(document.querySelectorAll('.cat-card .cat-name')).map(e => e.textContent)`);
  assert(!names2.includes('课间律动'), '删除后仍在: ' + names2.join(','));
  return '添加「课间律动」→ 内置无删除钮 ✓ → 删除确认 → 消失 ✓';
});

/* ---------- R2-T20 课堂计时器 ---------- */
await test('R2-T20 计时器：倒计时→tick 流→到时事件', async () => {
  const r = JSON.parse(await evalJs(`(async () => {
    let ticks = 0, finished = false;
    const off1 = window.api.on('timer:tick', () => ticks++);
    const fin = new Promise((res) => { const off2 = window.api.on('timer:finished', () => { off2(); finished = true; res(); }); setTimeout(() => res(), 9000); });
    window.api.invoke('timer:start', { mode: 'countdown', duration: 3000 });
    await fin;
    off1();
    return JSON.stringify({ ticks, finished });
  })()`));
  assert(r.ticks > 5, `tick 次数 ${r.ticks}`);
  assert(r.finished === true, '未收到 timer:finished');
  await evalJs(`window.api.invoke('timer:reset')`);
  return `ticks=${r.ticks} finished=${r.finished} ✓`;
});

/* ---------- R2-T21 PPT 翻页守卫 ---------- */
await test('R2-T21 PPT 翻页：未放映时优雅拒绝', async () => {
  const r = JSON.parse(await evalJs(`window.api.invoke('ppt:next').then(x => JSON.stringify(x)).catch(e => JSON.stringify({ ok: false, error: e.message }))`));
  assert(r.ok === false, '本机无Office不应成功: ' + JSON.stringify(r));
  return '未放映/无Office时优雅拒绝 ✓（真机放映中由 COM 驱动翻页）';
});

/* ---------- 收尾 ---------- */
await evalJs(`window.engine.pause()`);
const pass = results.filter((r) => r.ok).length;
console.log('\n===== 第二轮汇总 =====');
console.log(`通过 ${pass}/${results.length}`);
if (errors.length) console.log('运行期错误:', errors.slice(0, 5));
else console.log('运行期错误: 0');
fs.writeFileSync(path.join(ART, 'result-round2.json'), JSON.stringify({ results, errors }, null, 2));
process.exit(pass === results.length ? 0 : 1);