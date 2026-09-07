/* 欢迎屏回归验证 v3（20 背景 + 字体 + LOGO + 退出交互）
 * ① 布局回归：预览不遮挡、输入框可命中（"文字不能编辑"根因）
 * ② 多行输入/背景/样式/字体/LOGO → 预览实时跟随；20 缩略图全部加载
 * ③ 开屏 → 大屏内容/背景/字体/LOGO/位置/关闭钮正确；
 *    退出交互：①面板 Esc 兜底关屏 ②大屏右上角 ✕ 按钮点击关屏
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
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (bws.onopen = r));
let bid = 0; const bpending = new Map();
bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && bpending.has(m.id)) { bpending.get(m.id)(m); bpending.delete(m.id); } };
const bsend = (m, p = {}, session) => new Promise((res) => {
  const i = ++bid; bpending.set(i, res);
  bws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: session || undefined }));
});
async function sessionOf(urlPart) {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const t = list.find((x) => x.url.includes(urlPart));
  if (!t) return null;
  const att = await bsend('Target.attachToTarget', { targetId: t.id, flatten: true });
  return att.result.sessionId;
}
const sessions = new Map();
async function ev(page, expression) {
  if (!sessions.get(page)) {
    const s = await sessionOf(page);
    if (!s) throw new Error(`找不到页面 ${page}`);
    sessions.set(page, s);
  }
  const r = await bsend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessions.get(page));
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
  return r.result?.result?.value;
}

let origWelcome = 'null';
try {
  for (let i = 0; i < 40; i++) {
    const ok = await ev('index.html', `!!document.getElementById('btnWelcome')`).catch(() => false);
    if (ok) break;
    await sleep(500);
  }

  // 预置一个 LOGO：用现有 01.png 作 stand-in PNG（非透明但格式合法），写进 config
  // 先记下原 welcome 配置，测试结束在 finally 整体还原——这个脚本真实落盘 config.json，
  // 不还原的话文字/背景/字体/LOGO 都会残留在大屏上
  origWelcome = await ev('index.html', `window.api.invoke('config:save', {}).then((c) => JSON.stringify(c.welcome || null))`);
  const logoPath = path.join(process.cwd(), 'resources', 'welcome-bg', '01.png');
  await ev('index.html', `window.api.invoke('config:save', { welcome: { logo: { path: ${JSON.stringify(logoPath)}, pos: 'tr' } } })`);
  await sleep(200);

  await ev('index.html', `document.getElementById('btnWelcome').click()`);
  await sleep(800);
  check('弹窗打开', await ev('index.html', `!document.getElementById('welcomeOverlay').hidden`));

  // ① 布局回归
  const geo = await ev('index.html', `(() => {
    const r = (el) => el.getBoundingClientRect();
    const t = r(document.getElementById('wlText'));
    const p = r(document.getElementById('wlPreview'));
    const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    return { overlap: !(p.left >= t.right || p.right <= t.left || p.top >= t.bottom || p.bottom <= t.top),
             hitTag: hit && hit.tagName, position: getComputedStyle(document.getElementById('wlPreview')).position };
  })()`);
  check('预览不带 fixed（不遮挡输入区）', geo.position !== 'fixed' && geo.overlap === false, `${geo.position} overlap=${geo.overlap}`);
  check('输入框中心命中 TEXTAREA', geo.hitTag === 'TEXTAREA', geo.hitTag);

  // 数量
  const counts = await ev('index.html', `({
    bgs: document.querySelectorAll('#wlBgs .wl-bg-chip').length,
    styles: document.querySelectorAll('#wlStyles .wl-style-chip').length,
    fonts: document.querySelectorAll('#wlFonts .wl-style-chip').length,
    logoPos: document.querySelectorAll('#wlLogoPos .wl-style-chip').length,
  })`);
  check('20 背景 / 10 样式 / 10 字体 / 5 LOGO 位置', counts.bgs === 20 && counts.styles === 10 && counts.fonts === 10 && counts.logoPos === 5, JSON.stringify(counts));

  // ② 多行输入 → 预览跟随
  await ev('index.html', `(() => {
    const t = document.getElementById('wlText');
    t.value = '欢迎各位领导莅临指导\\n暨 2026 年教学研讨会';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  const afterText = await ev('index.html', `document.querySelector('#wlPreview .w-title').innerHTML`);
  check('预览文字跟随多行输入', afterText.includes('<br>') && afterText.includes('教学研讨会'), afterText.slice(0, 40));

  // 背景点选 #12（红金筑梦 svg）
  await ev('index.html', `document.querySelectorAll('#wlBgs .wl-bg-chip')[11].click()`);
  await sleep(300);
  const bgNow = await ev('index.html', `((document.querySelector('#wlPreview .w-bg')||{style:{}}).style.backgroundImage)||''`);
  check('预览背景切到 12.svg', bgNow.includes('12.svg'), bgNow.slice(-50));

  // 字体点选 #3 楷体
  await ev('index.html', `document.querySelectorAll('#wlFonts .wl-style-chip')[2].click()`);
  await sleep(300);
  const fontNow = await ev('index.html', `getComputedStyle(document.querySelector('#wlPreview .w-title')).fontFamily`);
  check('预览字体跟随（楷体）', /KaiTi|楷/i.test(fontNow), fontNow);

  // LOGO 已从 config 载入 → 预览里应有 .w-logo 且位置类为 tr（右上）
  const logoPrev = await ev('index.html', `(() => {
    const el = document.querySelector('#wlPreview .w-logo');
    return el ? { cls: el.className, src: el.src } : null;
  })()`);
  check('预览 LOGO 已渲染（tr 右上）', !!logoPrev && /w-logo-tr/.test(logoPrev.cls) && /01\.png/.test(logoPrev.src || ''), JSON.stringify(logoPrev));

  // 20 缩略图全部加载
  const imgs = await ev('index.html', `Array.from(document.querySelectorAll('#wlBgs img')).map((im) => im.complete && im.naturalWidth > 0)`);
  check('20 张背景缩略图全部加载成功', imgs.filter(Boolean).length === 20, `${imgs.filter(Boolean).length}/20`);

  // ③ 开屏
  await ev('index.html', `document.getElementById('btnWelcomeOpen').click()`);
  await sleep(1600);
  const led = await sessionOf('welcome.html');
  check('大屏窗已打开', !!led);
  if (led) {
    const ledContent = await ev('welcome.html', `(() => ({
      title: document.getElementById('title').textContent,
      bg: document.getElementById('bg').style.backgroundImage,
      font: getComputedStyle(document.getElementById('title')).fontFamily,
      hasLogo: !document.getElementById('logo').hidden,
      logoPos: document.getElementById('logo').className,
      hasClose: !!document.getElementById('wClose'),
    }))()`).catch((e) => ({ err: String(e) }));
    check('大屏文字内容', !!ledContent.title && ledContent.title.includes('教学研讨会'), ledContent.title);
    check('大屏使用 12.svg 背景', (ledContent.bg || '').includes('12.svg'), (ledContent.bg || '').slice(-60));
    check('大屏字体跟随（楷体）', /KaiTi|楷/i.test(ledContent.font || ''), ledContent.font);
    check('大屏 LOGO 已渲染（tr 右上）', !!ledContent.hasLogo && /w-logo-tr/.test(ledContent.logoPos || ''), JSON.stringify({ l: ledContent.hasLogo, c: ledContent.logoPos }));
    check('大屏右上角 ✕ 关闭钮存在', !!ledContent.hasClose);

    // 退出交互 ①：面板 Esc 兜底关屏（在 index.html 派发 Escape，不走可能卡住的大屏 Input 通道）
    await ev('index.html', `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(900);
    const closed1 = (await sessionOf('welcome.html')) === null;
    check('面板 Esc 兜底关闭大屏', closed1);
    sessions.delete('welcome.html'); // 大屏窗已销毁，清掉过期会话缓存
  }

  // 退出交互 ②：再开一次，验证大屏 ✕ 按钮点击关屏
  await ev('index.html', `document.getElementById('btnWelcomeOpen').click()`);
  await sleep(1500);
  const led2 = await sessionOf('welcome.html');
  check('二次开屏成功', !!led2);
  if (led2) {
    sessions.set('welcome.html', led2); // 绑定本次窗口的会话
    // 模拟鼠标移动显示 + 点击 ✕
    await ev('welcome.html', `(() => { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); document.getElementById('wClose').click(); })()`);
    await sleep(900);
    const closed2 = (await sessionOf('welcome.html')) === null;
    check('大屏 ✕ 按钮点击关屏', closed2);
    sessions.delete('welcome.html');
  }

  const btn = await ev('index.html', `document.getElementById('btnWelcomeClose').disabled`);
  check('面板关屏按钮复位（disabled）', btn === true, `disabled=${btn}`);
} catch (e) {
  check('执行异常', false, String(e));
} finally {
  // 还原测试前的整套 welcome 配置（文字/背景/样式/字体/LOGO），避免任何测试残留
  if (origWelcome && origWelcome !== 'null') {
    await ev('index.html', `window.api.invoke('config:save', { welcome: ${origWelcome} })`).catch(() => {});
  }
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 项通过`);
try { bws.close(); } catch {}
process.exit(pass === results.length ? 0 : 1);
