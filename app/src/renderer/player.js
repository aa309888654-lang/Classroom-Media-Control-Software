const v = document.getElementById('v');
const vBar = document.getElementById('vBar');
const vPlayBtn = document.getElementById('vPlay');
const vPlayIco = document.getElementById('vPlayIco');
const vBackBtn = document.getElementById('vBack');
const vFwdBtn = document.getElementById('vFwd');
const vTime = document.getElementById('vTime');
const vSeek = document.getElementById('vSeek');
const vVol = document.getElementById('vVol');
const vVolBtn = document.getElementById('vVolBtn');
const vVolDownBtn = document.getElementById('vVolDown');
const vVolUpBtn = document.getElementById('vVolUp');
const vWinBtn = document.getElementById('vWin');

// 步进：前进/后退各 10 秒、音量各 5%。面板 IPC 和播放窗按钮共用同一套口径，
// 老师不管从遥控器还是直接点屏幕，行为完全一致。
const SEEK_STEP = 10;
const VOL_STEP = 0.05;
function stepTime(delta) {
  const d = isFinite(v.duration) ? v.duration : 0;
  v.currentTime = Math.max(0, Math.min(d || Infinity, (v.currentTime || 0) + delta));
}
function stepVol(delta) {
  v.volume = Math.max(0, Math.min(1, v.volume + delta));
  if (v.volume > 0) v.muted = false; // 调高音量等于取消静音，否则看着有音量却没声
  syncVolIcon();
  reportProgress(true);
}

function fileUrl(p) {
  const norm = String(p).replace(/\\/g, '/');
  return encodeURI(`file:///${norm}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------- 播放进度上报：主进程转给控制面板，在面板里也显示一条进度条 ----------
 * 视频本体在另一个窗口/屏幕上播放，老师手上只有控制面板，进度必须回传才看得见。
 * 500ms 节流：timeupdate 约 4Hz，全量转 enough 看清进度又不刷爆 IPC；
 * 播放/暂停/跳转/换片这类状态变化用 force 立即报，面板按钮和进度条不会慢半拍。 */
let lastReportAt = 0;
function reportProgress(force) {
  const now = Date.now();
  if (!force && now - lastReportAt < 500) return;
  lastReportAt = now;
  const d = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  window.api.invoke('video:progress', {
    t: Math.max(0, Math.min(d || 1e9, v.currentTime || 0)),
    d,
    p: v.paused ? 1 : 0,
  }).catch(() => { });
}

/* ---------- 图片投放（视频板块也收图片）：整屏 + 左右翻图 + 自动轮播 ---------- */
const img = document.getElementById('img');
const imgBar = document.getElementById('imgBar');
const imgInfo = document.getElementById('imgInfo');
const imgAutoBtn = document.getElementById('imgAuto');
let imgState = { index: 0, count: 1, auto: false, seconds: 5 };
let imgTimer = null;

function stopImgTimer() { if (imgTimer) { clearInterval(imgTimer); imgTimer = null; } }
// 自动轮播到头后从头继续（循环），不自动停：讲义/板书照片本来就是一组
function startImgTimer() {
  stopImgTimer();
  if (!imgState.auto || imgState.count < 2) return;
  imgTimer = setInterval(() => window.api.invoke('video:control', 'next'), Math.max(1000, imgState.seconds * 1000));
}
function renderImgBar() {
  imgInfo.textContent = `${imgState.index + 1} / ${imgState.count}`;
  imgAutoBtn.textContent = `自动轮播：${imgState.auto ? '开' : '关'}${imgState.auto ? `（${imgState.seconds}s）` : ''}`;
  imgAutoBtn.style.color = imgState.auto ? '#7fd1ff' : '';
}
function applyImgState(s) {
  imgState = { ...imgState, ...(s || {}) };
  renderImgBar();
  if (imgState.auto) startImgTimer(); else stopImgTimer();
}

window.api.on('video:load', (payload) => {
  const file = payload && payload.file;
  if (payload && payload.kind === 'img') {
    document.body.classList.add('img-mode');
    img.src = fileUrl(file);
    img.alt = String(file || '').split(/[\\/]/).pop();
    applyImgState({ index: payload.index || 0, count: payload.count || 1, auto: !!payload.auto, seconds: payload.seconds || 5 });
    return;
  }
  document.body.classList.remove('img-mode');
  img.removeAttribute('src');
  stopImgTimer();
  v.src = fileUrl(file);
  v.volume = 1;
  v.play().catch(() => { });
  syncVolIcon();
  reportProgress(true); // 换片立刻报一次（时长此时可能还是 0，loadedmetadata 会补报）
});

window.api.on('video:auto', ({ auto, seconds }) => applyImgState({ auto: !!auto, seconds }));

imgBar.querySelector('#imgPrev').addEventListener('click', () => window.api.invoke('video:control', 'prev'));
imgBar.querySelector('#imgNext').addEventListener('click', () => window.api.invoke('video:control', 'next'));
imgAutoBtn.addEventListener('click', () => window.api.invoke('video:control', 'auto'));

// 播放窗里的键盘操作：←/→ 翻图，Esc 停止，空格 播/暂停（视频）
window.addEventListener('keydown', (e) => {
  if (document.body.classList.contains('img-mode')) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); window.api.invoke('video:control', 'prev'); return; }
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); window.api.invoke('video:control', 'next'); return; }
  }
});

// 控制面板进度条拖动跳转：面板 invoke('video:seek', 秒)
window.api.on('video:seek', (t) => {
  const d = isFinite(v.duration) ? v.duration : 0;
  const sec = Math.max(0, Math.min(d || Infinity, Number(t) || 0));
  if (!isFinite(sec)) return;
  v.currentTime = sec;
  reportProgress(true);
});

// 全屏 ⇄ 窗口模式：主进程切完把状态推回来，按钮提示跟着变（原来这里没监听，图标一直不变）
window.api.on('video:windowmode', ({ windowed }) => {
  vWinBtn.title = windowed ? '切为全屏' : '切为窗口';
});

window.api.on('video:control', (cmd) => {
  switch (cmd) {
    case 'toggle': v.paused ? v.play().catch(() => { }) : v.pause(); break;
    case 'fwd': stepTime(SEEK_STEP); break;
    case 'back': stepTime(-SEEK_STEP); break;
    case 'volUp': stepVol(VOL_STEP); break;
    case 'volDown': stepVol(-VOL_STEP); break;
    case 'stop': window.api.invoke('video:notifyEnded'); break;
    default: break;
  }
  reportProgress(true);
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

// 视频窗口获得焦点时，Esc 直接停止投放（图片模式下空格/→ 由上面的翻图处理器接管）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.invoke('video:notifyEnded');
  if (document.body.classList.contains('img-mode')) return;
  // 视频模式快捷键：←/→ 快退快进，↑/↓ 调音量，和控制条按钮同一步长
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); stepTime(-SEEK_STEP); reportProgress(true); break;
    case 'ArrowRight': e.preventDefault(); stepTime(SEEK_STEP); reportProgress(true); break;
    case 'ArrowUp': e.preventDefault(); stepVol(VOL_STEP); break;
    case 'ArrowDown': e.preventDefault(); stepVol(-VOL_STEP); break;
    case ' ':
      e.preventDefault();
      v.paused ? v.play().catch(() => { }) : v.pause();
      break;
    default: break;
  }
});
// 图片加载失败（U 盘拔出/文件损坏）：和视频一样主动上报结束，别让面板一直显示「投放中」
img.addEventListener('error', () => {
  if (document.body.classList.contains('img-mode')) window.api.invoke('video:notifyEnded');
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
  reportProgress(); // 面板进度条同步
});
v.addEventListener('loadedmetadata', () => {
  vTime.textContent = `0:00 / ${fmt(v.duration)}`;
  reportProgress(true);
});
v.addEventListener('play', reportProgress.bind(null, true));
v.addEventListener('pause', reportProgress.bind(null, true));
v.addEventListener('seeked', reportProgress.bind(null, true));

vPlayBtn.addEventListener('click', () => { v.paused ? v.play().catch(() => { }) : v.pause(); });
vBackBtn.addEventListener('click', () => { stepTime(-SEEK_STEP); reportProgress(true); });
vFwdBtn.addEventListener('click', () => { stepTime(SEEK_STEP); reportProgress(true); });
vVolDownBtn.addEventListener('click', () => stepVol(-VOL_STEP));
vVolUpBtn.addEventListener('click', () => stepVol(VOL_STEP));
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
  // 图片模式悬停的是 imgBar，视频模式是 vBar，两者只显示其一
  const bar = document.body.classList.contains('img-mode') ? imgBar : vBar;
  if (inHot) vShowClose();
  else if (Date.now() > hintUntil && !vClose.matches(':hover') && !bar.matches(':hover')) vHideClose();
}, true);
vClose.addEventListener('mouseenter', vShowClose);
vClose.addEventListener('mouseleave', () => { vHideTimer = setTimeout(vHideClose, 1200); });
vBar.addEventListener('mouseenter', vShowClose);
imgBar.addEventListener('mouseenter', vShowClose);
vClose.addEventListener('click', () => window.api.invoke('video:notifyEnded'));
vShowClose();
