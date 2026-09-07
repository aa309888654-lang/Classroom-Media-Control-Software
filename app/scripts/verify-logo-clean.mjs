/* 一次性验证：右上角「多一张图」修复确认
 * 1. 直接按当前 config（logo 已清空，bg 18 / style 10 / font 3 是用户自己的设置）开屏
 * 2. 断言大屏 LOGO 元素仍然 hidden（右上角不应再有 01.png 缩略图）
 * 3. 截图留档 → test-artifacts/62-welcome-no-logo.png
 * 4. 在大屏页派发 Esc，验证大屏Esc 监听经 show()+focus() 后真实生效（关屏）
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
  const att = await send('Target.attachToTarget', { targetId: t.id, flatten: true });
  return att.result.sessionId;
}
const evalIn = (sid, expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid).then((r) => r.result?.result?.value);

try {
  // 等主面板就绪
  let mainSid = null;
  for (let i = 0; i < 40 && !mainSid; i++) {
    mainSid = await attach('index.html').catch(() => null);
    if (!mainSid) await sleep(500);
  }
  check('主面板目标存在', !!mainSid);

  // 开屏：不传参数，完全走 config——这正是用户当时看到的画面
  await evalIn(mainSid, `window.api.invoke('welcome:toggle', {})`);
  await sleep(1800);
  const ledSid = await attach('welcome.html');
  check('大屏窗已打开', !!ledSid);

  if (ledSid) {
    const led = await evalIn(ledSid, `(() => ({
      logoHidden: document.getElementById('logo').hidden,
      logoSrc: document.getElementById('logo').getAttribute('src') || '',
      title: document.getElementById('title').textContent,
      uiShownAtOpen: !document.body.classList.contains('w-ui'),
    }))()`);
    check('大屏 LOGO 元素保持 hidden', led.logoHidden === true && !led.logoSrc.includes('01.png'), JSON.stringify(led && { logoHidden: led.logoHidden, logoSrc: led.logoSrc }));
    check('大屏文字为用户配置', led.title.includes('教学研讨会'), led.title);

    const shot = await send('Page.captureScreenshot', { format: 'png' }, ledSid);
    const out = path.join(process.cwd(), 'test-artifacts', '62-welcome-no-logo.png');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`✔ 截图存档 ${out}`);

    // ✕ 关闭钮：开屏时应先短暂可见（2.6 秒提示），闲置后隐藏
    const uiLater = await evalIn(ledSid, `new Promise((r) => setTimeout(() => r(document.body.classList.contains('w-ui')), 3200))`);
    check('开屏 2.6 秒提示后 ✕ 已自动隐藏', uiLater === false, `w-ui=${uiLater}`);

    const uiAgain = await evalIn(ledSid, `(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: innerWidth - 10, clientY: 10 }));
      const vis = document.body.classList.contains('w-ui');
      return vis;
    })()`);
    check('鼠标靠近右上角 ✕ 重新显现', uiAgain === true, `w-ui=${uiAgain}`);

    // 大屏 Esc 直接关屏（show()+focus() 之后键盘事件进得来）
    await evalIn(ledSid, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(900);
    check('大屏 Esc 关屏', (await findTarget('welcome.html')) === undefined);
  }
} catch (e) {
  check('执行异常', false, String(e));
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 项通过`);
try { ws.close(); } catch {}
process.exit(pass === results.length ? 0 : 1);
