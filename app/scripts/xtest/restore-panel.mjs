/* 恢复：关掉遗留的计时器窗口，把控制面板带回前台 */
import { attach, sleep } from './cdp.mjs';

const t = await attach(9235, 'index.html');
const { ev, invoke } = t;

// 1) 计时器：先停表，再收起窗口
await invoke('timer:reset').catch(() => { });
await sleep(300);
await invoke('timer:toggleShow').catch(() => { });
await sleep(700);

// 2) 确保不在迷你模式
if (await ev('document.body.classList.contains("mini-mode")')) {
  await invoke('window:miniExpand').catch(() => { });
  await sleep(600);
}

// 3) 强制主窗口回到前台并取消最小化（走应用自身的接口）
await invoke('window:miniCollapse').catch(() => { });
await sleep(300);

const st = await ev(`(() => ({
  bodyClass: document.body.className || '(normal)',
  hasFocus: document.hasFocus(),
  screenX: window.screenX, screenY: window.screenY,
  outerW: window.outerWidth, outerH: window.outerHeight,
}))()`);
console.log('控制面板状态:', JSON.stringify(st));
t.close();
