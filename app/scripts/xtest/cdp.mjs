/* CDP 测试工具：连接已启动的应用渲染进程（默认 127.0.0.1:9235）
 * 用法：node scripts/xtest/cdp.mjs  —— 导出 ev/invoke/sleep/realClick 等 */
import http from 'node:http';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

/** 连上主窗口的渲染页，返回一组操作原语 */
export async function attach(port = 9235, urlMatch = 'index.html') {
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const page = targets.find((t) => t.type === 'page' && t.url.includes(urlMatch))
    || targets.find((t) => t.type === 'page');
  if (!page) throw new Error('NO_PAGE: 没找到渲染页');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  /** 在页面里求值（awaitPromise），异常直接抛出 */
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
    return r.result?.result?.value;
  };
  /** 调 IPC */
  const invoke = (ch, pl) => ev(`window.api.invoke(${JSON.stringify(ch)}, ${JSON.stringify(pl === undefined ? null : pl)})`);
  /** 真实鼠标点击（走 Chromium 输入管线，能触发 pointer capture 之类 JS click 不触发的东西） */
  const realClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  /** 真实双击。曲目行是「双击才播放」的有意设计（避免误触），单击不生效 */
  const doubleClick = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
  };
  /** 取某元素的中心坐标 */
  const centerOf = (sel) => ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  const close = () => { try { ws.close(); } catch { } };

  await send('Page.enable');
  await send('Runtime.enable');
  return { ev, invoke, send, realClick, doubleClick, centerOf, close, page };
}

/** 断言收集器 */
export function makeChecker(title) {
  const rows = [];
  console.log(`\n===== ${title} =====`);
  const check = (name, ok, detail) => {
    rows.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
  };
  const summary = () => {
    const pass = rows.filter((r) => r.ok).length;
    console.log(`\n----- ${title}: ${pass}/${rows.length} 通过 -----`);
    return { pass, total: rows.length, failed: rows.filter((r) => !r.ok).map((r) => r.name) };
  };
  return { check, summary, rows };
}
