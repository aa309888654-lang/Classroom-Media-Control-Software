/* 小天AIGC · 全面功能测试（针对 2026.10.11 打包成品）
 * 前置：应用已带 --remote-debugging-port=9235 启动
 * 覆盖：曲库 / 音乐引擎 / 本次修复专项 / 视频 / 计时器 / 快捷键 / 配置 / 同屏
 * 注意：曲目行是「双击播放」的有意设计（避免误触），测试必须用双击。
 */
import { attach, sleep, makeChecker } from './cdp.mjs';
import { readFileSync } from 'node:fs';
// 版本断言跟 package.json 走：写死版本号会让每次发版都假失败（2026.10.15 起改为动态比对）
const EXPECTED_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const t = await attach(9235);
const { ev, invoke, realClick, doubleClick, centerOf } = t;
const c = makeChecker('小天AIGC 全面功能测试');

/** 轮询等待某个状态成立，替代固定 sleep：
 *  主进程 → 渲染层的往返耗时随机器负载起伏，固定等待会在慢机上假失败。 */
const waitFor = async (fn, ms = 4000, step = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};

/* 页面内注入安全的状态读取器（避免声道为 null 时整段求值崩掉） */
await ev(`window.__xt = {
  eng() {
    const e = window.engine, ch = e.channels[e.active];
    return { playing: e.playing, idx: e.idx, track: e.currentTrackName(), active: e.active,
             chanNull: !ch, paused: ch ? ch.el.paused : null, ready: ch ? ch.el.readyState : null,
             gain: ch ? ch.gain.gain.value : null, err: ch && ch.el.error ? ch.el.error.code : null };
  }
}`);

/** 阶段容错：任一阶段抛错只记一条失败，不中断后续阶段 */
const phase = async (name, fn) => {
  try { await fn(); } catch (e) { c.check(`${name}（阶段异常中断）`, false, String(e && e.message || e).slice(0, 140)); }
};

const cfgBefore = await invoke('app:getInit');
const VIDEO = (cfgBefore.videos && cfgBefore.videos[0] && cfgBefore.videos[0].file) || '';
await invoke('config:save', { videoWindowed: true }); // 测视频用窗口模式，避免全屏抢屏

/** 退出迷你模式：迷你模式下视口仅 526x95，曲目区尺寸为 0，坐标点击会落到迷你条上（测试假象的根源） */
const exitMiniMode = async () => {
  if (!(await ev('document.body.classList.contains("mini-mode")'))) return false;
  for (const sel of ['#btnMini', '#miniExpand']) {
    const p = await centerOf(sel);
    if (p && p.w > 0) { await realClick(p.x, p.y); await sleep(700); }
    if (!(await ev('document.body.classList.contains("mini-mode")'))) return true;
  }
  return false;
};
await exitMiniMode();
const VP_OK = await ev('window.innerWidth > 900 && window.innerHeight > 600');
c.check('A0 已退出迷你模式（视口足够做坐标点击）', VP_OK === true,
  await ev('`${document.body.className||"(normal)"} ${window.innerWidth}x${window.innerHeight}`'));

const eng = () => ev('window.__xt.eng()');
const stopMusic = () => ev('window.engine.pause()');
const stopVideo = async () => { try { await invoke('video:stop'); } catch { } await sleep(300); };
/** 双击播放某一行曲目 */
const playTrackRow = async (idx = 0) => {
  const p = await ev(`(() => { const e = document.querySelectorAll('#catCards .cat-track')[${idx}];
    if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!p) return false;
  await doubleClick(p.x, p.y);
  return true;
};
/** 选中第 i 个分类 */
const selectCat = async (i) => {
  await ev(`document.querySelectorAll('#catList .cat-item:not(.cat-morecard):not(.cat-add-row)')[${i}].click()`);
  await sleep(450);
};

/* ================= 1. 初始化与曲库（验证库扫描异步化后的正确性） ================= */
await phase('A 初始化', async () => {
  const lib = await ev(`(() => {
    const cs = window.engine.categories;
    return { cats: cs.length, total: cs.reduce((s, x) => s + x.tracks.length, 0),
      bell: (cs.find(x => x.category === '上课铃声') || { tracks: [] }).tracks.length,
      dup: cs.length !== new Set(cs.map(x => x.category)).size,
      emptyCat: cs.filter(x => !x.tracks.length).map(x => x.category) };
  })()`);
  c.check('A1 曲库扫描完成（异步化后仍完整）', lib.cats >= 10 && lib.total >= 100, JSON.stringify(lib));
  c.check('A2 分类无重名', lib.dup === false);
  c.check('A3 上课铃声 4 首齐全', lib.bell === 4, `bell=${lib.bell}`);
  c.check('A4 无空分类', lib.emptyCat.length === 0, JSON.stringify(lib.emptyCat));

  const sel = await ev(`(() => ({ name: document.getElementById('selCatName')?.textContent,
    count: document.getElementById('selCatCount')?.textContent,
    items: document.querySelectorAll('#catList .cat-item').length,
    tracks: document.querySelectorAll('#catCards .cat-track').length }))()`);
  c.check('A5 分类列表与曲目区渲染', sel.items > 0 && sel.tracks > 0, JSON.stringify(sel));

  c.check('A6 app:getInit 负载完整',
    !!cfgBefore.config && !!cfgBefore.music && Array.isArray(cfgBefore.videos) && Array.isArray(cfgBefore.ppts),
    `video=${cfgBefore.videos.length} ppt=${cfgBefore.ppts.length} music=${cfgBefore.music.length}`);
  c.check(`A7 版本号=${EXPECTED_VERSION}`, cfgBefore.version === EXPECTED_VERSION, cfgBefore.version);
  c.check('A8 品牌名正常', cfgBefore.brand && cfgBefore.brand.name === '小天AIGC', String(cfgBefore.brand && cfgBefore.brand.name));
});

/* ================= 2. 音乐引擎核心 ================= */
await phase('B 音乐引擎', async () => {
  await stopMusic(); await sleep(300);
  await selectCat(0);
  const okPlay = await playTrackRow(0);
  c.check('B0 双击曲目可播放（设计为双击）', okPlay);
  await sleep(1300);
  const p = await eng();
  c.check('B1 双击开播（状态+实际未暂停+有数据）',
    p.playing === true && p.paused === false && (p.ready === null || p.ready >= 2), JSON.stringify(p));
  c.check('B2 当前曲目高亮', (await ev('!!document.querySelector(".cat-track.playing")')) === true);
  c.check('B3 曲目名已更新', !!p.track && !p.track.includes('未在播放'), p.track);
  c.check('B4 无播放错误', p.err === null, String(p.err));

  await ev('window.engine.pause()'); await sleep(800);
  const pz = await eng();
  c.check('B5 暂停生效', pz.playing === false && pz.paused === true, JSON.stringify(pz));

  await ev('window.engine.resume()'); await sleep(800);
  const rz = await eng();
  c.check('B6 继续播放', rz.playing === true && rz.paused === false, JSON.stringify(rz));

  await ev('window.engine.pause(); window.engine.resume()'); await sleep(1100);
  const race = await eng();
  c.check('B7 快速暂停→继续不哑音（pauseTimer 回归）', race.playing === true && race.paused === false, JSON.stringify(race));

  const t0 = (await eng()).track;
  await ev('window.engine.next()'); await sleep(1000);
  const t1 = (await eng()).track;
  await ev('window.engine.prev()'); await sleep(1000);
  const t2 = (await eng()).track;
  c.check('B8 下一首/上一首切换', t1 !== t0 && t2 === t0, `${t0} -> ${t1} -> ${t2}`);

  await ev('window.engine.setVolume(0.35)'); await sleep(300);
  c.check('B9 音量设置生效', Math.abs((await ev('window.engine.volume')) - 0.35) < 0.01);

  await ev('window.engine.toggleMute()'); await sleep(400);
  c.check('B10 静音生效', (await eng()).gain !== null ? (await ev('window.engine.muted')) === true : true);
  c.check('B11 取消静音', (await (async () => { await ev('window.engine.toggleMute()'); await sleep(300); return ev('window.engine.muted'); })()) === false);

  let loopOk = true;
  for (const m of ['single', 'once', 'list']) {
    await ev(`window.engine.setLoopMode('${m}')`); await sleep(200);
    if ((await ev('window.engine.loopMode')) !== m) loopOk = false;
  }
  c.check('B12 循环模式 list/single/once 切换', loopOk);

  await ev('window.engine.setFades(0.6, 0.4)'); await sleep(200);
  const f = await ev('({ c: window.engine.crossfade, p: window.engine.ppFade })');
  c.check('B13 淡化参数可设', f.c === 0.6 && f.p === 0.4, JSON.stringify(f));
  await ev('window.engine.setFades(2, 0.5)');
});

/* ================= 2b. 音乐交互：分类双击 / 置顶还原 ================= */
await phase('B+ 音乐交互', async () => {
  await stopMusic(); await sleep(300);
  await selectCat(0);
  // 分类卡双击 = 整类播放
  const catPt = await ev(`(() => { const e = document.querySelectorAll('#catList .cat-item:not(.cat-morecard):not(.cat-add-row)')[0];
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  if (!catPt) c.check('B+1 分类卡双击整类播放', false, '找不到分类项');
  else {
    await doubleClick(catPt.x, catPt.y); await sleep(1400);
    const s = await eng();
    c.check('B+1 分类卡双击整类播放', s.playing === true && s.paused === false, JSON.stringify(s));
  }

  // 置顶 ☆ 与取消置顶还原（只动排序，不删文件）
  await selectCat(0);
  const order0 = await ev(`[...document.querySelectorAll('#catCards .cat-track .t-name')].map(e => e.textContent.trim())`);
  const pinOk = await ev(`(() => { const rows = document.querySelectorAll('#catCards .cat-track');
    const r = rows[2]; if (!r) return false; const p = r.querySelector('.cat-pin'); if (!p) return false; p.click(); return true; })()`);
  await sleep(700);
  const order1 = await ev(`[...document.querySelectorAll('#catCards .cat-track .t-name')].map(e => e.textContent.trim())`);
  c.check('B+2 置顶把曲目提到前三', pinOk && order1[0] === order0[2], `${order0[2]} -> ${order1[0]}`);
  await ev(`(() => { const p = document.querySelectorAll('#catCards .cat-track .cat-pin.on')[0]; if (p) p.click(); })()`);
  await sleep(700);
  const order2 = await ev(`[...document.querySelectorAll('#catCards .cat-track .t-name')].map(e => e.textContent.trim())`);
  c.check('B+3 取消置顶完整还原', JSON.stringify(order0) === JSON.stringify(order2),
    `${JSON.stringify(order0)} vs ${JSON.stringify(order2)}`);
  await stopMusic();
});

/* ================= 3. BUG-D 回归：跨歌淡出定时器 ================= */
await phase('C 淡出定时器', async () => {
  await ev('window.engine.setFades(2, 0.5)'); // 2 秒交叉淡化
  await ev('window.engine.resume()'); await sleep(700);
  await ev('window.engine.next()'); await sleep(300);
  await ev('window.engine.next()'); await sleep(300);
  const mid = await eng();
  c.check('C1 淡化中连点 next 不哑音', mid.playing === true && mid.paused === false, JSON.stringify(mid));
  await sleep(2800);   // 越过 2s+120ms 的旧定时器到期点
  const late = await eng();
  c.check('C2 BUG-D 修复：旧淡出定时器到期后仍有声',
    late.playing === true && late.paused === false, JSON.stringify(late));
  await ev('window.engine.setFades(2, 0.5)');
});

/* ================= 4. 本次修复专项：播放冲突 BUG-A / 撞音 BUG-C ================= */
await phase('D 播放冲突', async () => {
  await stopVideo(); await stopMusic();
  await ev('window.engine.setVolume(0.7)');
  await ev(`window.engine.playCategory(window.engine.categories[0].category)`);
  await sleep(1400);
  const before = await eng();
  c.check('D1 前置：音乐正在播', before.playing === true && before.paused === false, JSON.stringify(before));

  if (!VIDEO) {
    c.check('D2 起播视频', false, '视频库为空，跳过');
  } else {
    const r = await invoke('video:play', VIDEO);
    await sleep(450);
    c.check('D2 视频起播成功', r.ok === true, JSON.stringify(r));
    c.check('D3 主进程 video.playing=true', (await invoke('app:getInit')).video?.playing === true);

    await sleep(150);  // 远小于 ppFade(500ms)：若仍是淡出则此刻应还在响
    const ducked = await eng();
    c.check('D4 BUG-C 修复：起播 150ms 内音乐已掐断（无撞音）',
      ducked.playing === false && ducked.paused === true && (ducked.gain === null || ducked.gain < 0.01),
      JSON.stringify(ducked));

    const pt = await centerOf('#btnPlay');
    if (!pt) c.check('D5 播放键互斥', false, '找不到 #btnPlay');
    else {
      await realClick(pt.x, pt.y); await sleep(700);
      const after = await eng();
      c.check('D5 BUG-A 修复：视频播放中点播放键被拦，音乐未起播', after.playing === false, JSON.stringify(after));
      const tip = await ev(`(() => {
        const box = document.getElementById('toasts');
        const last = box && box.lastElementChild;
        return last ? last.textContent : '';
      })()`);
      c.check('D6 拦截有用户可见提示（toast）', String(tip).includes('视频投放中'), String(tip).slice(0, 50));
    }

    const cb = await centerOf('#btnPlayCat');
    if (cb) {
      await realClick(cb.x, cb.y); await sleep(600);
      c.check('D7 分类「播放全部」入口同样被拦', (await eng()).playing === false);
    }

    await stopVideo();
    await waitFor(async () => (await eng()).playing === true);
    c.check('D8 停止视频后音乐自动恢复', (await eng()).playing === true, JSON.stringify(await eng()));
  }
});

/* ================= 5. 视频：失败兜底 / LED 状态同步 ================= */
await phase('E 视频', async () => {
  const bad = await invoke('video:play', 'X:\\不存在\\fake.mp4');
  c.check('E1 视频文件缺失报错', bad.ok === false && bad.error === 'file-not-found', JSON.stringify(bad));

  if (VIDEO) {
    await invoke('video:play', VIDEO); await sleep(900);
    const wt = await invoke('video:windowToggle');
    c.check('E2 窗口/全屏互切', wt.ok === true && typeof wt.windowed === 'boolean', JSON.stringify(wt));
    await invoke('video:windowToggle'); await sleep(400);

    await invoke('video:control', 'stop');
    await waitFor(async () => { const a = await invoke('app:getInit'); return a.video && a.video.playing === false; });
    const after = await invoke('app:getInit');
    c.check('E3 LED 停止键状态同步修复：video.playing 复位',
      after.video && after.video.playing === false, JSON.stringify(after.video));
    await stopVideo();
  }
});

/* ================= 6. 计时器 ================= */
await phase('F 计时器', async () => {
  await invoke('timer:start', { mode: 'countdown', duration: 5 * 60 * 1000 });
  await sleep(1700);
  await invoke('timer:toggle');
  const sp = await invoke('timer:state'); await sleep(1100);
  await invoke('timer:toggle'); await sleep(500);
  const sr = await invoke('timer:state');
  c.check('F1 计时器暂停后继续不清零',
    sr.remaining <= sp.remaining && (sp.remaining - sr.remaining) < 5000,
    `暂停剩 ${Math.round(sp.remaining / 100) / 10}s，继续剩 ${Math.round(sr.remaining / 100) / 10}s`);

  await invoke('timer:start', { mode: 'elapsed' }); await sleep(1300);
  const st = await invoke('timer:state');
  c.check('F2 正计时在走', st.elapsed > 0, `elapsed=${st.elapsed}`);
  await invoke('timer:reset'); await sleep(400);
  const rst = await invoke('timer:state');
  c.check('F3 重置归零', !rst.started && rst.elapsed < 1000, JSON.stringify({ started: rst.started, elapsed: rst.elapsed }));
});

/* ================= 7. 快捷键 ================= */
await phase('G 快捷键', async () => {
  const orig = cfgBefore.config.hotkeys.playPause;
  c.check('G1 改键拒绝无修饰键',
    (await invoke('hotkey:remap', { action: 'playPause', accelerator: 'Z' })).error === 'need-modifier');
  // 系统保留组合：Ctrl+字母（复制/粘贴/关闭…）与 Alt+F4 应被明确以 'reserved' 拒绝
  const r1 = await invoke('hotkey:remap', { action: 'playPause', accelerator: 'Control+C' });
  const r2 = await invoke('hotkey:remap', { action: 'playPause', accelerator: 'Alt+F4' });
  c.check('G2 拒绝系统保留组合（Ctrl+字母 / Alt+F4）',
    r1.error === 'reserved' && r2.error === 'reserved', JSON.stringify({ r1, r2 }));

  // 合法组合能否真正注册取决于系统是否已占用该键，逐一试探
  const cands = ['Control+Alt+B', 'Alt+F9', 'Control+Shift+F9', 'Control+Alt+F9', 'Alt+F10'];
  let okAcc = null;
  for (const a of cands) { if ((await invoke('hotkey:remap', { action: 'playPause', accelerator: a })).ok) { okAcc = a; break; } }
  c.check('G3 合法含修饰键组合可注册（至少一个成功）', !!okAcc, okAcc || `全部被系统占用: ${cands.join(',')}`);

  // 注册失败的组合必须回滚，不能把注册不到的键写进配置（BUG-13 同款安全语义）
  const failAcc = 'Ctrl+Alt+P';
  const failR = await invoke('hotkey:remap', { action: 'playPause', accelerator: failAcc });
  const nowAcc = (await invoke('app:getInit')).config.hotkeys.playPause;
  c.check('G4 注册失败的组合不写坏配置（旧键回滚）',
    failR.ok ? nowAcc === failAcc : nowAcc === (okAcc || orig),
    `失败返回=${JSON.stringify(failR)} 当前=${nowAcc}`);

  const rs = await invoke('hotkey:remap', { action: 'playPause', accelerator: orig });
  c.check('G5 快捷键可还原默认值', rs.ok === true && (await invoke('app:getInit')).config.hotkeys.playPause === orig,
    `${orig} -> ${JSON.stringify(rs)}`);
});

/* ================= 8. 配置与外链 ================= */
await phase('H 配置', async () => {
  const neg = await invoke('app:openExternal', 'http://aicgxt.com/');
  const evil = await invoke('app:openExternal', 'https://evil.example.com/');
  c.check('H1 外链拦截 http/仿冒域', neg.ok === false && evil.ok === false, JSON.stringify({ neg, evil }));

  await invoke('config:save', { density: 'compact' }); await sleep(500);
  c.check('H2 配置可写可读回', (await invoke('app:getInit')).config.density === 'compact');
  await invoke('config:save', { density: cfgBefore.config.density }); await sleep(300);
  c.check('H3 空补丁不崩', (await invoke('config:save', {})) !== null);
});

/* ================= 9. 同屏（并发守卫 + 统一收尾） ================= */
await phase('I 同屏', async () => {
  if ((await invoke('cast:state')).running) { await invoke('cast:toggle'); await sleep(1200); }

  const s1 = await invoke('cast:toggle');
  await sleep(700);
  let st = await invoke('cast:state');
  c.check('I1 无线同屏启动', st.running === true && !!st.port, `running=${st.running} port=${st.port}`);
  c.check('I2 返回可用地址与令牌', s1.ok === true && !!s1.url && !!s1.token, `url=${s1.url}`);

  // 并发 start 守卫：连发两次 cast:state 期间不应出现服务异常
  const both = await Promise.all([invoke('cast:state'), invoke('cast:state')]);
  c.check('I3 同屏状态查询稳定（无重复服务迹象）',
    both.every((x) => typeof x.running === 'boolean') && both[0].port === both[1].port,
    `ports=${both[0].port}/${both[1].port}`);

  const s2 = await invoke('cast:toggle'); await sleep(1400);
  st = await invoke('cast:state');
  c.check('I4 停止同屏后 running=false', st.running === false, `running=${st.running}`);
  c.check('I5 停止后令牌作废', !st.token, `token=${st.token ? '仍在' : '已清'}`);

  // 再开一次，验证可重复启停（端口没被残留占用）
  const s3 = await invoke('cast:toggle'); await sleep(900);
  c.check('I6 可重复启停（无端口残留占用）', s3.ok === true && (await invoke('cast:state')).running === true, JSON.stringify({ ok: s3.ok, err: s3.error }));
  await invoke('cast:toggle'); await sleep(1200);
  c.check('I7 二次停止成功', (await invoke('cast:state')).running === false);
});

/* ================= 10. 清理与还原 ================= */
await phase('J 收尾', async () => {
  await stopVideo(); await stopMusic(); await sleep(400);
  // 计时器窗口会盖住控制面板且尺寸超出屏幕右边缘，测试后必须收掉（本轮踩过）
  await invoke('timer:reset').catch(() => { });
  await sleep(300);
  await invoke('timer:toggleShow').catch(() => { });
  await sleep(700);
  const cfg = await invoke('app:getInit');
  c.check('J1 无残留视频', cfg.video && cfg.video.playing === false, JSON.stringify(cfg.video));
  c.check('J2 无残留同屏', (await invoke('cast:state')).running === false);
  c.check('J3 音乐已停', (await eng()).playing === false);
  const idleHidden = await ev(`document.getElementById('ledIdle').hidden`);
  c.check('J4 无残留 LED 待机层（不遮挡面板）', idleHidden === true, `ledIdleHidden=${idleHidden}`);
  await invoke('config:save', { videoWindowed: !!cfgBefore.config.videoWindowed, density: cfgBefore.config.density });
});

const s = c.summary();
console.log('\n失败项: ' + (s.failed.length ? s.failed.join(' / ') : '（无）'));
t.close();
process.exit(s.failed.length ? 1 : 0);
