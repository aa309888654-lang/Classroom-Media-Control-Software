// 验证哪个快捷键 accelerator 会抛异常（短时运行 3 秒）
const { app, globalShortcut } = require('electron');
const candidates = [
  'Control+Shift+F1', 'Control+Shift+F2', 'Control+Shift+F3',
  'Control+Shift+F4', 'Control+Shift+F5', 'Control+Shift+F6',
  'Control+Shift+F7', 'Control+Shift+F8',
  'Control+F1', 'Control+F2',
  'Control+Shift+1', 'Control+Shift+2',
  'Backquote', 'Escape', '`', '~',
];
app.whenReady().then(() => {
  for (const a of candidates) {
    try {
      const ok = globalShortcut.register(a, () => { });
      console.log(a.padEnd(20), ok ? 'OK' : 'REGISTER_FAIL');
    } catch (e) {
      console.log(a.padEnd(20), 'THROW ->', String(e.message || e));
    }
  }
  setTimeout(() => app.exit(0), 1500);
});
