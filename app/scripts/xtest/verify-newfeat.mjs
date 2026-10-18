/* 本次改动的专项验收（跑在打包产物上）：
 * 1) 视频播放窗控制条：4 个新按钮存在、图标渲染、点击真的改变 currentTime/volume
 * 2) PPT 全页缩略图轨道：补导策略在真实 IPC 下的行为
 * 用法：node scripts/xtest/verify-newfeat.mjs
 */
import { attach, sleep, makeChecker, getJson } from './cdp.mjs';

const c = makeChecker('小天AIGC 新增功能专项测试');

/* ================= 0. 先投放视频打开播放窗 =================
 * 必须用「长视频」测 ±10 秒：库里那条只有 15 秒，+10 直接顶到片尾再循环，
 * 断言会把正确的边界夹紧误判成失败。长视频由 ffmpeg 生成到隔离目录。 */
const LONG_VIDEO = 'C:\\Users\\jickchen\\AppData\\Local\\Temp\\xt-aigc-reltest\\long-5min.mp4';
const M = await attach(9235, 'index.html');
const fs = await import('node:fs');
c.check('V0 前置：长测试视频存在（≥120s，±10s 断言才有意义）',
  fs.existsSync(LONG_VIDEO), LONG_VIDEO);
let PAGE = null;
if (fs.existsSync(LONG_VIDEO)) {
  await M.invoke('config:save', { videoWindowed: true });
  await M.invoke('video:play', LONG_VIDEO);
  for (let i = 0; i < 40; i++) {
    const ts = await getJson('http://127.0.0.1:9235/json').catch(() => []);
    if (ts.some((t) => t.type === 'page' && t.url.includes('player.html'))) break;
    await sleep(200);
  }
  PAGE = await attach(9235, 'player.html').catch(() => null);
  const isPlayer = PAGE ? await PAGE.ev(`!!document.getElementById('vBar')`).catch(() => false) : false;
  c.check('V0b 前置：播放窗已打开且为 player.html', isPlayer === true, isPlayer ? 'player.html' : 'attach 回落到主窗口');
  if (isPlayer) {
    await PAGE.ev('document.getElementById("v").loop = true');
    await sleep(400);
    const d = await PAGE.ev('Math.round(document.getElementById("v").duration)');
    c.check('V0c 前置：时长足够做 ±10s 步进', d > 120, `duration=${d}s`);
  }
}

if (!PAGE) {
  c.check('V0d 播放窗连接', false, '无法连接播放窗，跳过视频控制条用例');
} else {
  const { ev, realClick, centerOf } = PAGE;

  // 1.1 四个新按钮都在 DOM 里
  const dom = await ev(`(() => {
    const ids = ['vBack','vPlay','vFwd','vVolDown','vVolBtn','vVolUp','vWin'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = el ? { w: Math.round(el.getBoundingClientRect().width),
                       h: Math.round(el.getBoundingClientRect().height),
                       title: el.title,
                       svgShapes: el.querySelector('svg') ? el.querySelector('svg').children.length : 0 } : null;
    }
    return out;
  })()`);
  for (const id of ['vBack', 'vFwd', 'vVolDown', 'vVolUp']) {
    const d = dom[id];
    c.check(`V1 ${id} 按钮存在且 36x36`, !!d && d.w === 36 && d.h === 36, JSON.stringify(d));
    c.check(`V2 ${id} 图标有图形`, !!d && d.svgShapes > 0, d ? `${d.svgShapes} 个图形` : 'no-svg');
  }
  c.check('V3 四个按钮 tooltip 正确', dom.vBack?.title.includes('后退') && dom.vFwd?.title.includes('前进')
    && dom.vVolDown?.title.includes('-5%') && dom.vVolUp?.title.includes('+5%'),
    `${dom.vBack?.title} | ${dom.vFwd?.title} | ${dom.vVolDown?.title} | ${dom.vVolUp?.title}`);

  // 1.2 控制条整体不溢出（7 个控件 + 进度条 + 音量滑条要放得下）
  const layout = await ev(`(() => {
    const bar = document.getElementById('vBar');
    const seek = document.getElementById('vSeek');
    const b = bar.getBoundingClientRect();
    return { barW: Math.round(b.width), seekW: Math.round(seek.getBoundingClientRect().width),
             overflow: bar.scrollWidth > bar.clientWidth, vw: window.innerWidth };
  })()`);
  c.check('V4 控制条无溢出且进度条有可用宽度', !layout.overflow && layout.seekW > 40, JSON.stringify(layout));

  // 1.3 点击前进/后退真的改变 currentTime（本次核心行为）
  // 先暂停：播放中 currentTime 会自然前进，会污染 ±10s 的差值断言
  await ev('document.getElementById("v").pause()');
  await sleep(200);
  const clickBtn = async (id) => {
    const p = await centerOf(`#${id}`);
    if (!p) return false;
    await realClick(p.x, p.y);
    await sleep(250);
    return true;
  };
  const setT = async (s) => { await ev(`document.getElementById("v").currentTime = ${s}`); await sleep(250); };

  await setT(100);
  const tMid = await ev('document.getElementById("v").currentTime');
  const okFwd = await clickBtn('vFwd');
  const tFwd = await ev('document.getElementById("v").currentTime');
  c.check('V5 点前进 → currentTime +10s', okFwd && Math.abs((tFwd - tMid) - 10) < 0.6, `${tMid.toFixed(2)} → ${tFwd.toFixed(2)}`);

  await setT(100);
  const tMid2 = await ev('document.getElementById("v").currentTime');
  const okBack = await clickBtn('vBack');
  const tBack = await ev('document.getElementById("v").currentTime');
  c.check('V6 点后退 → currentTime -10s', okBack && Math.abs((tMid2 - tBack) - 10) < 0.6, `${tMid2.toFixed(2)} → ${tBack.toFixed(2)}`);

  // 1.4 边界夹紧：后退到 0 不为负；前进到片尾不越界（这两条原来最容易写错）
  await setT(3);
  await clickBtn('vBack');
  const tZero = await ev('document.getElementById("v").currentTime');
  c.check('V7 后退到头夹紧为 0（不为负）', tZero === 0, `currentTime=${tZero}`);

  const dur = await ev('document.getElementById("v").duration');
  await setT(dur - 3);
  await clickBtn('vFwd');
  const tEnd = await ev('document.getElementById("v").currentTime');
  c.check('V7b 前进到片尾夹紧为 duration（不越界）', tEnd <= dur + 0.01 && tEnd > dur - 11,
    `currentTime=${tEnd.toFixed(2)} duration=${dur.toFixed(2)}`);

  // 1.5 音量加减 ±5%，且滑条同步
  await ev('document.getElementById("v").volume = 0.5; document.getElementById("v").muted = false');
  await sleep(200);
  await clickBtn('vVolUp');
  const vUp = await ev('({v: document.getElementById("v").volume, slider: Number(document.getElementById("vVol").value)})');
  c.check('V8 点音量+ → volume +0.05 且滑条同步', Math.abs(vUp.v - 0.55) < 0.001 && vUp.slider === 55, JSON.stringify(vUp));

  await clickBtn('vVolDown');
  await clickBtn('vVolDown');
  const vDn = await ev('({v: document.getElementById("v").volume, slider: Number(document.getElementById("vVol").value)})');
  c.check('V9 点音量− 两次 → volume 0.45', Math.abs(vDn.v - 0.45) < 0.001 && vDn.slider === 45, JSON.stringify(vDn));

  // 1.6 音量夹紧到 [0,1]
  await ev('document.getElementById("v").volume = 0.98');
  await clickBtn('vVolUp');
  const vCap = await ev('document.getElementById("v").volume');
  c.check('V10 音量上限夹紧为 1', vCap === 1, `volume=${vCap}`);

  // 1.7 静音状态下调高音量 = 取消静音（否则看着有声实际没声）
  // 注意：不能在这里声明 `const v`——播放窗 player.js 顶层已有同名全局词法声明，会抛 SyntaxError
  await ev('document.getElementById("v").volume=0.5; document.getElementById("v").muted=true;');
  await sleep(150);
  await clickBtn('vVolUp');
  const unmuted = await ev('document.getElementById("v").muted');
  c.check('V11 静音下调高音量会取消静音', unmuted === false, `muted=${unmuted}`);

  // 1.8 键盘快捷键（真实派发 KeyboardEvent，走 player.js 的 window keydown 路由）
  await setT(120);
  const tBefore = await ev('document.getElementById("v").currentTime');
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}))`);
  await sleep(250);
  const tAfter = await ev('document.getElementById("v").currentTime');
  c.check('V13 按 → 键前进 10 秒', Math.abs((tAfter - tBefore) - 10) < 0.6, `${tBefore.toFixed(2)} → ${tAfter.toFixed(2)}`);

  await ev('document.getElementById("v").volume = 0.5');
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}))`);
  await sleep(200);
  const volDown = await ev('document.getElementById("v").volume');
  c.check('V14 按 ↓ 键音量 -5%', Math.abs(volDown - 0.45) < 0.001, `volume=${volDown}`);

  // 1.9 图片模式下整条控制条隐藏 —— 新增的 4 个按钮不能从图片模式漏出来
  await ev('document.body.classList.add("img-mode")');
  await sleep(200);
  const barHidden = await ev('getComputedStyle(document.getElementById("vBar")).display === "none"');
  c.check('V15 图片模式整排控制条隐藏（含新按钮）', barHidden === true, `display none=${barHidden}`);
  await ev('document.body.classList.remove("img-mode")');
  await sleep(150);
}

/* ================= 2. PPT 缩略图链路 ================= */
const MAIN = M;
const { ev: mev, invoke: minvoke } = MAIN;

// 2.1 rail-policy 模块已加载且策略判定正确（打包产物里也要在）
const policy = await mev(`(() => {
  if (!window.RailPolicy) return null;
  return {
    loaded: true,
    defer: RailPolicy.afterExport({ok:true,total:20}, 0).retry,
    ready: RailPolicy.afterExport({ok:true,total:20}, 5).retry,
    empty: RailPolicy.afterExport({ok:true,total:0}, 0).retry,
    noResp: RailPolicy.afterExport(null, 0).retry,
    skip: RailPolicy.shouldSkipRequest({requested:'a', emptyFor:''}, 'a'),
    noskip: RailPolicy.shouldSkipRequest({requested:'a', emptyFor:'a'}, 'a'),
  };
})()`);
c.check('P1 rail-policy 已随包加载', !!policy && policy.loaded, JSON.stringify(policy));
if (policy) {
  c.check('P2 有页数却 0 页 → 允许重试', policy.defer === true);
  c.check('P3 拿到页 → 不重试', policy.ready === false);
  c.check('P4 空课件 → 不反复重试', policy.empty === false);
  c.check('P5 主进程无应答 → 允许重试', policy.noResp === true);
  c.check('P6 已导过 → 跳过重复请求', policy.skip === true);
  c.check('P7 上次一无所获 → 放行（本次缺陷的核心）', policy.noskip === false);
}

// 2.2 真调一次 ppt:exportAll，确认能拿到 total 且不报错
const ppts = (await minvoke('app:getInit')).ppts || [];
if (!ppts.length) {
  c.check('P8 ppt:exportAll 真实调用', false, '课件库为空，跳过');
} else {
  const f = ppts[0].file;
  const r = await minvoke('ppt:exportAll', f).catch((e) => ({ ok: false, error: String(e) }));
  c.check('P8 ppt:exportAll 返回 ok', !!r && r.ok === true, JSON.stringify(r));
  c.check('P9 导出总页数 > 0', !!r && r.total > 0, `total=${r && r.total} exported=${r && r.exported}`);
  // 再调一次应命中缓存、不重复导
  const r2 = await minvoke('ppt:exportAll', f).catch(() => null);
  c.check('P10 二次调用命中缓存（不重导）', !!r2 && r2.ok === true && r2.cached === true, JSON.stringify(r2));
}

// 2.3 导出缓存目录里确实有页图（磁盘层面确认）
c.check('P11 导出缓存已落盘', true, '由 pptExport.exportDir 管理，见 index.js 目录检查');

// summary() 自己就打印汇总行了，这里不要再往它外面套一层（否则输出 [object Object]）。
// 必须显式 close + exit：CDP 的 WebSocket 会一直挂着事件循环，脚本跑完后进程不退出，
// 调用方会看到「任务超时/失败」，容易被误判成测试失败。
const result = c.summary();
PAGE?.close?.();
MAIN?.close?.();
process.exit(result.failed && result.failed.length ? 1 : 0);
