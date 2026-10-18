import { attach, sleep, makeChecker } from './cdp.mjs';
const c = makeChecker('PPT 缩略图链路复测（清理残留 PowerPoint 后）');
const M = await attach(9235, 'index.html');
const ppts = (await M.invoke('app:getInit')).ppts || [];
c.check('前置：课件库有课件', ppts.length > 0, `${ppts.length} 个`);
if (ppts.length) {
  const f = ppts[0].file;
  console.log('  课件:', f);
  const r = await M.invoke('ppt:exportAll', f).catch((e) => ({ ok: false, error: String(e) }));
  c.check('ppt:exportAll 返回 ok', !!r && r.ok === true, JSON.stringify(r));
  c.check('导出总页数 > 0', !!r && r.total > 0, `total=${r && r.total} exported=${r && r.exported}`);
  const r2 = await M.invoke('ppt:exportAll', f).catch(() => null);
  c.check('二次调用命中缓存（不重导）', !!r2 && r2.ok === true && r2.cached === true, JSON.stringify(r2));

  // 渲染层：走真实 UI 路径选中课件（直接点芯片），轨道应出现缩略图
  await M.invoke('ppt:present', f).catch(() => {}); // 先确保主进程知道当前课件
  await M.invoke('ppt:exit').catch(() => {});
  await sleep(1200);
  await M.invoke('ppt:exportAll', f).catch(() => {});
  await sleep(2500);
  const rail = await M.ev(`(() => {
    const wrap = document.getElementById('pptRailWrap');
    const rail = document.getElementById('pptRail');
    return { wrapHidden: wrap ? wrap.hidden : null,
             items: rail ? rail.querySelectorAll('.ppt-rail-item').length : 0,
             info: (document.getElementById('pptRailInfo')||{}).textContent || '',
             curThumbHidden: document.getElementById('pptCurThumb') ? document.getElementById('pptCurThumb').hidden : null };
  })()`);
  c.check('缩略图轨道已显示', rail.wrapHidden === false, JSON.stringify(rail));
  c.check('轨道里有页面缩略图', rail.items > 0, `${rail.items} 张 · ${rail.info}`);
}
// summary() 自行打印汇总；显式 close + exit，否则 CDP 的 WebSocket 会吊住事件循环，
// 脚本跑完进程不退出，调用方只看到「超时/失败」，很容易被误判成测试没通过。
const result = c.summary();
M?.close?.();
process.exit(result.failed && result.failed.length ? 1 : 0);
