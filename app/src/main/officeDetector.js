const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isMac } = require('./platform');

let cached = null;

function keyExists(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

// macOS：WPS/Keynote 无可靠自动化接口，仅支持 Microsoft PowerPoint for Mac
function detectMac() {
  return new Promise((resolve) => {
    const candidates = [
      '/Applications/Microsoft PowerPoint.app',
      path.join(os.homedir(), 'Applications', 'Microsoft PowerPoint.app'),
    ];
    if (candidates.some((p) => fs.existsSync(p))) return resolve(true);
    // 兜底：Spotlight 按 bundle id 查（覆盖安装在非标准位置的情况）
    execFile('mdfind', ["kMDItemCFBundleIdentifier == 'com.microsoft.Powerpoint'"], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

// 探测本机可用的演示软件（Windows：COM 注册表，PowerPoint 优先 WPS 兜底；macOS：仅 PowerPoint）
async function detect(force = false) {
  if (cached && !force) return cached;
  if (isMac) {
    const pp = await detectMac();
    cached = {
      powerpoint: pp,
      wps: false,
      progId: pp ? 'PowerPoint.Mac' : null,
      officeName: pp ? 'PowerPoint' : null,
    };
    return cached;
  }
  const [pp, wps] = await Promise.all([
    keyExists('HKCR\\PowerPoint.Application'),
    keyExists('HKCR\\KWPP.Application'),
  ]);
  cached = {
    powerpoint: pp,
    wps,
    progId: pp ? 'PowerPoint.Application' : wps ? 'KWPP.Application' : null,
    officeName: pp ? 'PowerPoint' : wps ? 'WPS 演示' : null,
  };
  return cached;
}

module.exports = { detect };
