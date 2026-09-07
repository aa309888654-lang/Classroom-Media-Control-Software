/* 快捷键简化验证：默认迁移、静音、注册校验、动作映射、文案 */
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + n + (d ? ' | ' + d : '')); };

const list = await getJson('http://127.0.0.1:9238/json/list');
const page = list.find((t) => t.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval');
  return r.result?.result?.value;
};
await sleep(1500);

/* 1. 默认快捷键迁移生效 */
const hkMap = await ev(`(async () => { const d = await window.api.invoke('app:getInit'); return d.config.hotkeys; })()`);
check('快捷键已迁移为新方案', hkMap.playPause === 'F2' && hkMap.mute === 'F4' && hkMap.volDown === 'F5' && hkMap.volUp === 'F6' && hkMap.openFull === 'Backquote' && hkMap.exitFull === 'Escape', JSON.stringify(hkMap));

/* 2. 静音切换（gain: 0.7 → 0 → 0.7） */
const m1 = await ev(`(() => { const e = window.engine; e.ensureCtx(); const before = e.master.gain.value; const m = e.toggleMute(); return { before: Math.round(before * 100) / 100, muted: m }; })()`);
check('F4 静音打钩生效', m1.muted === true && m1.before > 0, JSON.stringify(m1));
const m2 = await ev(`(() => { const e = window.engine; const m = e.toggleMute(); return { muted: m, saved: e.savedVolume }; })()`);
check('再次 F4 解除静音', m2.muted === false && m2.saved > 0, JSON.stringify(m2));

/* 3. 注册校验：无脑字母拒绝；F 键 / 具名键 / 组合键放行 */
const vM = await ev(`window.api.invoke('hotkey:remap', { action: 'playPause', accelerator: 'M' })`);
const vF = await ev(`window.api.invoke('hotkey:remap', { action: 'playPause', accelerator: 'F9' })`);
const vComb = await ev(`window.api.invoke('hotkey:remap', { action: 'playPause', accelerator: 'Control+Alt+Z' })`);
const vBack = await ev(`window.api.invoke('hotkey:remap', { action: 'playPause', accelerator: 'Backquote' })`);
check('拒绝字母单键', vM.ok === false);
check('放行 F 键', vF.ok === true);
check('放行组合键', vComb.ok === true);
check('放行 ~ 反引号', vBack.ok === true);
await ev(`window.api.invoke('hotkey:remap', { action: 'playPause', accelerator: 'F2' })`); // 归位

/* 4. 面板文案已更新（音乐/投屏/计时三处） */
const hint = await ev(`(() => { const t = [...document.querySelectorAll('.hint')].map(e => e.textContent).join(' '); return t; })()`);
check('文案为新键位', hint.includes('F2 播放') && hint.includes('Ctrl+F1 放映') && hint.includes('F7 启停'), hint.slice(0, 100));

const pass = results.every(Boolean);
console.log(pass ? 'HK_PASS' : 'HK_FAIL');
process.exit(pass ? 0 : 1);
