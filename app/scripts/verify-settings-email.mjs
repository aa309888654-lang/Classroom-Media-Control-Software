/* 一次性验证：设置弹窗「赞助我们」下方新增联系邮箱（点击复制）
 * 1. 重载主面板（拿到新 DOM/JS/CSS）
 * 2. 打开设置 → 断言联系邮箱元素存在且在赞助按钮下方
 * 3. 点击邮箱 → 断言剪贴板写入 + toast 弹出
 * 4. 截图留档 → test-artifacts/63-settings-email.png
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
const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
const main = list.find((t) => t.url.includes('index.html'));
if (!main) { console.error('主面板不存在'); process.exit(1); }
const sid = (await send('Target.attachToTarget', { targetId: main.id, flatten: true })).result.sessionId;
const ev = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid)
  .then((r) => {
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
    return r.result?.result?.value;
  });

try {
  await send('Page.enable', {}, sid);
  await send('Page.reload', {}, sid);
  await sleep(2500);
  for (let i = 0; i < 30; i++) {
    if (await ev(`!!document.getElementById('btnSettings')`).catch(() => false)) break;
    await sleep(400);
  }

  // 打开设置
  await ev(`document.getElementById('btnSettings').click()`);
  await sleep(700);
  check('设置弹窗打开', await ev(`!document.getElementById('settingsOverlay').hidden`));

  const email = await ev(`(() => {
    const el = document.getElementById('contactEmail');
    if (!el) return null;
    const sponsorBtn = document.getElementById('btnSponsor');
    const row = el.closest('.form-row');
    const sponsorRow = sponsorBtn && sponsorBtn.closest('.form-row');
    return {
      text: el.textContent,
      belowSponsor: !!(row && sponsorRow && sponsorRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
      label: row && row.querySelector('label') && row.querySelector('label').textContent,
    };
  })()`);
  check('联系邮箱元素存在', !!email && email.text === 'aa309888654@gmail.com', email && email.text);
  check('邮箱行在「赞助我们」下方', !!(email && email.belowSponsor), email && `label=${email.label}`);

  // 点击复制：渲染进程 sandbox 下无剪贴板权限，复制走主进程 app:copyText IPC；
  // OS 级剪贴板内容由外部 PowerShell Get-Clipboard 复核（见调用方）
  const direct = await ev(`window.api.invoke('app:copyText', 'probe@example.com')`).catch(() => null);
  check('app:copyText IPC 可用', !!(direct && direct.ok), JSON.stringify(direct));
  await ev(`document.getElementById('contactEmail').click()`);
  await sleep(700);
  const toastText = await ev(`(() => { const t = document.querySelector('.toast'); return t ? t.textContent : ''; })()`);
  check('点击后弹出「已复制」toast', /已复制/.test(toastText || ''), toastText);

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  fs.writeFileSync(path.join(process.cwd(), 'test-artifacts', '63-settings-email.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('✔ 截图存档 test-artifacts/63-settings-email.png');

  await ev(`document.getElementById('btnCloseSettings').click()`);
} catch (e) {
  check('执行异常', false, String(e));
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 项通过`);
try { ws.close(); } catch {}
process.exit(pass === results.length ? 0 : 1);
