const { screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

// 一键把 Windows 切到扩展显示模式
function extendMode() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'DisplaySwitch.exe');
  if (fs.existsSync(exe)) {
    spawn(exe, ['/extend'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  return false;
}

module.exports = { listDisplays, projectionDisplay, extendMode };
