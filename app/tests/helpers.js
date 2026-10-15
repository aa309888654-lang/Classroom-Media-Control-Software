/* 测试通用工具：electron 桩 + spawn 桩（每个测试文件在独立进程运行，互不影响） */
const Module = require('module');
const origLoad = Module._load;
const os = require('os');
const path = require('path');
const fs = require('fs');

let installed = null;

// 在 require 被测模块之前调用：把 electron 换成最小桩
function installElectron(opts = {}) {
  const userData = opts.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'xt-test-userdata-'));
  const appPath = opts.appPath || path.join(__dirname, '..');
  const fakeApp = {
    isPackaged: false,
    getAppPath: () => appPath,
    getPath: (k) => (k === 'userData' ? userData : path.join(userData, 'tmp-' + k)),
    getName: () => 'xiaotian-test',
    getVersion: () => '0.0.0-test',
    on: () => { }, once: () => { },
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    quit: () => { }, exit: () => { },
    setLoginItemSettings: () => { },
    setAppUserModelId: () => { },
    commandLine: { appendSwitch: () => { } },
    disableHardwareAcceleration: () => { },
  };
  const electronStub = {
    app: fakeApp,
    BrowserWindow: class { },
    globalShortcut: { register: () => true, unregister: () => true, unregisterAll: () => { } },
    ipcMain: { handle: () => { }, on: () => { } },
  };
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return electronStub;
    return origLoad.apply(this, arguments);
  };
  installed = { userData, electronStub };
  return installed;
}

// 替换 child_process.spawn（返回调用方给的 fake 进程工厂）
function patchSpawn(factory) {
  const cp = require('child_process');
  const real = cp.spawn;
  cp.spawn = function (cmd, args, opts) {
    const fake = factory(cmd, args, opts);
    return fake || real.apply(this, arguments);
  };
  return () => { cp.spawn = real; };
}

module.exports = { installElectron, patchSpawn };
