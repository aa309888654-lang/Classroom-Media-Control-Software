const v = document.getElementById('v');
const vBar = document.getElementById('vBar');
const vPlayBtn = document.getElementById('vPlay');
const vPlayIco = document.getElementById('vPlayIco');
const vTime = document.getElementById('vTime');
const vSeek = document.getElementById('vSeek');
const vVol = document.getElementById('vVol');
const vVolBtn = document.getElementById('vVolBtn');
const vWinBtn = document.getElementById('vWin');

function fileUrl(p) {
  const norm = String(p).replace(/\\/g, '/');
  return encodeURI(`file:///${norm}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

window.api.on('video:load', ({ file }) => {
  v.src = fileUrl(file);
  v.volume = 1;
  v.play().catch(() => { });
  syncVolIcon();
});

window.api.on('video:control', (cmd) => {
  switch (cmd) {
    case 'toggle': v.paused ? v.play().catch(() => { }) : v.pause(); break;
    case 'fwd': v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); break;
    case 'back': v.currentTime = Math.max(0, v.currentTime - 10); break;
    case 'volUp': v.volume = Math.min(1, v.volume + 0.05); syncVolIcon(); break;
    case 'volDown': v.volume = Math.max(0, v.volume - 0.05); syncVolIcon(); break;
    case 'stop': window.api.invoke('video:notifyEnded'); break;
    default: break;
  }
});

v.addEventListener('ended', () => window.api.invoke('video:notifyEnded'));

// 播放失败兜底：文件损坏 / 编码不支持 / U 盘拔出时，<video> 只会静默黑屏，
// 而主进程 state.video.playing 仍为 true —— 面板一直显示「投放中」，只能按 Esc。
// 这里主动上报结束，让主进程把状态复位。
v.addEventListener('error', () => {
  window.api.invoke('video:notifyEnded');
});

// 喇叭图标随静音/音量变化：静音或音量为 0 显示带叉，否则显示声波；滑条同步遥控端音量
const ICO_VOL = '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>';
const ICO_MUTE = '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>';
function syncVolIcon() {
  const svg = vVolBtn.querySelector('svg');
  if (!svg) return;
  const muted = v.muted || v.volume === 0;
  svg.innerHTML = muted ? ICO_MUTE : ICO_VOL;
  vVolBtn.title = muted ? '取消静音' : '静音';
  vVol.value = Math.round(v.volume * 100);
}
v.addEventListener('volumechange', syncVolIcon);

// 视频窗口获得焦点时，Esc 直接停止投放
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.invoke('video:notifyEnded');
  if (e.key === ' ') { e.preventDefault(); v.paused ? v.play().catch(() => { }) : v.pause(); }
});

/* ---------- 底部控制条：进度/播放/音量/窗口切换 ---------- */
const ICO_PLAY = '<path d="M8 5v14l11-7z"/>';
const ICO_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

function syncPlayIcon() { vPlayIco.innerHTML = v.paused ? ICO_PLAY : ICO_PAUSE; }
v.addEventListener('play', syncPlayIcon);
v.addEventListener('pause', syncPlayIcon);

let seeking = false; // 拖动进度条期间不被 timeupdate 回写
vSeek.addEventListener('pointerdown', () => { seeking = true; });
vSeek.addEventListener('pointerup', () => { seeking = false; });
vSeek.addEventListener('input', () => {
  if (isFinite(v.duration) && v.duration > 0) vTime.textContent = `${fmt((vSeek.value / 1000) * v.duration)} / ${fmt(v.duration)}`;
});
vSeek.addEventListener('change', () => {
  if (isFinite(v.duration) && v.duration > 0) v.currentTime = (vSeek.value / 1000) * v.duration;
});
v.addEventListener('timeupdate', () => {
  if (!isFinite(v.duration) || v.duration <= 0) return;
  if (!seeking) vSeek.value = Math.round((v.currentTime / v.duration) * 1000);
  if (!seeking) vTime.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
});
v.addEventListener('loadedmetadata', () => {
  vTime.textContent = `0:00 / ${fmt(v.duration)}`;
});

vPlayBtn.addEventListener('click', () => { v.paused ? v.play().catch(() => { }) : v.pause(); });
vVol.addEventListener('input', () => { v.volume = vVol.value / 100; v.muted = false; syncVolIcon(); });
vVolBtn.addEventListener('click', () => { v.muted = !v.muted; syncVolIcon(); });
vWinBtn.addEventListener('click', () => window.api.invoke('video:windowToggle'));

/* ---------- 关闭钮 + 控制条的显现/隐藏 ---------- */
const vClose = document.getElementById('vClose');
let vHideTimer = null;
const HOT_X = 260, HOT_Y = 200, BAR_Y = 140; // 左上热区 + 底部控制条热区（距底 140px）
const IDLE_HIDE_MS = 2600;
const hintUntil = Date.now() + IDLE_HIDE_MS; // 提示期内移出热区不隐藏（OS 会按光标位置补发一次 mousemove）
function vShowClose() {
  document.body.classList.add('v-ui');
  clearTimeout(vHideTimer);
  vHideTimer = setTimeout(vHideClose, IDLE_HIDE_MS);
}
function vHideClose() { clearTimeout(vHideTimer); document.body.classList.remove('v-ui'); }
window.addEventListener('mousemove', (e) => {
  const inHot = (e.clientX <= HOT_X && e.clientY <= HOT_Y) || e.clientY >= window.innerHeight - BAR_Y;
  if (inHot) vShowClose();
  else if (Date.now() > hintUntil && !vClose.matches(':hover') && !vBar.matches(':hover')) vHideClose();
}, true);
vClose.addEventListener('mouseenter', vShowClose);
vClose.addEventListener('mouseleave', () => { vHideTimer = setTimeout(vHideClose, 1200); });
vBar.addEventListener('mouseenter', vShowClose);
vClose.addEventListener('click', () => window.api.invoke('video:notifyEnded'));
vShowClose();
