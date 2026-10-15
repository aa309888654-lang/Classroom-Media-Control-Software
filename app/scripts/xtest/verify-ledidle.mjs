/* 回归验证：确认 LED 待机画面不再越权盖住控制面板
 * 复现本次事故的触发条件：非 LED 模式下给 <video> 一个无效 src → Chromium 抛 error(code 4)
 */
import { attach, sleep, makeChecker } from './cdp.mjs';

const t = await attach(9235, 'index.html');
const { ev } = t;
const c = makeChecker('LED 待机画面越权回归');

const snapshot = () => ev(`(() => {
  const idle = document.getElementById('ledIdle');
  const vid = document.getElementById('ledVideo');
  return {
    ledMode: document.body.classList.contains('led-mode'),
    ledIdleHidden: idle.hidden,
    ledVideoError: vid.error ? vid.error.code : null,
    centerEl: (() => { const e = document.elementFromPoint(window.innerWidth/2, window.innerHeight/2);
      return e ? (String(e.className).slice(0, 24) || e.tagName) : null; })(),
  };
})()`);

c.check('R0 起始：非 LED 模式且待机画面隐藏', (await snapshot()).ledIdleHidden === true,
  JSON.stringify(await snapshot()));

// 场景 1：复现事故——非 LED 模式下给 video 设无效 src（等价于切换模式时的清理动作）
await ev(`(() => {
  const v = document.getElementById('ledVideo');
  v.src = 'file:///' + encodeURI('C:/not-a-real-media-file.txt');
  return true;
})()`);
await sleep(1200);
const s1 = await snapshot();
c.check('R1 无效 src 触发 error 后，待机画面仍隐藏（本次回归的核心）', s1.ledIdleHidden === true,
  JSON.stringify(s1));
c.check('R2 面板中心区域是正常内容而非 LED 待机层', s1.centerEl !== null && !String(s1.centerEl).includes('led'),
  `centerEl=${s1.centerEl}`);

// 场景 2：src 置空（applyDisplayMode 的清理动作）
await ev(`(() => { document.getElementById('ledVideo').src = ''; return true; })()`);
await sleep(1200);
const s2 = await snapshot();
c.check('R3 src 置空触发 error 后，待机画面仍隐藏', s2.ledIdleHidden === true, JSON.stringify(s2));

// 场景 3：真正的播放失败在 LED 模式下仍应正常兜底（守卫不能把功能改坏）
await ev(`(() => {
  document.getElementById('ledVideo').src = 'file:///' + encodeURI('C:/not-a-real-media-file.txt');
  document.body.classList.add('led-mode');       // 模拟确实在 LED 投放中
  return true;
})()`);
await sleep(1200);
const s3 = await snapshot();
c.check('R4 LED 模式下真失败仍会显示待机（兜底功能没被守卫改坏）', s3.ledMode && s3.ledIdleHidden === false,
  JSON.stringify(s3));

// 复原
await ev(`(() => { document.body.classList.remove('led-mode');
  document.getElementById('ledIdle').hidden = true;
  document.getElementById('ledVideo').src = ''; return true; })()`);
await sleep(600);
const s4 = await snapshot();
c.check('R5 复原后回到正常控制台状态', s4.ledMode === false && s4.ledIdleHidden === true, JSON.stringify(s4));

const s = c.summary();
console.log('\n失败项: ' + (s.failed.length ? s.failed.join(' / ') : '（无）'));
t.close();
process.exit(s.failed.length ? 1 : 0);
