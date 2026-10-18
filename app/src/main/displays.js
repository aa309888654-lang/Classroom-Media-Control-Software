const { screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const config = require('./config');

// ---------- 投影屏「智能识别」 ----------
// 规则（先精确后模糊）：
// 1) 用户在面板上手动选过（display.projectionId）且那块屏还在线 → 听用户的
// 2) 否则在非主屏里优先挑「非内置屏」（笔记本自带屏 internal=true 不可能是投影），
//    多块外接屏时取分辨率面积最大的那块（投影仪/电视通常最大）
// 3) 一块副屏都没有 → 回退主屏（单屏 LED 场景）
function projectionDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (all.length <= 1) return primary;
  const pref = Number(config.get().display && config.get().display.projectionId) || 0;
  if (pref) {
    const hit = all.find((d) => d.id === pref);
    if (hit) return hit;
  }
  const others = all.filter((d) => d.id !== primary.id);
  const external = others.filter((d) => d.internal === false); // Electron 老版本无 internal，退化为「取面积最大」
  const pool = external.length ? external : others;
  return pool.slice().sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height))[0] || primary;
}

// 供主进程下发给 PowerShell：把放映窗口搬到目标屏时需要「点 ↔ 像素」比例校准，
// 而校准必须以「某块屏的像素矩形」为基准，所以整块列表都传过去
//
// 【混合 DPI 关键】Electron 的 bounds 是 DIP，虚拟桌面里的 x/y 偏移按「主屏的缩放」换算，
// 而 w/h 按「该屏自己的缩放」换算。于是 4K@150% 与 2K@100% 两块屏的 DIP 尺寸会完全相同
// （都是 2560×1440），仅凭 DIP 无法区分、也无法和 PowerPoint 的坐标对齐。
// 所以这里额外给出物理像素矩形 px*：x/y 乘主屏缩放，w/h 乘各自缩放。
function displayTable() {
  const primary = screen.getPrimaryDisplay();
  const pScale = primary.scaleFactor || 1;
  return screen.getAllDisplays().map((d) => {
    const s = d.scaleFactor || 1;
    return {
      id: d.id,
      x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height,
      pxX: Math.round(d.bounds.x * pScale), pxY: Math.round(d.bounds.y * pScale),
      pxW: Math.round(d.bounds.width * s), pxH: Math.round(d.bounds.height * s),
      scale: s,
      internal: !!d.internal,
      primary: d.id === primary.id,
    };
  });
}

function targetIndex() {
  const d = projectionDisplay();
  return displayTable().findIndex((x) => x.id === d.id);
}

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  const targetId = projectionDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    index: i,
    id: d.id,
    isPrimary: d.id === primaryId,
    isProjection: d.id === targetId, // 「投影屏」= 当前智能识别/用户指定的投屏目标
    internal: !!d.internal, // 笔记本自带屏：智能识别时会被排除
    bounds: d.bounds,
    scaleFactor: d.scaleFactor || 1,
    label: `${d.bounds.width}×${d.bounds.height}${d.id === primaryId ? ' · 主屏(教师)' : (d.id === targetId ? ' · 投影屏' : ' · 副屏')}`,
  }));
}

// 有没有能投的外接屏（内置屏不算：一块屏时“投到投影屏”没有意义）
function hasExternal() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().some((d) => d.id !== primary.id && d.internal === false);
}

// 一键把 Windows 切到扩展显示模式；带结果校验：
// 已是双屏 → 直接返回（already）；DisplaySwitch 切换是异步的，轮询显示器数量确认是否生效。
// 单屏机器大多是因为投影线/HDMI 未被识别，明确返回失败让调用方提示，而不是静默假成功。
async function extendMode({ verifyMs = 3000 } = {}) {
  const exe = 'C:\\Windows\\System32\\DisplaySwitch.exe';
  if (!fs.existsSync(exe)) return { ok: false, error: 'no-displayswitch', count: screen.getAllDisplays().length };
  if (screen.getAllDisplays().length >= 2) return { ok: true, already: true, count: screen.getAllDisplays().length };
  await new Promise((resolve) => execFile(exe, ['/extend'], { windowsHide: true }, () => resolve()));
  const deadline = Date.now() + verifyMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (screen.getAllDisplays().length >= 2) return { ok: true, count: screen.getAllDisplays().length };
  }
  return { ok: false, error: 'no-second-display', count: screen.getAllDisplays().length };
}

module.exports = { listDisplays, projectionDisplay, extendMode, displayTable, targetIndex, hasExternal };
