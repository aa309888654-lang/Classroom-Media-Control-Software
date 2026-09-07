const v = document.getElementById('v');

function fileUrl(p) {
  const norm = String(p).replace(/\\/g, '/');
  return encodeURI(`file:///${norm}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

window.api.on('video:load', ({ file }) => {
  v.src = fileUrl(file);
  v.volume = 1;
  v.play().catch(() => { });
});

window.api.on('video:control', (cmd) => {
  switch (cmd) {
    case 'toggle': v.paused ? v.play().catch(() => { }) : v.pause(); break;
    case 'fwd': v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); break;
    case 'back': v.currentTime = Math.max(0, v.currentTime - 10); break;
    case 'volUp': v.volume = Math.min(1, v.volume + 0.1); break;
    case 'volDown': v.volume = Math.max(0, v.volume - 0.1); break;
    case 'stop': window.api.invoke('video:notifyEnded'); break;
    default: break;
  }
});

v.addEventListener('ended', () => window.api.invoke('video:notifyEnded'));

// 视频窗口获得焦点时，Esc 直接停止投放
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.invoke('video:notifyEnded');
});

// 左上角 ✕ 滑出钮：开屏先显 2.6 秒提示；之后鼠标靠近左上角热区才显现，闲置自动隐藏
const vClose = document.getElementById('vClose');
let vHideTimer = null;
const HOT_X = 260, HOT_Y = 200, IDLE_HIDE_MS = 2600;
const hintUntil = Date.now() + IDLE_HIDE_MS; // 提示期内移出热区不隐藏（OS 会按光标位置补发一次 mousemove）
function vShowClose() {
  document.body.classList.add('v-ui');
  clearTimeout(vHideTimer);
  vHideTimer = setTimeout(vHideClose, IDLE_HIDE_MS);
}
function vHideClose() { clearTimeout(vHideTimer); document.body.classList.remove('v-ui'); }
window.addEventListener('mousemove', (e) => {
  const inHot = e.clientX <= HOT_X && e.clientY <= HOT_Y;
  if (inHot) vShowClose();
  else if (Date.now() > hintUntil && !vClose.matches(':hover')) vHideClose();
}, true);
vClose.addEventListener('mouseenter', vShowClose);
vClose.addEventListener('mouseleave', () => { vHideTimer = setTimeout(vHideClose, 1200); });
vClose.addEventListener('click', () => window.api.invoke('video:notifyEnded'));
vShowClose();
