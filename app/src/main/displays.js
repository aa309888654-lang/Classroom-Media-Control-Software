const { screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    index: i,
    id: d.id,
    isPrimary: d.id === primaryId,
    isProjection: d.id !== primaryId,
    bounds: d.bounds,
    label: `${d.bounds.width}×${d.bounds.height}${d.id === primaryId ? ' · 主屏(教师)' : ' · 副屏(投影)'}`,
  }));
}

// 第二显示器（投影屏）；单屏则回退主屏
function projectionDisplay() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return others[0] || primary;
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

module.exports = { listDisplays, projectionDisplay, extendMode };