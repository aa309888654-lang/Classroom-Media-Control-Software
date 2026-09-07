/* 小天AIGC · CDP 端到端测试（零依赖，Node 内置 WebSocket）
 * 用法：先启动应用 `npx electron . --remote-debugging-port=9222`，再 `node scripts/cdp-test.mjs` */
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

/* ---------- 连接 CDP ---------- */
let targets = null;
for (let i = 0; i < 20; i++) {
  try { targets = await httpGetJson('http://127.0.0.1:9222/json'); break; } catch { await sleep(500); }
}
if (!targets) { console.error('FATAL: CDP 9222 连不上（应用未以调试模式启动）'); process.exit(2); }
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) { console.error('FATAL: 找不到主面板页面，现有: ' + targets.map((t) => t.url).join(' , ')); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('WS 连接失败')); });
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const jsErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown');
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('EVAL: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');

/* ---------- 等应用初始化 ---------- */
let ready = false;
for (let i = 0; i < 40; i++) {
  try { ready = await evalJs(`!!window.api && document.querySelectorAll('.cat-card').length > 0`); } catch { }
  if (ready) break;
  await sleep(500);
}
if (!ready) { console.error('FATAL: 应用初始化超时（曲库未渲染）'); process.exit(3); }

/* ---------- 工具 ---------- */
const results = [];
const test = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true, detail: detail || '' }); console.log('PASS |', name, '|', detail || ''); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message || e) }); console.log('FAIL |', name, '|', e.message || e); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const shot = async (name) => {
  // 窗口最小化/隐藏时合成器不出帧，截图会挂起——加超时兜底，不让辅助截图阻塞测试
  const r = await Promise.race([
    send('Page.captureScreenshot', { format: 'png' }),
    new Promise((res) => setTimeout(() => res(null), 6000)),
  ]);
  if (r && r.result?.data) fs.writeFileSync(path.join(ART, name), Buffer.from(r.result.data, 'base64'));
  else console.log('  (截图跳过：窗口不可见)');
};
const visOf = (sel) => evalJs(`JSON.stringify((() => { const el = document.querySelector('${sel}'); return { hidden: el.hidden, display: getComputedStyle(el).display }; })())`).then(JSON.parse);

await shot('01-初始主界面.png');

/* ---------- T1 设置弹窗启动隐藏（本次修复的回归用例） ---------- */
await test('T1 启动时设置弹窗隐藏', async () => {
  const v = await visOf('#settingsOverlay');
  assert(v.hidden === true && v.display === 'none', `overlay 可见 hidden=${v.hidden} display=${v.display}`);
  return 'hidden=true & display=none';
});

/* ---------- T2 分类曲库渲染 ---------- */
await test('T2 曲库分类渲染（暖场/轻松）', async () => {
  const names = await evalJs(`Array.from(document.querySelectorAll('.cat-card .cat-name')).map(e => e.textContent)`);
  assert(names.includes('暖场') && names.includes('轻松'), '分类缺失: ' + names.join(','));
  const counts = await evalJs(`Array.from(document.querySelectorAll('.cat-card .cat-count')).map(e => e.textContent)`);
  return names.join('+') + ' / ' + counts.join(' | ');
});

/* ---------- T3 Office 探测 ---------- */
let office = null;
await test('T3 Office 探测（COM）', async () => {
  office = JSON.parse(await evalJs(`window.api.invoke('office:detect', true).then(x => JSON.stringify(x))`));
  assert(office && typeof office.powerpoint === 'boolean', '返回异常');
  return `PowerPoint=${office.powerpoint} WPS=${office.wps} → ${office.officeName || '未检测到'}`;
});

/* ---------- T4 显示器信息 ---------- */
await test('T4 显示器信息渲染', async () => {
  const disp = await evalJs(`document.querySelector('#stDisp').textContent`);
  const info = await evalJs(`document.querySelector('#dispInfo').textContent`);
  assert(!disp.includes('检测中'), '状态栏仍显示检测中');
  return `${disp} ｜ ${info}`;
});

/* ---------- T5~T8 音乐引擎 ---------- */
await test('T5 点击「暖场」卡片开始播放', async () => {
  await evalJs(`document.querySelectorAll('.cat-card')[0].click()`);
  await sleep(800);
  const st = JSON.parse(await evalJs(`JSON.stringify({ p: window.engine.playing, cat: window.engine.category, tr: window.engine.currentTrackName(), ctx: window.engine.ctx && window.engine.ctx.state })`));
  assert(st.p === true, 'playing 未变 true');
  assert(st.cat === '暖场', '分类不对: ' + st.cat);
  assert(!!st.tr, '曲名为空');
  assert(st.ctx === 'running', 'AudioContext 未运行: ' + st.ctx);
  await shot('02-音乐播放中.png');
  return `${st.cat} · ${st.tr} · ctx=${st.ctx}`;
});

await test('T6 音频真实推进（currentTime 增长）', async () => {
  const t1 = await evalJs(`window.engine.channels[window.engine.active].el.currentTime`);
  await sleep(1000);
  const t2 = await evalJs(`window.engine.channels[window.engine.active].el.currentTime`);
  assert(t2 > t1, `currentTime 未增长 (${t1} → ${t2})`);
  return `${t1.toFixed(2)}s → ${t2.toFixed(2)}s`;
});

await test('T7 下一首（交叉淡入淡出状态机）', async () => {
  const i1 = await evalJs(`window.engine.idx`);
  await evalJs(`window.engine.next()`);
  await sleep(300);
  const i2 = await evalJs(`window.engine.idx`);
  assert(i2 === (i1 + 1) % 3, `索引异常 ${i1}→${i2}`);
  const tr = await evalJs(`window.engine.currentTrackName()`);
  return `曲目切换为: ${tr}`;
});

await test('T8 暂停/恢复（淡入淡出）', async () => {
  await evalJs(`window.engine.toggle()`);
  await sleep(750);
  const paused = await evalJs(`window.engine.playing`);
  assert(paused === false, '暂停失败');
  await evalJs(`window.engine.toggle()`);
  await sleep(750);
  const resumed = await evalJs(`window.engine.playing`);
  assert(resumed === true, '恢复失败');
  return '暂停→恢复 正常';
});

await test('T9 音量控制联动', async () => {
  await evalJs(`window.engine.setVolume(0.5)`);
  const shown = await evalJs(`document.querySelector('#volVal').textContent`);
  assert(shown === '50%', '滑条显示: ' + shown);
  await evalJs(`window.engine.setVolume(${await evalJs(`window.api.invoke('app:getInit').then(d => d.config.volume)`)})`);
  return '滑条联动 50% ✓ 已恢复默认';
});

await test('T10 循环模式切换', async () => {
  await evalJs(`document.querySelector('#btnLoop').click()`);
  const m1 = await evalJs(`window.engine.loopMode`);
  await evalJs(`document.querySelector('#btnLoop').click()`);
  const m2 = await evalJs(`window.engine.loopMode`);
  assert(m1 === 'single' && m2 === 'list', `loop: ${m1}/${m2}`);
  return '单曲 ↔ 列表';
});

await test('T11 切换到「轻松」分类（交叉淡出旧曲）', async () => {
  await evalJs(`window.engine.playCategory('轻松')`);
  await sleep(2600); // 越过 2s 交叉淡化窗口
  const cat = await evalJs(`window.engine.category`);
  const tr = await evalJs(`window.engine.currentTrackName()`);
  assert(cat === '轻松', '分类未切: ' + cat);
  assert(await evalJs(`window.engine.playing`) === true, '切歌后未在播放');
  return `轻松 · ${tr}`;
});

/* ---------- T11b 全局快捷键（系统级 SendKeys ^%m = Ctrl+Alt+M） ---------- */
await test('T11b 全局快捷键 Ctrl+Alt+M 暂停/恢复', async () => {
  const before = await evalJs(`window.engine.playing`);
  execSync(`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys('^%m')"`);
  await sleep(900);
  const after = await evalJs(`window.engine.playing`);
  assert(after !== before, `状态未翻转 (${before}→${after})`);
  execSync(`powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys('^%m')"`);
  await sleep(900);
  const back = await evalJs(`window.engine.playing`);
  assert(back === before, '未恢复');
  return `playing ${before}→${after}→${back}`;
});

/* ---------- T12 设置弹窗开/关（回归核心） ---------- */
await test('T12 设置弹窗打开后可关闭', async () => {
  await evalJs(`document.querySelector('#btnSettings').click()`);
  await sleep(150);
  const open = await visOf('#settingsOverlay');
  assert(open.display !== 'none', '打开失败');
  await shot('03-设置打开.png');
  await evalJs(`document.querySelector('#btnCloseSettings').click()`);
  await sleep(150);
  const closed = await visOf('#settingsOverlay');
  assert(closed.hidden === true && closed.display === 'none', '关闭失败: ' + JSON.stringify(closed));
  await shot('04-设置关闭后.png');
  return '打开→关闭 ✓';
});

/* ---------- T13 设置保存回路 ---------- */
await test('T13 设置保存生效（切歌淡入淡出 3s）', async () => {
  await evalJs(`document.querySelector('#btnSettings').click()`);
  await evalJs(`(function(){ const s = document.querySelector('#setCrossfade'); s.value = '3'; document.querySelector('#btnSaveSettings').click(); })()`);
  await sleep(800);
  const cf = await evalJs(`window.engine.crossfade`);
  assert(cf === 3, 'crossfade=' + cf);
  // 还原为 2
  await evalJs(`document.querySelector('#btnSettings').click()`);
  await evalJs(`(function(){ const s = document.querySelector('#setCrossfade'); s.value = '2'; document.querySelector('#btnSaveSettings').click(); })()`);
  await sleep(800);
  const cf2 = await evalJs(`window.engine.crossfade`);
  assert(cf2 === 2, '还原失败: ' + cf2);
  return '保存 3s 生效 → 已还原 2s';
});

/* ---------- T14 PPT 状态探测（真实 PowerShell 调用，安全不启动放映） ---------- */
await test('T14 PPT 状态探测（ppt:status）', async () => {
  const r = JSON.parse(await evalJs(`window.api.invoke('ppt:status').then(x => JSON.stringify(x))`));
  assert(r.psOk === true, 'PowerShell 通路异常: ' + JSON.stringify(r));
  assert(typeof r.presenting === 'boolean' && 'file' in r && 'progId' in r, '返回字段不完整: ' + JSON.stringify(r));
  return `presenting=${r.presenting} psOk=${r.psOk}（PowerShell COM 通路正常）`;
});

/* ---------- T15 视频窗口管道（用 MP3 验证窗口/IPC/停止，不长时间发声） ---------- */
await test('T15 视频窗口播放与停止', async () => {
  const r = JSON.parse(await evalJs(`(async () => {
    const file = window.engine.categories[0].tracks[0];
    const sub = new Promise((res) => {
      const off = window.api.on('video:state', (v) => { if (v && v.playing) { off(); res(v); } });
      setTimeout(() => res(null), 6000);
    });
    await window.api.invoke('video:play', file);
    const st = await sub;
    await window.api.invoke('video:stop');
    const after = new Promise((res) => {
      const off = window.api.on('video:state', (v) => { if (!v.playing) { off(); res(v); } });
      setTimeout(() => res(null), 4000);
    });
    const st2 = await after;
    return JSON.stringify({ played: !!st, stopped: !!st2 && !st2.playing });
  })()`));
  assert(r.played === true, '视频窗口未报告 playing（5s 超时）');
  assert(r.stopped === true, '停止失败');
  return '窗口创建→播放事件→停止 全链路 ✓';
});

/* ---------- T16 置顶按钮 ---------- */
await test('T16 窗口置顶开关', async () => {
  const on = await evalJs(`document.querySelector('#btnPin').click() || true`);
  await sleep(150);
  const c1 = await evalJs(`document.querySelector('#btnPin').classList.contains('on')`);
  await evalJs(`document.querySelector('#btnPin').click()`);
  await sleep(150);
  const c2 = await evalJs(`document.querySelector('#btnPin').classList.contains('on')`);
  assert(c1 === true && c2 === false, `on=${c1} off=${c2}`);
  return '开→关 ✓';
});

/* ---------- T17 运行期 JS 错误清点 ---------- */
await test('T17 运行期无未捕获 JS 错误', async () => {
  assert(jsErrors.length === 0, `${jsErrors.length} 个异常: ` + jsErrors.slice(0, 3).join(' || '));
  return '0 个未捕获异常';
});

/* ---------- 汇总 ---------- */
await evalJs(`window.engine.pause()`); // 收尾静音
const pass = results.filter((r) => r.ok).length;
console.log('\n===== 测试汇总 =====');
console.log(`通过 ${pass}/${results.length}`);
console.log(JSON.stringify({ office, consoleErrors, jsErrors }, null, 2));
fs.writeFileSync(path.join(ART, 'result.json'), JSON.stringify({ results, office, consoleErrors, jsErrors }, null, 2));
process.exit(pass === results.length ? 0 : 1);
