/* ===== 小天AIGC · 主控面板逻辑 ===== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- 全局错误边界 ---------- */
// 捕获未处理的同步异常
window.addEventListener('error', (e) => {
  console.error('[Global Error]', e.error);
  // 上报到主进程日志（如果 toast 函数已初始化则显示提示）
  if (window.api && window.api.invoke) {
    window.api.invoke('log:error', {
      message: e.error?.message || String(e.error),
      stack: e.error?.stack || ''
    }).catch(() => {});
  }
  // 如果 toast 函数已定义，显示友好提示
  if (typeof showToast === 'function') {
    showToast('程序遇到错误，部分功能可能受影响', 'error');
  }
});

// 捕获未处理的 Promise 拒绝
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled Promise]', e.reason);
  if (window.api && window.api.invoke) {
    window.api.invoke('log:error', {
      message: e.reason?.message || String(e.reason),
      stack: e.reason?.stack || ''
    }).catch(() => {});
  }
});

/* ---------- IPC 超时保护 ---------- */
// 封装 IPC 调用，添加 10 秒超时保护，避免主进程卡死时渲染进程永久等待
async function ipcInvoke(channel, ...args) {
  const timeoutMs = 10000; // 10 秒超时
  return Promise.race([
    window.api.invoke(channel, ...args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`IPC timeout: ${channel}`)), timeoutMs)
    )
  ]);
}

// ---------- DOM 缓存：避免每次操作都查询 ----------
const dom = {};
function cacheDom() {
  document.querySelectorAll('[id]').forEach((el) => { dom[el.id] = el; });
}

const state = {
  config: null,
  brand: null, // 解密的品牌负载（名称/版本/官网/赞助）
  music: [],
  videos: [],
  ppts: [],
  displays: [],
  office: null,
  ppt: { presenting: false, file: '', loading: false },
  pptPage: null, // 放映中的页码信息 {position,total}，供迷你条显示
  video: { playing: false, file: '' },
  selectedPpt: '',
  conflicts: [],
};

const CAT_ICON = {}; // 卡片不再使用图标头像，保留空映射以备引用
const CAT_ICON_POOL = ['music'];
const HK_LABELS = {
  playPause: '播放 / 暂停', prev: '上一首', next: '下一首', mute: '静音',
  volUp: '音量 +', volDown: '音量 −', cat1: '分类 1 播放', cat2: '分类 2 播放',
  present: '放映当前课件', exitPresent: '退出投屏', pptPrev: 'PPT 上一页', pptNext: 'PPT 下一页',
  timerToggle: '计时器 启动/暂停', timerReset: '计时器 重置',
  openFull: '全屏（LED投屏）', exitFull: '退出全屏',
};
const SHORT_KEYS = { playPause: 'M', prev: '←', next: '→', volUp: '↑', volDown: '↓', cat1: '1', cat2: '2', present: 'P', exitPresent: 'Esc' };

/* ---------- 初始化 ---------- */
init();

// 品牌负载注入：logo/名称/版本/官网/赞助全部来自加密数据（源码无明文）
function applyBrand(b) {
  state.brand = b;
  const fileUrl = (p) => encodeURI(`file:///${String(p).replace(/\\/g, '/')}`);
  if (b.logo) {
    const topLogo = document.querySelector('.topbar .logo');
    if (topLogo) topLogo.src = fileUrl(b.logo);
    const idleLogo = document.querySelector('#ledIdle .led-idle-logo');
    if (idleLogo) idleLogo.src = fileUrl(b.logo);
  }
  if (b.name) {
    const bn = document.querySelector('.brand-name');
    if (bn) bn.textContent = b.name;
    const lt = document.querySelector('.led-idle-text');
    if (lt) lt.textContent = `${b.name} · 课堂中控`;
    document.title = `${b.name} · 课堂中控`;
  }
  // 注意：这里**不要**覆盖 dom.stVer。
  // 品牌资产里的 version 是品牌包创建时写死的占位值（实测就是 "0.1.0"，从未跟着版本迭代），
  // 盖在状态栏上会让老师永远看到 "v0.1.0"。
  // 状态栏显示的是**应用版本**，由 init() 用 app:getInit 的 version 写入。
  if (b.site) dom.stSite.textContent = b.site;
}

async function init() {
  cacheDom();
  // d 必须声明在 try 外面：函数末尾要用 d.version / d.brand。
  // 原来 const d 写在 try 块内，块外的 `dom.stVer.textContent = v${d.version}` 会抛
  // ReferenceError: d is not defined → init() 在最后几行中断，
  // applyBrand() 从不执行（品牌 logo/名称/版本/官网/赞助全是 index.html 里的静态占位，
  // 状态栏版本号永远停在 "v0.1.0"），applyPlatformUI() 与快捷键冲突提示也跟着不执行。
  // 2026-10-20 全面检查发现（经 log:error 通道在主进程日志里抓到的启动期异常）。
  let d = null;
  try {
    d = await ipcInvoke('app:getInit');
    state.platform = d.platform || 'win32';
    state.config = d.config;
    state.music = d.music || [];
    applyCatOrder();
    applyPinned();
    state.videos = d.videos || [];
    state.ppts = d.ppts || [];
    state.displays = d.displays || [];
    state.office = d.office;
    state.ppt = d.ppt || { presenting: false };
    state.video = d.video || { playing: false };
    state.conflicts = d.hotkeyConflicts || [];
    state.selectedPpt = (d.config.recentPpt || [])[0] || '';
  } catch (err) {
    if (err.message && err.message.includes('IPC timeout')) {
      console.error('初始化超时，请重启应用');
      alert('初始化超时，请重启应用');
      return;
    }
    throw err;
  }

  applySectionOrder(); // 按保存的顺序重排主面板板块（音乐/投屏/视频/课堂工具自由布置）
  bindSectionDrag();   // 板块标题长按/竖向拖动排序
  initMediaSplit();    // 音视频行分隔条：拖动调整左右/上下大小（持久化）

  engine.setCategories(state.music);
  engine.volume = state.config.volume;
  engine.crossfade = state.config.crossfadeSeconds;
  engine.ppFade = state.config.playPauseFadeSeconds;
  engine.loopMode = state.config.loopMode;
  engine.onState = onMusicState;
  // 播放文件损坏/读不出：提示并自动跳下一首（引擎侧已做连续失败保护）
  engine.onError = (name, count) => {
    if (count >= 3) toast('连续多首播放失败：请检查音乐文件夹（U盘是否拔出）', 'error');
    else toast(`「${name}」播放失败，已跳下一首`, 'warn');
  };
  applyDensity(state.config.uiDensity);
  applyDisplayMode(state.config.displayMode);
  // 兼容模式（老旧电脑关 GPU 加速后重启生效）：渲染层同步挂类，CSS 据此去掉毛玻璃/重阴影/持续动画
  document.body.classList.toggle('compat-mode', !!state.config.compatMode);
  applyToolsVisibility(); // 顶栏「工具」按钮记忆的课堂工具显隐
  applyVideoVisibility(); // 顶栏「视频」按钮记忆的视频板块显隐
  // 迷你模式记忆：上次关机时若在迷你模式，直接以迷你面板启动（LED 模式优先，互斥）
  if (state.config.miniMode && state.config.displayMode !== 'led') {
    document.body.classList.add('mini-mode');
    dom.miniDock.hidden = false;
    window.api.invoke('window:miniMode', true).catch(() => { });
  }

  bindUI();
  renderAll();
  syncLoopBtn({ loopMode: engine.loopMode }); // 循环按钮文案按保存的配置初始化（不只是默认「列表」）
  subscribe();
  startProgressLoop();
  Icons.hydrate(document); // 静态图标全局替换（SVG 扁平版）

  dom.stVer.textContent = `v${d.version}`;
  if (d.brand) applyBrand(d.brand);
  applyPlatformUI();
  if (state.conflicts.length) {
    toast(`快捷键被占用：${state.conflicts.map((c) => dispAcc(c.accelerator)).join('、')}，可在设置中改键`, 'warn');
  }
}

// 平台相关界面：Mac 隐藏「一键扩展模式」（macOS 外接显示器默认即扩展），
// 快捷键提示/按钮 tooltip 按当前配置与平台符号（⌘⌥⌃）重绘
function applyPlatformUI() {
  const isMacUI = state.platform === 'darwin';
  const hk = (state.config && state.config.hotkeys) || {};
  const acc = (k) => dispAcc(hk[k] || '');

  // 三个面板的快捷键提示行按实际键位重排
  if (dom.hkHintMusic) dom.hkHintMusic.textContent =
    `快捷键 空格/${acc('playPause')} 播放/暂停 · ${acc('prev')}/${acc('next')} 切歌 · ${acc('mute')} 静音 · ${acc('volDown')}/${acc('volUp')} 音量−/＋ · ${acc('cat1')}/${acc('cat2')} 切分类 · ~ 全屏 · Esc 退出全屏 · 拖动行排序 · ☆置顶 · ⤒导入`;
  if (dom.hkHintPpt) dom.hkHintPpt.textContent =
    `PPT 放映在投影屏全屏 · ${acc('present')} 放映 · ${acc('exitPresent')} 退出 · ${acc('pptPrev')}/${acc('pptNext')} 翻页 · 课件库长按拖动排序`;
  if (dom.hkHintTimer) dom.hkHintTimer.textContent =
    `计时 ${acc('timerToggle')} 启停 · ${acc('timerReset')} 重置`;

  // 音乐控制按钮 tooltip 跟随实际键位
  const HK_TIP = { prev: '上一首', playPause: '播放/暂停', next: '下一首' };
  document.querySelectorAll('[data-hk]').forEach((el) => {
    const a = el.getAttribute('data-hk');
    if (HK_TIP[a] && hk[a]) el.title = `${HK_TIP[a]} (${acc(a)})`;
  });

  if (isMacUI) {
    // macOS 没有 DisplaySwitch：外接投影默认就是扩展桌面，隐藏该入口
    if (dom.extendRow) dom.extendRow.style.display = 'none';
    if (dom.pptCloseTip) dom.pptCloseTip.textContent = '同时关闭 PowerPoint 程序';
  }
}

function subscribe() {
  window.api.on('hotkey', (action) => handleHotkey(action));
  window.api.on('music:restore', ({ action, immediate }) => (action === 'duck' ? engine.duck(!!immediate) : engine.restore()));
  // 转码进度（添加/播放冷门格式视频、音频时自动转码为 MP4/MP3）
  window.api.on('import:progress', (p) => {
    if (!p) { dom.osd.hidden = true; return; }
    showOSD(`⏳ 转码中 ${p.pct}%：${p.label}`);
  });
  // 库缩略图异步生成完成：视频/课件芯片补图（只补这一张，不再整列表重建，PERF-03）
  window.api.on('thumb:ready', ({ kind, file, thumb }) => {
    if (!thumb) return;
    const list = kind === 'video' ? state.videos : state.ppts;
    const it = list.find((x) => x.file === file);
    if (it && it.thumb !== thumb) {
      it.thumb = thumb;
      updateChipThumb(kind, file, thumb);
    }
  });
  window.api.on('ppt:state', (s) => {
    state.ppt = { ...state.ppt, ...s }; renderPptState(); renderMode();
    // 放映时的悬浮控制改由主进程的 floatBar（无边框半透明浮条）承担，面板不再自动变形
  });
  // 放映自动置顶：主进程临时打开/还原置顶，面板「置顶」按钮跟着点亮/熄灭，避免看着没置顶其实置了
  window.api.on('window:alwaysOnTop', ({ alwaysOnTop: on }) => {
    dom.btnPin.classList.toggle('on', !!on);
    dom.btnPin.title = on ? '取消窗口置顶' : '窗口置顶（放映 PPT 时会自动置顶，结束放映后还原）';
  });
  window.api.on('video:state', (v) => {
    state.video = v;
    if (typeof v.windowed === 'boolean') state.config.videoWindowed = v.windowed; // 与主进程持久化保持一致
    renderVideoState(); renderMode();
  });
  window.api.on('displays:changed', (list) => { state.displays = list; renderDisplays(); });
  window.api.on('toast', ({ text, type }) => toast(text, type));
  window.api.on('ppt:presenter', (s) => renderPresenter(s));
  window.api.on('timer:tick', (s) => renderTimer(s));
  window.api.on('cast:state', (s) => renderCast(s));
  window.api.on('cast:status', ({ event }) => onCastStatus(event));
  window.api.on('welcome:state', (s) => renderWelcomeState(s));
  window.api.on('timer:finished', () => {
    renderTimer({ mode: 'countdown', finished: true, remaining: 0, elapsed: 0, started: true });
    beep(3);
    toast('⏰ 时间到！', 'warn');
  });
  // LED 模式：内联视频加载与控制
  window.api.on('video:load', ({ file }) => ledVideoLoad(file));
  window.api.on('video:control', (cmd) => ledVideoControl(cmd));
  // 播放窗的进度回报（控制台模式：视频在投影屏上，面板里显示进度条）
  window.api.on('video:progress', (p) => renderVideoProgress(p));
  // 全页缩略图渐进广播（导出中一张张来，轨道边导边显示）
  window.api.on('ppt:pages', (d) => onPptPages(d));
  window.api.on('peer:list', (list) => renderPeerList(list));
  window.api.on('peer:connected', (s) => onPeerConnected(s));
}

function renderAll() {
  renderCategories();
  renderPptState();
  renderRecents();
  renderVideos();
  renderPptChips();
  renderVideoState();
  renderDisplays();
  renderOffice();
  renderMode();
  syncConfigUI();
}

/* ---------- 界面密度 ---------- */
function applyDensity(d) {
  document.body.classList.toggle('roomy', d === 'roomy');
}

/* ---------- 显示模式（控制台 / LED 投屏） ---------- */
let displayModeInit = true;
function applyDisplayMode(mode) {
  const led = mode === 'led';
  document.body.classList.toggle('led-mode', led);
  dom.ledVideo.hidden = true;
  dom.ledIdle.hidden = !led;
  dom.ledDock.hidden = !led;
  // 按钮文字显示「点它会去哪」而不是「现在在哪」，避免误以为控制台模式被困住
  dom.btnMode.innerHTML = `<span class="ico"></span> ${led ? '切回控制台' : '切到LED投屏'}`;
  Icons.set(dom.btnMode.querySelector('.ico'), led ? 'monitor' : 'cast', 13);
  if (!led) {
    const v = dom.ledVideo;
    v.pause(); v.src = ''; v.hidden = true;
  }
  // 初始加载不重复设置全屏（主进程已处理），仅切换时操作
  if (!displayModeInit) {
    window.api.invoke('window:setFullscreen', led).catch(() => {});
  }
  displayModeInit = false;
}

async function toggleDisplayMode() {
  const newMode = document.body.classList.contains('led-mode') ? 'control' : 'led';
  state.config = await window.api.invoke('config:save', { displayMode: newMode });
  applyDisplayMode(newMode);
  toast(newMode === 'led' ? '已切换到 LED 投屏模式' : '已切换到控制台模式', 'ok');
}

/* LED 模式：内联视频加载 */
function ledVideoLoad(file) {
  if (!document.body.classList.contains('led-mode')) return;
  const v = dom.ledVideo;
  const norm = String(file).replace(/\\/g, '/');
  v.src = encodeURI(`file:///${norm}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
  v.hidden = false;
  dom.ledIdle.hidden = true;
  v.volume = 1;
  vpDur = 0; vpLast = null; // 换片：进度归零，别把上一部的时长/位置带到新片
  renderVideoProgress({ t: 0, d: 0, p: 0 });
  v.play().catch(() => {});
}

/* LED 模式：内联视频控制 */
function ledVideoControl(cmd) {
  if (!document.body.classList.contains('led-mode')) return;
  const v = dom.ledVideo;
  switch (cmd) {
    case 'toggle': v.paused ? v.play().catch(() => {}) : v.pause(); break;
    case 'fwd': v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); break;
    case 'back': v.currentTime = Math.max(0, v.currentTime - 10); break;
    case 'volUp': v.volume = Math.min(1, v.volume + 0.05); break;
    case 'volDown': v.volume = Math.max(0, v.volume - 0.05); break;
    case 'stop':
      v.pause(); v.src = ''; v.hidden = true;
      dom.ledIdle.hidden = false;
      break;
    default: break;
  }
}

/* ---------- 播放进度条（rAF 循环 + 250ms 节流：低性能电脑上不再逐帧重排，仅播放中运行） ---------- */
let progressRAF = null;
let lastProgressTs = 0;
function tickProgress(ts) {
  progressRAF = null;
  const now = ts || performance.now();
  const ch = engine.channels[engine.active];
  const el = ch && ch.el;
  const dur = el && isFinite(el.duration) ? el.duration : 0;
  const show = engine.idx >= 0 && dur > 0;
  if (!lastProgressTs || now - lastProgressTs >= 250) {
    lastProgressTs = now;
    dom.npProgress.style.display = show ? 'block' : 'none';
    dom.npTime.style.display = show ? 'block' : 'none';
    if (show) {
      const ratio = (el.currentTime / dur) * 100;
      dom.npFill.style.width = `${ratio}%`;
      if (dom.npKnob) dom.npKnob.style.left = `${ratio}%`;
      dom.npTime.textContent = `${fmtTime(el.currentTime)} / ${fmtTime(dur)}`;
    }
  }
  // 只在「时间确实在走」时续帧：暂停/播完后 currentTime 不变，继续 60fps 空转纯属烧 CPU。
  // 恢复播放时 engine.emit() → onMusicState → kickProgressLoop() 会重新唤起，不依赖常驻循环。
  if (engine.idx >= 0 && engine.playing) progressRAF = requestAnimationFrame(tickProgress);
}
function kickProgressLoop() {
  if (progressRAF || document.hidden) return;
  progressRAF = requestAnimationFrame(tickProgress);
}
function startProgressLoop() { kickProgressLoop(); }

// 页面隐藏时暂停 rAF，可见时恢复
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (progressRAF) { cancelAnimationFrame(progressRAF); progressRAF = null; }
  } else kickProgressLoop();
});

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- 循环模式：下拉菜单多选（list=列表循环 · single=单曲循环 · once=顺序播放播完停止） ---------- */
const LOOP_MODES = [
  { key: 'list', label: '列表循环', desc: '整个列表播完自动从头再来' },
  { key: 'single', label: '单曲循环', desc: '重复播放当前这一首' },
  { key: 'once', label: '顺序播放', desc: '列表播完自动停止' },
];
const LOOP_LABEL = { list: '列表', single: '单曲', once: '顺序' };
let loopMenuEl = null; // 懒建的单例菜单，打开时定位到按钮下方

function syncLoopBtn(s) {
  const mode = (s && s.loopMode) || engine.loopMode || 'list';
  if (dom.btnLoop) dom.btnLoop.textContent = `循环：${LOOP_LABEL[mode] || '列表'} ▾`;
  if (loopMenuEl) markLoopMenu(mode);
}

function markLoopMenu(mode) {
  if (!loopMenuEl) return;
  loopMenuEl.querySelectorAll('.loop-menu-item').forEach((it) => {
    it.classList.toggle('on', it.dataset.mode === mode);
  });
}

function closeLoopMenu() {
  if (!loopMenuEl) return;
  loopMenuEl.remove();
  loopMenuEl = null;
  document.removeEventListener('pointerdown', onLoopMenuOutside, true);
  window.removeEventListener('resize', closeLoopMenu);
  dom.btnLoop.classList.remove('on');
}

// 菜单外点击/窗口尺寸变化即收起（capture 阶段先于按钮 click，避免同一点击“开了又关”）
function onLoopMenuOutside(e) {
  if (loopMenuEl && !loopMenuEl.contains(e.target) && e.target !== dom.btnLoop) closeLoopMenu();
}

function openLoopMenu() {
  closeLoopMenu();
  const cur = engine.loopMode || 'list';
  const menu = document.createElement('div');
  menu.className = 'loop-menu';
  menu.setAttribute('role', 'menu');
  LOOP_MODES.forEach((m) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'loop-menu-item' + (m.key === cur ? ' on' : '');
    item.dataset.mode = m.key;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', m.key === cur ? 'true' : 'false');
    item.innerHTML = `<span class="lm-check">✓</span><span class="lm-text">${m.label}<span class="lm-desc">${m.desc}</span></span>`;
    item.onclick = () => {
      engine.setLoopMode(m.key);
      closeLoopMenu();
    };
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  // 定位：按钮下方，右边界不超出视口
  const r = dom.btnLoop.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  loopMenuEl = menu;
  dom.btnLoop.classList.add('on');
  document.addEventListener('pointerdown', onLoopMenuOutside, true);
  window.addEventListener('resize', closeLoopMenu);
}

/* ---------- 音乐（播放器布局：左分类歌单 + 右曲目列表 + 底部播放条） ---------- */
let selCatView = ''; // 右侧曲目列表当前展示的分类
let followedCat = ''; // 上一次跟随播放切到的分类（仅播放分类变化时跟随，调音量等不抢走手动浏览）
let catListExpanded = false; // 歌单栏收起时（只显示前 N 个）点「还有 N 个分类…」临时展开全部

// 歌单栏头数量显示：收起时「3/10」，全部时「全部」
function syncCatShowVal() {
  if (!dom.catShowVal) return;
  const v = Math.max(0, Number(state.config.catShowLimit) || 0);
  const total = state.music.length;
  dom.catShowVal.textContent = v > 0 ? `${Math.min(v, total)}/${total}` : '全部';
}

// 选中分类失效（被删/为空）时兜底：优先跟随播放中的分类，否则第一个
function ensureSelCat() {
  if (state.music.some((c) => c.category === selCatView)) return;
  selCatView = (engine.category && state.music.some((c) => c.category === engine.category))
    ? engine.category
    : (state.music[0] ? state.music[0].category : '');
}

function renderCategories() {
  renderCatList();
  renderTrackList();
}

/* 左侧分类歌单：点击=选中查看曲目 · ▶=播放/暂停 · 双击曲目行=播放 · 管理模式可导入/删除/拖动排序 */
function renderCatList() {
  ensureSelCat();
  const box = dom.catList;
  const frag = document.createDocumentFragment();
  // 显示数量（歌单栏头 −/＋ 调节，默认 3 个）：0=全部；N=只显示排序后的前 N 个。
  // 收起时超出数量的不渲染，点「还有 N 个分类…」临时展开（带「隐藏」标记）；管理模式始终全量显示
  const limit = Math.max(0, Number(state.config.catShowLimit) || 0);
  const total = state.music.length;
  const collapsed = !state.addMode && limit > 0 && limit < total && !catListExpanded;
  const shown = collapsed ? state.music.slice(0, limit) : state.music;
  const hiddenFrom = (limit > 0 && !state.addMode) ? Math.min(limit, total) : total;
  shown.forEach((cat, i) => {
    const isHidden = i >= hiddenFrom;
    const isCur = engine.category === cat.category;
    const el = document.createElement('div');
    el.className = 'cat-item' + (cat.category === selCatView ? ' sel' : '') + (isCur ? ' playing' : '') + (isHidden ? ' cat-hidden' : '');
    if (isHidden) el.title = '已隐藏：正常模式不显示，曲目仍可播放与管理';
    el.dataset.cat = cat.category;

    // 行首播放钮：一键播放该分类；正在播放时变暂停键（点击=暂停/继续）
    const play = document.createElement('button');
    play.className = 'ci-play';
    play.title = isCur ? '暂停/继续该分类' : '播放该分类';
    play.innerHTML = '<span class="ico"></span>';
    Icons.set(play.querySelector('.ico'), isCur && engine.playing ? 'pause' : 'play', 13);
    play.onclick = (e) => {
      e.stopPropagation();
      if (Date.now() < suppressClickUntil) return;
      if (!engine.playCategory(cat.category)) {
        toast(`「${cat.category}」还没有音乐，把 MP3/WAV 放进对应文件夹即可`, 'warn');
      }
    };
    el.appendChild(play);

    const name = document.createElement('span');
    name.className = 'ci-name';
    name.textContent = cat.category;
    el.appendChild(name);

    const count = document.createElement('span');
    count.className = 'ci-count';
    count.textContent = `${cat.tracks.length}首`;
    el.appendChild(count);

    if (isHidden) {
      const tag = document.createElement('span');
      tag.className = 'cat-hidden-tag';
      tag.textContent = '隐藏';
      el.appendChild(tag);
    }

    // 管理模式：行上「＋」添加音乐 / 「✕」删除分类
    if (state.addMode) {
      const imp = document.createElement('span');
      imp.className = 'ci-import';
      imp.innerHTML = '<span class="ico"></span>';
      Icons.set(imp.querySelector('.ico'), 'plus', 12);
      imp.title = '添加音乐到该分类（复制到音乐文件夹，长期保存）';
      imp.onclick = (e) => { e.stopPropagation(); importToCat(cat); };
      el.appendChild(imp);
      if (!cat.builtin && !cat.virtual) {
        const del = document.createElement('span');
        del.className = 'ci-del';
        del.textContent = '✕';
        del.title = '删除分类（文件夹移入回收站）';
        del.onclick = (e) => { e.stopPropagation(); confirmDeleteCategory(cat.category); };
        el.appendChild(del);
      }
    }

    el.onclick = () => {
      if (Date.now() < suppressClickUntil) return;
      if (selCatView !== cat.category) { selCatView = cat.category; renderCategories(); }
    };
    el.ondblclick = () => {
      if (Date.now() < suppressClickUntil) return;
      if (!engine.playCategory(cat.category)) {
        toast(`「${cat.category}」还没有音乐，把 MP3/WAV 放进对应文件夹即可`, 'warn');
      }
    };
    bindCatDrag(el, cat); // 分类行长按/竖拖排序
    frag.appendChild(el);
  });
  // 收起 → 「还有 N 个分类…」展开；已展开 → 「▴ 收起」回到只显示前 N 个
  const hiddenCount = total - shown.length;
  if (collapsed && hiddenCount > 0) {
    const more = document.createElement('div');
    more.className = 'cat-item cat-morecard';
    more.textContent = `还有 ${hiddenCount} 个分类… 点此展开`;
    more.title = '展开查看全部分类；用上方 −/＋ 调整默认显示数量';
    more.onclick = () => { catListExpanded = true; renderCategories(); };
    frag.appendChild(more);
  } else if (catListExpanded && !state.addMode && limit > 0 && limit < total) {
    const more = document.createElement('div');
    more.className = 'cat-item cat-morecard';
    more.textContent = `▴ 收起，只显示前 ${Math.min(limit, total)} 个`;
    more.title = '收起后只显示排序在前的前几个分类；用上方 −/＋ 调整数量';
    more.onclick = () => { catListExpanded = false; renderCategories(); };
    frag.appendChild(more);
  }
  // 添加分类入口行（内联输入框）
  const add = document.createElement('div');
  add.className = 'cat-item cat-add-row';
  add.innerHTML = '<span class="ico"></span><span>添加分类</span>';
  Icons.set(add.querySelector('.ico'), 'plus', 13);
  add.onclick = () => showAddCategory(add);
  frag.appendChild(add);
  box.innerHTML = '';
  box.appendChild(frag);
  syncCatShowVal();
}

// 导入音乐到指定分类（管理模式分类行「＋」）
async function importToCat(cat) {
  const r = await window.api.invoke('music:import', cat.category);
  if (!r || r.canceled) return;
  if (r.ok && r.imported > 0) {
    state.music = r.music;
    applyCatOrder();
    applyPinned();
    engine.setCategories(state.music);
    renderCategories();
    toast(`已添加 ${r.imported} 首到「${cat.category}」，已存入音乐文件夹${r.transcoded ? `（含转码 ${r.transcoded} 首）` : ''}`, 'ok');
  } else if (r.ok) {
    toast('未添加：所选文件不是支持的音频格式', 'warn');
  } else {
    toast('添加失败', 'error');
  }
}

/* 右侧曲目列表：双击行播放（单击只浏览不播放，避免误触）· ☆置顶 · ✕删除 · 长按/竖拖排序；播放中的行换序号为跳动均衡条 */
function renderTrackList() {
  const box = dom.catCards;
  const prevScroll = box.scrollTop; // 重建后保持滚动位置（音量拖动等高频重建时不跳）
  const cat = state.music.find((c) => c.category === selCatView);
  dom.selCatName.textContent = cat ? cat.category : '未选择分类';
  dom.selCatCount.textContent = cat ? `${cat.tracks.length} 首` : '';
  if (!cat) {
    box.innerHTML = `<div class="track-empty">${state.music.length
      ? '← 在左侧选择一个分类，这里显示曲目列表'
      : '曲库为空：点左侧「＋ 添加分类」建一个，再往文件夹里放 MP3/WAV'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  if (!cat.tracks.length) {
    const tip = document.createElement('div');
    tip.className = 'track-empty';
    tip.textContent = `「${cat.category}」还没有音乐：管理模式下点分类行的 ＋ 添加，或把 MP3/WAV 放进对应文件夹`;
    frag.appendChild(tip);
  }
  const pinnedFiles = (state.config.catPinned || {})[cat.category] || [];
  cat.tracks.forEach((f, idx) => {
    const playingRow = engine.category === cat.category && engine.idx === idx;
    const row = document.createElement('div');
    // paused 类：暂停时均衡条停止跳动（CSS 控制）
    row.className = 'cat-track' + (playingRow ? ' playing' : '') + (playingRow && !engine.playing ? ' paused' : '');
    row.dataset.cat = cat.category;
    row.dataset.idx = String(idx);
    if (playingRow) {
      const eq = document.createElement('span');
      eq.className = 't-eq';
      eq.innerHTML = '<i></i><i></i><i></i>';
      row.appendChild(eq);
    } else {
      const num = document.createElement('span');
      num.className = 't-num';
      num.textContent = String(idx + 1);
      row.appendChild(num);
    }
    const nameEl = document.createElement('span');
    nameEl.className = 't-name';
    nameEl.textContent = fileName(f).replace(/\.[^.]+$/, '');
    row.appendChild(nameEl);
    // ☆ 置顶到前三 / ★ 取消置顶
    const pinEl = document.createElement('span');
    const isPinned = pinnedFiles.includes(f);
    pinEl.className = 'cat-pin' + (isPinned ? ' on' : '');
    pinEl.textContent = isPinned ? '★' : '☆';
    pinEl.title = isPinned ? '取消置顶' : '置顶到默认前三首';
    pinEl.onclick = (e) => { e.stopPropagation(); togglePin(cat.category, f); };
    row.appendChild(pinEl);
    // 删除按钮：移入回收站可找回；管理模式常显，平时悬停显现
    const delEl = document.createElement('span');
    delEl.className = 'cat-track-del';
    delEl.textContent = '✕';
    delEl.title = '从曲库删除（移入回收站）';
    delEl.onclick = (e) => { e.stopPropagation(); confirmDeleteFile('music', f, fileName(f)); };
    row.appendChild(delEl);
    row.title = `${fileName(f)}\n双击播放（单击不播放，避免误触）\n右键可改歌曲名称`;
    // 右键改名：只对用户曲库里的自定义歌曲开放，内置曲库直接说明原因（主进程也会再挡一次）
    row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openRenameTrack(f); };
    // 单击只浏览不播放（触屏/单击误触不再抢播）；双击才点播这一首
    row.ondblclick = (e) => { e.stopPropagation(); engine.playTrack(cat.category, idx); };
    bindTrackDrag(row, cat, idx); // 曲目行长按/竖拖排序
    frag.appendChild(row);
  });
  box.innerHTML = '';
  box.appendChild(frag);
  box.scrollTop = prevScroll;
  // 正在播放的曲目滚入可视区（切歌/刷新后不用手动翻找；已在可视区内则不动）
  requestAnimationFrame(() => {
    const playing = box.querySelector('.cat-track.playing');
    if (playing) playing.scrollIntoView({ block: 'nearest' });
  });
}

/* ---------- 曲目行键盘归类（保留注释位置）：拖动排序实现 ---------- */
let trackDrag = null; // {el, cat, fromIdx, offY, baseRect}

function bindTrackDrag(row, cat, idx) {
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.cat-pin, .cat-track-del')) return; // 星标/删除点击留给各自
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    const timer = setTimeout(() => { dragging = true; startTrackDrag(row, cat, idx, sy); }, 500);
    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragging) {
        // 竖向够大即立即拖（行是竖排的，横排卡片用横轴，行内曲目用竖轴）
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.2) {
          clearTimeout(timer);
          dragging = true;
          startTrackDrag(row, cat, idx, sy);
        } else if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
          clearTimeout(timer); unlisten();
        }
        return;
      }
      moveTrackDrag(ev.clientY);
    };
    const onUp = (ev) => {
      clearTimeout(timer); unlisten();
      if (dragging) finishTrackDrag(ev.clientY, cat);
    };
    const unlisten = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

function startTrackDrag(row, cat, idx, y) {
  const r = row.getBoundingClientRect();
  row.style.width = `${r.width}px`;
  row.classList.add('dragging');
  row.style.top = `${r.top}px`;
  row.style.left = `${r.left}px`;
  trackDrag = { el: row, cat, fromIdx: idx, offY: y - r.top, overEl: null };
}

function moveTrackDrag(y) {
  if (!trackDrag) return;
  trackDrag.el.style.top = `${y - trackDrag.offY}px`;
  // 行列表只查一次：原来 trackTargetAt 与下面各查一次同一个复合选择器
  // （#catCards .cat-track[data-cat=…] 要遍历列表全部子节点，每次 pointermove 扫两遍）
  const rows = $$(`#catCards .cat-track[data-cat="${trackDrag.cat.category}"]`);
  const t = trackTargetAt(y, trackDrag.cat, rows);
  // 只切「上一个高亮行 → 当前目标行」两个元素：原来每帧对同分类所有行 classList.toggle
  // （写样式 → 下一帧整块重排）。行为等价，但每帧只动 1~2 个元素。
  const next = t ? t.el : null;
  if (trackDrag.overEl && trackDrag.overEl !== next) trackDrag.overEl.classList.remove('drag-over');
  if (next) next.classList.add('drag-over');
  trackDrag.overEl = next;
}

function trackTargetAt(y, cat, rowsIn) {
  // 拖拽行离流后其余行会上移，漏击概率高——按「行中线最近」决定插入点，任何 y 都有落点
  const rows = (rowsIn || $$(`#catCards .cat-track[data-cat="${cat.category}"]`)).filter((c) => c !== trackDrag.el);
  if (!rows.length) return null;
  for (const c of rows) {
    const r = c.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (y < mid) return { idx: Number(c.dataset.idx), before: true, el: c };
  }
  const last = rows[rows.length - 1];
  return { idx: Number(last.dataset.idx), before: false, el: last };
}

function finishTrackDrag(y, cat) {
  if (!trackDrag) return;
  const target = trackTargetAt(y, cat);
  const { el, fromIdx } = trackDrag;
  el.classList.remove('dragging');
  el.style.top = el.style.left = el.style.width = '';
  $$(`#catCards .cat-track[data-cat="${cat.category}"]`).forEach((c) => c.classList.remove('drag-over'));
  trackDrag = null;
  suppressClickUntil = Date.now() + 150;

  const from = fromIdx;
  if (target != null && target.idx !== from && from !== -1) {
    const [item] = cat.tracks.splice(from, 1);
    let insertAt = target.before ? target.idx : target.idx + 1;
    if (insertAt > from) insertAt -= 1;
    cat.tracks.splice(Math.max(0, insertAt), 0, item);
    persistTrackOrder(cat.category);
    // 若该分类列表在引擎上，更新播放队列路径保持现状（正在播放的不打断）
    if (engine.category === cat.category) engine.setCategories(state.music);
    toast(`「${cat.category}」曲目顺序已调整`, 'ok');
  }
  renderCategories();
}

/* ---------- 分类排序：应用与持久化 ---------- */
function applyCatOrder() {
  const order = state.config.catOrder || [];
  if (!order.length) return;
  const rank = (c) => {
    const i = order.indexOf(c.category);
    return i === -1 ? order.length + 999 : i; // 新分类排最后
  };
  state.music.sort((a, b) => rank(a) - rank(b));
}

function persistCatOrder() {
  const order = state.music.map((c) => c.category);
  state.config.catOrder = order;
  window.api.invoke('config:save', { catOrder: order });
}

// 设置音乐板块可见分类数量：n>=total 或显式传 0 → 全部显示；最少 1 个
function setCatShowLimit(n) {
  const total = state.music.length;
  if (n > 0) {
    n = Math.max(1, Math.min(n, total));
    if (n >= total) n = 0; // 等于全部时归一化为「全部」
  }
  state.config.catShowLimit = n;
  window.api.invoke('config:save', { catShowLimit: n });
  syncCatShowVal();
  renderCategories();
  toast(n > 0 ? `分类歌单只显示前 ${n} 个：拖动分类行调整顺序，谁在前显示谁` : '分类歌单已设置为显示全部分类', 'ok');
}

// 曲目顺序规则：①用户手工拖出的分类内顺序 > ②置顶曲提前 > ③扫描基准顺序。
// 基准顺序在每次曲库重扫时重新捕获，保证取消置顶/未手工排序时能完整还原。
function applyPinned() {
  const pinned = state.config.catPinned || {};
  const torder = state.config.catTrackOrder || {};
  state.music.forEach((cat) => {
    if (!cat._base || cat._base.length !== cat.tracks.length ||
        !cat.tracks.every((t) => cat._base.includes(t))) {
      cat._base = cat.tracks.slice(); // 曲目集合变化（导入/删除/重扫）→ 新基准
    }
    const trank = new Map(((torder[cat.category]) || []).map((f, i) => [f, i]));
    const prank = new Map(((pinned[cat.category]) || []).map((f, i) => [f, i]));
    const brank = new Map(cat._base.map((f, i) => [f, i]));
    const ord = (f) => trank.has(f) ? trank.get(f) : 1e6 + (brank.get(f) ?? 0); // 手工顺序优先，基准补充
    cat.tracks.sort((a, b) =>
      (prank.has(a) ? prank.get(a) : 1e6) - (prank.has(b) ? prank.get(b) : 1e6) ||
      ord(a) - ord(b));
  });
}

// 保存某分类当前显示的曲目顺序（拖动后持久化）
function persistTrackOrder(category) {
  const cat = state.music.find((c) => c.category === category);
  if (!cat) return;
  const orderMap = { ...(state.config.catTrackOrder || {}) };
  orderMap[category] = cat.tracks.slice();
  state.config.catTrackOrder = orderMap;
  window.api.invoke('config:save', { catTrackOrder: orderMap });
}

// 点 ☆/★ 切换该曲置顶：置顶曲按先后排在卡片最前，默认露前3首
function togglePin(category, file) {
  const pinned = { ...(state.config.catPinned || {}) };
  const list = [...(pinned[category] || [])];
  const i = list.indexOf(file);
  if (i === -1) list.unshift(file); else list.splice(i, 1);
  if (list.length) pinned[category] = list; else delete pinned[category];
  state.config.catPinned = pinned;
  // 空对象走深合并清不掉旧置顶，必须显式发 null
  window.api.invoke('config:save', { catPinned: Object.keys(pinned).length ? pinned : null });
  applyPinned();
  engine.setCategories(state.music);
  renderCategories();
}

/* ---------- 分类行：竖向拖动排序 ---------- */
let dragState = null;      // {el, cat, offY}
let suppressClickUntil = 0; // 拖拽结束后短暂抑制 click，避免误触发播放

function bindCatDrag(el, cat) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 播放钮/导入/删除/输入框保留各自点击，不进拖拽
    if (e.target.closest('button, input, .ci-import, .ci-del, .cat-hidden-tag')) return;
    const sy = e.clientY;
    let dragging = false;
    // 通道一：长按 0.5s 纹丝不动进入拖拽（触屏友好）
    const timer = setTimeout(() => { dragging = true; startCatDrag(el, cat, sy); }, 500);
    const onMove = (ev) => {
      if (!dragging) {
        // 通道二：明显竖向拖动 → 立即进入拖拽（列表竖排，竖移即排列意图）
        if (Math.abs(ev.clientY - sy) > 10) {
          clearTimeout(timer);
          dragging = true;
          startCatDrag(el, cat, sy);
        }
        return;
      }
      moveCatDrag(ev.clientY);
    };
    const onUp = (ev) => {
      clearTimeout(timer); unlisten();
      if (dragging) finishCatDrag(ev.clientY, cat);
    };
    const unlisten = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

function startCatDrag(el, cat, y) {
  const r = el.getBoundingClientRect();
  el.style.width = `${r.width}px`;
  el.classList.add('dragging');
  el.style.top = `${r.top}px`;
  el.style.left = `${r.left}px`;
  dragState = { el, cat, offY: y - r.top };
}

function moveCatDrag(y) {
  if (!dragState) return;
  dragState.el.style.top = `${y - dragState.offY}px`;
  const t = catTargetAt(y);
  $$('#catList .cat-item').forEach((c) => {
    c.classList.toggle('drag-over', !!(t && t.el === c));
  });
}

function catTargetAt(y) {
  // 拖拽行离流后其余行会上移，漏击概率高——按「行中线最近」决定插入点，任何 y 都有落点
  const rows = $$('#catList .cat-item')
    .filter((c) => c !== dragState.el && !c.classList.contains('cat-add-row') && !c.classList.contains('cat-morecard'));
  if (!rows.length) return null;
  for (const c of rows) {
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      return { cat: state.music.find((m) => m.category === c.dataset.cat), before: true, el: c };
    }
  }
  const last = rows[rows.length - 1];
  return { cat: state.music.find((m) => m.category === last.dataset.cat), before: false, el: last };
}

function finishCatDrag(y, cat) {
  if (!dragState) return;
  const target = catTargetAt(y);
  const { el } = dragState;
  el.classList.remove('dragging');
  el.style.top = el.style.left = el.style.width = '';
  $$('#catList .cat-item').forEach((c) => c.classList.remove('drag-over'));
  dragState = null;
  suppressClickUntil = Date.now() + 150;

  const from = state.music.findIndex((c) => c.category === cat.category);
  if (target && target.cat && target.cat.category !== cat.category && from !== -1) {
    const to = state.music.findIndex((c) => c.category === target.cat.category);
    const [item] = state.music.splice(from, 1);
    let insertAt = target.before ? to : to + 1;
    if (insertAt > from) insertAt -= 1;
    state.music.splice(Math.max(0, insertAt), 0, item);
    persistCatOrder();
    toast(`「${cat.category}」已排到第 ${state.music.indexOf(item) + 1} 位`, 'ok');
  }
  renderCategories();
}

/* ---------- 自定义分类：添加 ---------- */
function showAddCategory(cardEl) {
  cardEl.onclick = null;
  cardEl.innerHTML = `
    <input class="cat-input" maxlength="30" placeholder="分类名，如：运动" />
    <button class="icon-btn small" title="确定">✓</button>
    <button class="icon-btn small" title="取消">✕</button>`;
  const input = cardEl.querySelector('.cat-input');
  const [okBtn, cancelBtn] = cardEl.querySelectorAll('.icon-btn');
  input.focus();
  const cancel = () => renderCategories();
  cancelBtn.onclick = (e) => { e.stopPropagation(); cancel(); };
  const submit = async () => {
    const name = input.value.trim();
    if (!name) { cancel(); return; }
    if (state.music.some((c) => c.category === name)) { toast('分类已存在', 'error'); input.focus(); return; }
    const r = await window.api.invoke('music:addCategory', name);
    if (r.ok) {
      state.music = r.music;
      applyCatOrder();
      applyPinned();
      engine.setCategories(state.music);
      renderCategories();
      toast(`已添加分类「${name}」，把音乐放进该文件夹即可`, 'ok');
    } else {
      toast(r.error === 'exists' ? '分类已存在' : '名称含非法字符（不能用 \\ / : * ? " < > |）', 'error');
      input.focus();
    }
  };
  okBtn.onclick = (e) => { e.stopPropagation(); submit(); };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') cancel();
  };
}

/* ---------- 自定义分类：删除（确认弹层） ---------- */
let confirmCb = null;
// 删除失败错误码 → 友好提示（避免给老师看裸的 not-in-library / EPERM）
const DELETE_ERR_TEXT = {
  'bad-args': '参数不对，删除取消',
  'not-in-library': '不在课件/音乐/视频库目录内，不能删除',
  'not-found': '文件已不存在（可能刚被移走）',
  'ppt-presenting': '课件正在放映中：请先退出放映，再删除',
  busy: '文件被占用（PowerPoint 可能还开着它）：请先切换其它课件或退出放映，再删除',
};
// 删除库文件（音乐/视频/课件）：确认弹层 → 移入回收站（误删可找回）
function confirmDeleteFile(kind, file, name) {
  const kindName = { video: '视频', ppt: '课件', music: '音乐' }[kind] || '文件';
  dom.confirmTitle.textContent = `删除${kindName}`;
  dom.confirmText.textContent = `从库中删除「${name}」？文件将移入回收站（误删可从回收站找回）。`;
  dom.confirmOverlay.hidden = false;
  confirmCb = async () => {
    // PPT：先把当前选中切走，避免 renderPptState 又把这份课件「后台预热打开」锁住文件
    const wasSelected = kind === 'ppt' && state.selectedPpt === file;
    if (wasSelected) { state.selectedPpt = ''; renderPptState(); }
    const r = await window.api.invoke('library:deleteFile', { kind, file });
    if (!r || !r.ok) {
      // 失败时把选择还回去（否则用户会以为删成功了，但选区空了）
      if (wasSelected) { state.selectedPpt = file; renderPptState(); }
      const err = (r && r.error) || '未知错误';
      toast(`删除失败：${DELETE_ERR_TEXT[err] || err}`, 'error');
      return;
    }
    if (kind === 'music') {
      state.music = r.music;
      applyCatOrder(); applyPinned(); engine.setCategories(state.music); renderCategories();
    } else if (kind === 'video') {
      state.videos = r.videos; renderVideos();
    } else if (kind === 'ppt') {
      state.ppts = r.ppts; renderPptChips();
      // 顺手清掉「最近使用」里这条失效记录（删掉的文件不再可点）
      if (state.config.recentPpt) {
        state.config.recentPpt = state.config.recentPpt.filter((f) => f !== file);
        renderRecents();
      }
    }
    toast(`已删除「${name}」（回收站可找回）`, 'ok');
  };
}

/* ---------- 重命名歌曲（右键曲目行） ---------- */
const RENAME_ERR_TEXT = {
  builtin: '内置音乐不能改名（内置曲库在安装目录，改了也会被重装覆盖）',
  'not-found': '文件已不存在（可能刚被移走）',
  exists: '同一文件夹里已经有这个名字了',
  busy: '文件正被占用（可能正在播放），稍后再试一次',
  'bad-name': '名称里不能有 \\ / : * ? " < > | 这些字符',
  'reserved-name': '这是 Windows 保留名，换一个吧',
  'too-long': '名字太长了（最多 80 字）',
  empty: '名字不能为空',
  io: '改名失败：文件被占用或没有写入权限',
};
let renameTarget = ''; // 待改名的曲目完整路径
// 是不是用户自己曲库里的文件：路径在音乐文件夹下才算（大小写不敏感，Windows 语义）
function isUserTrack(file) {
  const root = String(state.config.musicDir || '');
  if (!root) return false;
  const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  return norm(file).startsWith(norm(root) + '\\');
}
function openRenameTrack(file) {
  if (!isUserTrack(file)) { toast(RENAME_ERR_TEXT.builtin, 'warn'); return; }
  renameTarget = file;
  const cur = fileName(file).replace(/\.[^.]+$/, '');
  dom.renameInput.value = cur;
  dom.renameTip.textContent = `当前：${cur}　·　扩展名 ${fileName(file).match(/\.[^.]+$/)?.[0] || ''} 保持不变`;
  dom.renameOverlay.hidden = false;
  dom.renameInput.focus();
  dom.renameInput.select();
}
function closeRename() { dom.renameOverlay.hidden = true; renameTarget = ''; }
async function submitRename() {
  const file = renameTarget;
  const name = dom.renameInput.value;
  if (!file) { closeRename(); return; }
  if (!name.trim()) { toast(RENAME_ERR_TEXT.empty, 'warn'); dom.renameInput.focus(); return; }
  const r = await window.api.invoke('music:renameTrack', { file, name });
  if (!r || !r.ok) {
    const err = (r && r.error) || 'io';
    toast(`改名失败：${RENAME_ERR_TEXT[err] || err}`, 'error');
    return; // 弹层不关，让老师改了再试
  }
  closeRename();
  state.music = r.music;
  applyCatOrder(); applyPinned(); engine.setCategories(state.music);
  renderCategories();
  toast(`已改名为「${r.name.replace(/\.[^.]+$/, '')}」`, 'ok');
}

function confirmDeleteCategory(name) {
  dom.confirmTitle.textContent = '删除分类';
  dom.confirmText.textContent = `删除分类「${name}」？对应文件夹将移入回收站（误删可从回收站找回）。`;
  dom.confirmOverlay.hidden = false;
  confirmCb = async () => {
    const r = await window.api.invoke('music:removeCategory', name);
    if (r.ok) {
      state.music = r.music;
      applyCatOrder();
      applyPinned();
      engine.setCategories(state.music);
      if (engine.category === name) {
        engine.pause();
        engine.category = ''; engine.playlist = []; engine.idx = -1;
        engine.emit();
      }
      renderCategories();
      toast(`已删除分类「${name}」`, 'ok');
    } else {
      toast('删除失败：' + (r.error || '未知原因'), 'error');
    }
  };
}

let renderCatsTimer = null; // 音乐状态高频变化时合并重建分类卡（切歌/播放/暂停一帧只渲染一次）
function scheduleRenderCategories() {
  clearTimeout(renderCatsTimer);
  renderCatsTimer = setTimeout(renderCategories, 120);
}

let lastMusicRenderSig = ''; // 音乐状态签名：音量拖动等高频 emit 不再触发整个播放器重建（低性能防抖关键）
let lastPlayIcon = ''; // 播放/暂停图标去抖：只在状态翻转时重写 innerHTML + SVG（PERF-04）
function onMusicState(s) {
  // 播放分类变化时右侧曲目列表自动跟随播放（手动浏览其它分类期间不被调音量等操作抢走）
  if (s.category && s.category !== followedCat) {
    followedCat = s.category;
    selCatView = s.category;
  }
  const sig = `${s.playing}|${s.category}|${s.index}|${s.loopMode}`;
  lastMusicState = s;
  if (sig !== lastMusicRenderSig) {
    lastMusicRenderSig = sig;
    scheduleRenderCategories(); // 播放/暂停/切歌才重建列表（防抖）
    // 以下文案只随「切歌/播放暂停/切分类/切循环」变化，随 sig 一起更新；音量拖动不再重写
    dom.nowTrack.textContent = s.track || (s.playing ? '播放中' : '未在播放');
    const total = state.music.find((c) => c.category === s.category)?.tracks.length || '?';
    dom.nowCat.textContent = s.playing
      ? `分类：${s.category || '—'} · ${s.index + 1}/${total}`
      : s.track ? `已暂停 · ${s.category || ''}` : '选择一个分类开始播放';
    syncLoopBtn(s); // 循环模式按钮文案（含下拉菜单高亮）
  }
  kickProgressLoop(); // 开始播放时唤起进度条循环（空闲时它是停的）
  syncMiniStatus();
  const npEl = document.querySelector('.now-playing');
  if (npEl) {
    npEl.classList.toggle('playing', s.playing);
    npEl.classList.toggle('paused', !s.playing && !!s.track);
  }
  // 曲目行也加 paused 类：暂停时均衡条停止跳动
  // querySelectorAll 返回空 NodeList 时 forEach 不会抛异常，此处无需空值检查
  const trackRows = document.querySelectorAll('.cat-track.playing');
  trackRows.forEach((row) => row.classList.toggle('paused', !s.playing));
  const wantPlayIcon = s.playing ? 'pause' : 'play';
  if (lastPlayIcon !== wantPlayIcon) {
    lastPlayIcon = wantPlayIcon;
    dom.btnPlay.innerHTML = '<span class="ico"></span>';
    Icons.set(dom.btnPlay.querySelector('.ico'), wantPlayIcon, 18);
    if (dom.miniPlay) Icons.set(dom.miniPlay.querySelector('.ico'), wantPlayIcon, 22);
  }
  const volPct = Math.round(s.volume * 100);
  dom.vol.value = volPct;
  dom.vol.style.setProperty('--fill', volPct + '%');
  dom.volVal.textContent = `${volPct}%`;
  syncMuteIcon(s.muted); // 喇叭图标随静音状态切换（静音时不改滑条值，只切图标）
  renderMode();
  window.api.invoke('music:setState', { playing: s.playing, category: s.category, track: s.track, volume: s.volume, loopMode: s.loopMode });
}

// 静音切换：面板喇叭 / F4 / 遥控页「静音」按钮共用同一动作
function toggleMusicMute() {
  const muted = engine.toggleMute();
  showOSD(muted ? '🔇 已静音' : `🔊 ${Math.round(engine.volume * 100)}%`);
  syncMuteIcon(muted);
}

// 喇叭图标：静音显示 volume-x，正常显示 volume-2（只在变化时重绘，避免每帧抖）
function syncMuteIcon(muted) {
  if (!dom.btnMute) return;
  const want = muted ? 'volume-x' : 'volume-2';
  if (dom.btnMute.dataset.ico !== want) {
    dom.btnMute.dataset.ico = want;
    Icons.set(dom.btnMute.querySelector('.ico'), want, 15);
  }
  dom.btnMute.classList.toggle('muted', !!muted);
  dom.btnMute.title = muted ? '取消静音 (F4)' : '静音 (F4)';
}

// 播放冲突仲裁（BUG-A）：视频投放期间音乐不得起播。
// 视频侧是**单向** duck（main/index.js 起播时广播 'music:restore' {action:'duck'}），没有反向互斥；
// 不设这道闸的话，用户按播放键会把刚被 duck 掉的音乐恢复起来，与视频同时出声。
// 注意：PPT 放映**不拦**音乐——那是产品有意为之（main/index.js:390「放映 PPT 不打断音乐」）。
function musicBlocked() {
  if (!state.video.playing) return false;
  toast('视频投放中，请先停止视频再播放音乐', 'warn');
  return true;
}

function handleHotkey(action) {
  switch (action) {
    case 'playPause': if (!musicBlocked()) engine.toggle(); break;
    case 'prev': if (!musicBlocked()) engine.prev(); break;
    case 'next': if (!musicBlocked()) engine.next(); break;
    case 'volUp': nudgeVolume(0.05); break;
    case 'volDown': nudgeVolume(-0.05); break;
    case 'cat1': playCatIndex(0); break;
    case 'cat2': playCatIndex(1); break;
    case 'mute': toggleMusicMute(); break;
    case 'openFull': if (!document.body.classList.contains('led-mode')) toggleDisplayMode(); break;
    case 'exitFull': if (document.body.classList.contains('led-mode')) toggleDisplayMode(); break;
    default: break;
  }
}

function playCatIndex(i) {
  const cat = state.music[i];
  if (!cat) { toast('该分类不存在（曲库为空或只有一类）', 'warn'); return; }
  if (musicBlocked()) return;
  engine.playCategory(cat.category);
}

  function nudgeVolume(delta) {
    // 视频投放中：音量快捷键优先调视频窗口（每按一次 5%）；否则调音乐引擎
    if (state.video.playing) {
      window.api.invoke('video:control', delta > 0 ? 'volUp' : 'volDown');
      showOSD(delta > 0 ? '🔊 视频音量 +5%' : '🔉 视频音量 -5%');
      return;
    }
    // PPT 放映中：音量键已注销（setMediaKeysEnabled(false)），理论上不会执行到此分支
    if (state.ppt.presenting) {
      // 防御性检查：如果意外进入此分支，说明音量键状态与放映状态不一致
      console.warn('[BUG] PPT 放映中不应收到音量键事件（音量键应已注销）');
      return;
    }
    engine.setVolume(Math.min(1, Math.max(0, engine.volume + delta)));
    showOSD(`🔊 音量 ${Math.round(engine.volume * 100)}%`);
  }

/* ---------- 主面板板块：长按拖动排序（顺序持久化到 config.sectionOrder） ---------- */

// 拖动单元 = .content 的直接子面板；视频+音乐并列行（.media-row）整行作为一个单元排序
function sectionUnits() {
  return $$('.content > .panel, .content > .media-row');
}
function unitKey(u) {
  return u.dataset.panel || u.dataset.panelRow || '';
}

// 启动时按保存的顺序重排板块；老配置没记到的板块按默认顺序补在后面
function applySectionOrder() {
  const order = (state.config && state.config.sectionOrder) || [];
  if (!Array.isArray(order) || !order.length) return;
  const byKey = {};
  sectionUnits().forEach((u) => { const k = unitKey(u); if (k) byKey[k] = u; });
  if (!order.some((k) => byKey[k])) return;
  const frag = document.createDocumentFragment();
  order.forEach((k) => { if (byKey[k]) { frag.appendChild(byKey[k]); delete byKey[k]; } });
  Object.values(byKey).forEach((u) => frag.appendChild(u));
  document.querySelector('.content').appendChild(frag);
}

function bindSectionDrag() {
  sectionUnits().forEach((unit) => {
    // 并排行里两个板块头都能发起整行拖动
    unit.querySelectorAll('.panel-head').forEach((head) => {
      head.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('button, input, .chip')) return; // 头部里的按钮照常点击
        const isMouse = e.pointerType === 'mouse';
        const sx = e.clientX, sy = e.clientY;
        let dragging = false;
        // 通道一：长按 0.5s 进入拖拽（触屏友好）
        const timer = setTimeout(() => { dragging = true; startSectionDrag(unit); }, 500);
        const onMove = (ev) => {
          if (!dragging) {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (isMouse) {
              // 通道二（仅鼠标）：竖向拖动立即进入（板块纵向堆叠，竖移才是排列意图）
              if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(timer); dragging = true; startSectionDrag(unit); return; }
            } else if (Math.abs(dy) > 14 && Math.abs(dy) >= Math.abs(dx)) {
              clearTimeout(timer); unlisten(); return; // 触屏竖滑视为滚屏，让位
            }
            if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) * 1.4) { clearTimeout(timer); unlisten(); } // 横移视为误触
            return;
          }
          moveSectionDrag(ev.clientY);
        };
        const onUp = () => { clearTimeout(timer); unlisten(); if (dragging) finishSectionDrag(unit); };
        const unlisten = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    });
  });
}

function startSectionDrag(unit) {
  unit.classList.add('section-dragging');
  document.body.classList.add('section-drag-active');
}

// 实时换位：指针落在哪个板块单元内，按上/下半区插到它前面/后面
function moveSectionDrag(y) {
  const drag = document.querySelector('.content > .section-dragging');
  if (!drag) return;
  for (const u of sectionUnits()) {
    if (u === drag) continue;
    const r = u.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) {
      if (y < r.top + r.height / 2) u.before(drag); else u.after(drag);
      break;
    }
  }
}

function finishSectionDrag(unit) {
  unit.classList.remove('section-dragging');
  document.body.classList.remove('section-drag-active');
  const order = sectionUnits().map(unitKey).filter(Boolean);
  if (state.config) state.config.sectionOrder = order;
  window.api.invoke('config:save', { sectionOrder: order });
}

/* ---------- 音视频行分隔条：拖动调整视频/音乐占比（左右/上下两用），比例持久化 ---------- */
const MEDIA_STACK_MQ = window.matchMedia('(max-width: 960px)');
function applyMediaSplit() {
  const row = document.querySelector('.media-row');
  if (!row) return;
  // 视频板块隐藏时不分栏：音乐板独占整行（列/行模板是内联字面量，这里必须显式收敛）
  if (state.config.videoVisible === false) {
    row.style.gridTemplateColumns = '1fr';
    row.style.gridTemplateRows = '';
    return;
  }
  // Chromium 的 minmax() 内不能用 var()，网格模板由 JS 写内联字面量
  if (MEDIA_STACK_MQ.matches) {
    const vh = Math.round(Number(state.config.mediaSplitV) > 0 ? Number(state.config.mediaSplitV) : 300);
    row.style.gridTemplateColumns = '1fr';
    row.style.gridTemplateRows = `minmax(150px, ${vh}px) 10px minmax(398px, auto)`;
  } else {
    const r = Math.min(0.75, Math.max(0.25, Number(state.config.mediaSplit) || 0.41));
    row.style.gridTemplateColumns = `minmax(280px, ${r}fr) 10px minmax(0, ${Math.round((1 - r) * 10000) / 10000}fr)`;
    row.style.gridTemplateRows = '';
  }
}
MEDIA_STACK_MQ.addEventListener ? MEDIA_STACK_MQ.addEventListener('change', () => applyMediaSplit()) : MEDIA_STACK_MQ.addListener(() => applyMediaSplit());
function initMediaSplit() {
  applyMediaSplit();
  const handle = dom.mediaSplit;
  if (!handle) return;
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch { }
    document.body.classList.add('media-splitting');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applySplitFromPointer(e.clientX, e.clientY);
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('media-splitting');
    applySplitFromPointer(e.clientX, e.clientY, true);
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  function applySplitFromPointer(x, y, persist = false) {
    const row = document.querySelector('.media-row');
    const rect = row.getBoundingClientRect();
    if (!MEDIA_STACK_MQ.matches) {
      // 左右并排：视频列占比 = 指针位置（分隔条 10px 不计入）
      const ratio = Math.min(0.75, Math.max(0.25, (x - rect.left - 5) / (rect.width - 10)));
      row.style.gridTemplateColumns = `minmax(280px, ${Math.round(ratio * 10000) / 10000}fr) 10px minmax(0, ${Math.round((1 - ratio) * 10000) / 10000}fr)`;
      if (persist) { state.config.mediaSplit = Math.round(ratio * 10000) / 10000; window.api.invoke('config:save', { mediaSplit: state.config.mediaSplit }); }
    } else {
      // 上下堆叠：视频区高度（音乐板保持固有最小高度 398px）
      const vh = Math.round(Math.min(Math.max(150, y - rect.top - 5), rect.height - 398 - 10));
      row.style.gridTemplateRows = `minmax(150px, ${vh}px) 10px minmax(398px, auto)`;
      if (persist) { state.config.mediaSplitV = vh; window.api.invoke('config:save', { mediaSplitV: vh }); }
    }
  }
}

/* ---------- 课堂工具显隐（顶栏「工具」按钮，记忆到配置） ---------- */
function applyToolsVisibility() {
  const visible = state.config.toolsVisible !== false; // 缺省显示
  const card = document.querySelector('#toolsCard');
  if (card) card.hidden = !visible;
  const grid = document.querySelector('[data-panel="cast"] .grid-2');
  if (grid) grid.classList.toggle('single', !visible); // 隐藏后 PPT 卡占满整行
  dom.btnTools.classList.toggle('on', visible);
  dom.btnTools.title = visible ? '隐藏课堂工具（计时器）' : '显示课堂工具（计时器）';
}

/* ---------- 视频板块显隐（顶栏「视频」按钮，记忆到配置） ----------
 * 隐藏时视频板与音视频分隔条一并收起，音乐板独占整行。栅格列/行统一由 applyMediaSplit 写，
 * 这里只负责挂 body 类 + 重算比例，避免两处各写一套布局规则互相覆盖。 */
function applyVideoVisibility() {
  const visible = state.config.videoVisible !== false; // 缺省显示
  document.body.classList.toggle('video-hidden', !visible);
  applyMediaSplit(); // 隐藏时收敛为单列，恢复时回到并列/堆叠比例
  if (dom.btnVideo) {
    dom.btnVideo.classList.toggle('on', visible);
    dom.btnVideo.title = visible ? '隐藏视频板块' : '显示视频板块';
  }
}

/* ---------- 投屏 ---------- */
let lastPreopenPpt = ''; // 已触发预打开的课件
let lastPagesPpt = '';   // 已触发全页缩略图导出的课件
let pptPagesTimer = null;
function renderPptState() {
  const p = state.ppt;
  const shownPpt = p.file || state.selectedPpt || '';
  dom.pptFile.textContent = shownPpt ? fileName(shownPpt) : '未选择'; // 只显示文件名，完整路径放悬停提示
  dom.pptFile.title = shownPpt;
  // 当前课件缩略图：与课件库同一张缓存图（有则显示，没有则等 thumb:ready 补）
  const entry = (state.ppts || []).find((x) => x.file === shownPpt);
  if (entry && entry.thumb) {
    dom.pptCurThumb.src = fileUrlImg(entry.thumb);
    dom.pptCurThumb.hidden = false;
  } else {
    dom.pptCurThumb.hidden = true;
  }
  // 选中课件变化：后台预打开 PowerPoint（放映只剩 Run，启动秒级）
  if (shownPpt && shownPpt !== lastPreopenPpt && !p.presenting && !p.loading) {
    lastPreopenPpt = shownPpt;
    if (state.pptUserPicked) window.api.invoke('ppt:preopen', shownPpt).catch(() => { }); // 用户点选后才预热放映
  }
  // 选中（或正在放映的）课件变化：后台导出全部页面缩略图（轨道 + 滑块用）。
  // 延迟 1.2s 再启动：不跟启动/预热抢 COM；已缓存的课件几乎零成本（不启动 PowerPoint）。
  // 放映中也发请求，但主进程只回「已缓存的页」、不导新图 —— 轨道必须跟着正在放的那份课件，
  // 否则点缩略图会跳到另一份课件的页码上。
  // 补导：上次请求撞上「放映中」拿到 0 页时 requested 已被清空，这里在退出放映后重新拉一次，
  // 否则这份课件的缩略图永远出不来（原来是 requested 一次性锁死，切课件再回来才能恢复）。
  const needNew = shownPpt && shownPpt !== lastPagesPpt;
  const needRetry = !p.loading && !p.presenting && railNeedsRetry(shownPpt);
  if (shownPpt && !p.loading && (needNew || needRetry)) {
    lastPagesPpt = shownPpt;
    clearTimeout(pptPagesTimer);
    pptPagesTimer = setTimeout(() => requestPptPages(shownPpt), needRetry ? 600 : 1200);
  }
  dom.btnPresent.disabled = !!p.presenting || !!p.loading;
  dom.btnPresent.textContent = p.loading ? '⏳ 正在打开…' : p.presenting ? '🟢 正在放映中' : '▶ 一键放映 PPT';
  // 不放映/不在打开时：隐藏「退出投屏」按钮（只留放映按钮，面板更干净）；放映中或打开中才出现
  dom.btnExitPresent.hidden = !(p.presenting || p.loading);
  dom.btnExitPresent.disabled = !p.presenting && !p.loading;
  dom.pptFlipRow.style.display = p.presenting ? 'flex' : 'none';
  // 播放条里的 PPT 翻页组：和音乐控制并排，演练时手不用离开底部控制区
  if (dom.npFlip) dom.npFlip.hidden = !p.presenting;
  if (!p.presenting) { dom.presenterStrip.style.display = 'none'; state.pptPage = null; state.pptPages = null; }
  // 放映状态变化 → 刷新缩略图轨道的「可点击跳页」样式与页码高亮
  if (railEls.size) renderPptRail();
  // LED 面板 PPT 按钮同步
  dom.ledPptPresent.textContent = p.presenting ? '✕' : '▶';
  dom.ledPptPresent.title = p.presenting ? '退出放映' : '放映 PPT';
  // 迷你面板 PPT 按钮同步
  if (dom.miniPptPresent) {
    Icons.set(dom.miniPptPresent.querySelector('.ico'), p.presenting ? 'x' : 'presentation', 20);
    dom.miniPptPresent.title = p.presenting ? '退出投屏' : '放映 PPT';
  }
  syncMiniStatus();
}

function renderPresenter(s) {
  if (!s || !s.presenting) { dom.presenterStrip.style.display = 'none'; return; }
  state.pptPage = { position: s.position, total: s.total };
  syncMiniStatus(); // 迷你条同步显示页码
  dom.presenterStrip.style.display = 'flex';
  dom.pptPageInfo.textContent = `第 ${s.position} / ${s.total} 页`;
  if (dom.pptPageBar) dom.pptPageBar.textContent = `${s.position}/${s.total}`;
  // 5 页胶片：主进程翻页即时回报没带 pages 时沿用上一批，仅更新当前页高亮
  if (Array.isArray(s.pages) && s.pages.length) state.pptPages = s.pages;
  renderPptFilm(s.position);
  // 全页轨道：presenter 每翻一页都会导当前页缩略图，顺手并进轨道（放映中不再另起导出）
  if (Array.isArray(s.pages) && s.pages.length && mergeRailPages(s.pages)) renderPptRail();
  scrollRailToPage(s.position); // 全页轨道跟着当前页平移（用户刚拖过滑块则让位）
  dom.pptNotes.textContent = s.notes || '（无备注）';
  dom.pptNextNotes.textContent = s.nextNotes || '（无备注）';
}

// 5 页胶片缩略图：点击任意页跳转（COM Goto，不打断放映）。
// 按页码差量更新 DOM（复用已有 <img>，不整体重建），翻页时只换高亮不重载图片——否则每页都闪一下
const filmEls = new Map(); // page -> { item, img }
function renderPptFilm(position) {
  const pages = state.pptPages || [];
  const box = dom.pptFilm;
  if (!pages.length) {
    // 放映中却一页胶片都没有：原来直接 return，界面上留一个空框，
    // 老师会以为功能坏了。写明「正在生成、退出放映后补齐」——
    // 这里刻意不去 requestPptPages：放映期间主进程本就只读缓存不导出，
    // 每轮 presenter 轮询都重发一次只会反复清空轨道。真正的补导在 renderPptState 里做。
    if (!box.querySelector('.film-empty')) {
      const hint = document.createElement('div');
      hint.className = 'film-empty';
      hint.textContent = '缩略图生成中…（退出放映后自动补齐）';
      box.replaceChildren(hint);
    }
    return;
  }
  // 有页了：清掉空态提示（再交给下面的增量逻辑复用已有 <img>）
  const emptyEl = box.querySelector('.film-empty');
  if (emptyEl) emptyEl.remove();
  const want = new Set(pages.map((p) => p.page));
  for (const [pg, e] of [...filmEls]) {
    if (!want.has(pg)) { e.item.remove(); filmEls.delete(pg); } // 滑出 5 页窗口的页移除
  }
  for (const p of pages) {
    let e = filmEls.get(p.page);
    if (!e) {
      const item = document.createElement('div');
      item.className = 'ppt-film-item';
      item.title = `跳到第 ${p.page} 页`;
      const img = document.createElement('img');
      img.alt = `第 ${p.page} 页`;
      img.decoding = 'async';
      const num = document.createElement('span');
      num.className = 'ppt-film-num mono';
      num.textContent = p.page;
      item.append(img, num);
      item.onclick = () => window.api.invoke('ppt:goto', p.page);
      e = { item, img };
      filmEls.set(p.page, e);
    }
    const url = fileUrlImg(p.img);
    if (e.img.getAttribute('src') !== url) e.img.src = url;
  }
  // 窗口滑动后保持页序；再更新当前页高亮
  const ordered = pages.map((p) => filmEls.get(p.page).item);
  if (ordered.some((el, i) => box.children[i] !== el)) ordered.forEach((el) => box.appendChild(el));
  for (const [pg, e] of filmEls) e.item.classList.toggle('cur', pg === position);
}

function fileUrlImg(p) {
  return encodeURI(`file:///${String(p).replace(/\\/g, '/')}`);
}

/* ---------- 全页缩略图轨道 + 可左右拖动的滑块 ----------
 * 放映时的 5 页胶片只覆盖前后各两页，长课件想找第 40 页得一路翻。这里把「全部页面」缩略图
 * 排成一条横向轨道，下方一个可左右拖动的滑块：拖滑块 = 平移轨道，点缩略图 = 直接跳页。
 * 页面由主进程 ppt:exportAll 在「选中课件且未放映」时后台导出，导一张广播一张，边导边显示。*/
const pptRail = { file: '', pages: [], total: 0, done: false, stopped: false, requested: '', emptyFor: '' };
const railEls = new Map();          // page -> item 元素（增量更新，不整体重建）
let railBarDragging = false;        // 正在拖滑块
let railDrag = null;                // 直接拖缩略图轨道（按住横向拖）
let railAutoUntil = 0;              // 程序化滚动窗口：这段期间的 scroll 事件不算「用户在看」
let railUserAt = 0;                 // 用户最后一次手动滚轨道的时间（此后不自动跟随页码）

function requestPptPages(file) {
  if (!file) return;
  // 已经拿到这份课件的页就别再导（省一次 PowerPoint COM）；
  // 但「请求过却一页都没拿到」必须放行，否则这份课件永远补不上缩略图（判定见 rail-policy.js）
  if (RailPolicy.shouldSkipRequest(pptRail, file)) return;
  pptRail.requested = file;
  pptRail.file = file;
  pptRail.pages = [];
  pptRail.total = 0;
  pptRail.done = false;
  pptRail.stopped = false;
  railEls.clear();
  dom.pptRail.innerHTML = '';
  syncPptRailBar();
  window.api.invoke('ppt:exportAll', file).then((r) => {
    if (pptRail.file !== file) return; // 已经切到别的课件
    // 该平台不支持整页缩略图（macOS 的 AppleScript 没有 exportall 分支）：
    // 静默跳过，不弹英文错误码，也不反复重试
    if (r && r.unsupported) { pptRail.total = 0; pptRail.done = true; renderPptRail(); return; }
    if (!r || !r.ok) {
      pptRail.emptyFor = file; // 失败也算「没拿到」，下次重试
      if (r && r.error && r.error !== 'busy') {
        // 带出主进程回传的 detail：只显示 "open-failed" 用户根本无从下手
        const why = r.detail ? `（${String(r.detail).slice(0, 80)}）` : '';
        toast(`页面缩略图导出失败：${r.error}${why}`, 'warn');
      }
      renderPptRail();
      return;
    }
    pptRail.total = Number(r.total) || 0;
    // 放映打断：已导的页留在轨道上，剩下的下次选中这份课件再补
    if (r.aborted) pptRail.stopped = true;
    // 一页都没拿到（常见于「选中课件后 1.2s 内就点了放映」：主进程走放映分支只读缓存、这次不导出）
    // → 标记待补导，退出放映后自动重来一次；非 PPT/空课件（total=0）不反复重试
    const after = RailPolicy.afterExport(r, pptRail.pages.length);
    pptRail.emptyFor = after.retry ? file : '';
    renderPptRail();
  }).catch(() => { pptRail.emptyFor = file; });
}

// 这份课件是否「请求过但一页都没拿到」——退出放映后需要补导
function railNeedsRetry(file) {
  return RailPolicy.shouldScheduleRequest({
    file,
    presenting: state.ppt.presenting,
    loading: state.ppt.loading,
    emptyFor: pptRail.emptyFor,
    requested: pptRail.requested,
  });
}

// 合并新拿到的页（去重 + 按页码排序）；已导出的页不会因为 presenter 的 5 页窗口而丢
function mergeRailPages(list) {
  if (!list || !list.length) return false;
  const byPage = new Map(pptRail.pages.map((p) => [p.page, p]));
  let added = false;
  for (const p of list) {
    if (p && p.page && !byPage.has(p.page)) added = true;
    if (p && p.page) byPage.set(p.page, p);
  }
  pptRail.pages = Array.from(byPage.values()).sort((a, b) => a.page - b.page);
  return added;
}

function onPptPages(d) {
  if (!d || !d.file || d.file !== pptRail.file) return;
  pptRail.done = !!d.done;
  mergeRailPages(d.pages || []);
  if (pptRail.pages.length) pptRail.emptyFor = ''; // 拿到页了，不用再补导
  renderPptRail();
}

function renderPptRail() {
  const pages = pptRail.pages;
  dom.pptRailWrap.hidden = pages.length === 0;
  if (!pages.length) { railEls.clear(); dom.pptRail.innerHTML = ''; syncPptRailBar(); return; }
  const box = dom.pptRail;
  const have = new Set(pages.map((p) => p.page));
  for (const [pg, el] of [...railEls]) {
    if (!have.has(pg)) { el.remove(); railEls.delete(pg); }
  }
  for (const p of pages) {
    let el = railEls.get(p.page);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ppt-rail-item';
      const img = document.createElement('img');
      img.alt = `第 ${p.page} 页`;
      img.decoding = 'async';
      img.loading = 'lazy'; // 长课件不一次性解码几百张图
      const num = document.createElement('span');
      num.className = 'ppt-film-num mono';
      num.textContent = p.page;
      el.append(img, num);
      el.onclick = () => {
        if (railSuppressClickUntil > Date.now()) return; // 刚拖完轨道，别当成点击
        if (!state.ppt.presenting) { toast('放映中点击缩略图可直接跳到该页', 'info'); return; }
        window.api.invoke('ppt:goto', p.page);
      };
      el.ondragstart = (e) => e.preventDefault();
      railEls.set(p.page, el);
    }
    el.title = state.ppt.presenting ? `跳到第 ${p.page} 页` : `第 ${p.page} 页（放映中可点击跳页）`;
    el.classList.toggle('cur', !!(state.pptPage && state.pptPage.position === p.page));
    el.classList.toggle('off', !state.ppt.presenting);
    const url = fileUrlImg(p.img);
    if (el.firstChild.getAttribute('src') !== url) el.firstChild.src = url;
  }
  // 页序修正：新导出的页追加在尾部，乱序时才整体重排（避免每次广播都重排）
  const ordered = pages.map((p) => railEls.get(p.page));
  if (ordered.some((el, i) => box.children[i] !== el)) {
    const frag = document.createDocumentFragment();
    ordered.forEach((el) => frag.appendChild(el));
    box.appendChild(frag);
  }
  const total = Math.max(pptRail.total || 0, pages.length);
  let info;
  if (pptRail.done) info = `共 ${pages.length} 页`;
  else if (pptRail.stopped) info = `已导出 ${pages.length} 页 · 剩余页下次选中补齐`;
  else if (total > pages.length) info = `导出中 ${pages.length}/${total} 页`;
  else info = `导出中 ${pages.length} 页…`;
  dom.pptRailInfo.textContent = state.ppt.presenting ? `${info} · 点击跳页` : info;
  syncPptRailBar();
  if (state.pptPage) scrollRailToPage(state.pptPage.position);
}

// 放映翻页后把当前页滚进可视区；用户刚手动拖过轨道时不抢他的位置
function scrollRailToPage(page) {
  if (!page) return;
  // 当前页高亮必须每次翻页都更新（不能只等 ppt:pages 广播时才刷，否则放映中轨道一直不高亮）
  for (const [pg, el] of railEls) el.classList.toggle('cur', pg === page);
  const el = railEls.get(page);
  if (!el || railAutoUntil > Date.now() || railUserAt > Date.now() - 2500) return;
  const rail = dom.pptRail;
  const target = el.offsetLeft - Math.max(0, (rail.clientWidth - el.offsetWidth) / 2);
  railAutoUntil = Date.now() + 500; // 这段里的 scroll 事件是程序触发的
  try { rail.scrollTo({ left: Math.max(0, target), behavior: 'smooth' }); }
  catch { rail.scrollLeft = Math.max(0, target); }
  syncPptRailBar();
}

// 自绘滑块：宽度 = 轨道可见比例，位置 = 当前滚动比例（不用系统滚动条，样式统一且好按）
function syncPptRailBar() {
  const rail = dom.pptRail;
  const bar = dom.pptRailBar;
  const thumb = dom.pptRailThumb;
  if (!rail || !bar || !thumb) return;
  const max = rail.scrollWidth - rail.clientWidth;
  const barW = bar.clientWidth;
  if (barW <= 0) return;
  if (max <= 1) { thumb.style.width = '100%'; thumb.style.left = '0px'; thumb.style.opacity = '0.25'; return; }
  thumb.style.opacity = '';
  const w = Math.max(30, Math.round(barW * (rail.clientWidth / rail.scrollWidth)));
  const maxLeft = Math.max(0, barW - w);
  thumb.style.width = `${w}px`;
  thumb.style.left = `${Math.round(maxLeft * (rail.scrollLeft / max))}px`;
}

let railSuppressClickUntil = 0;

function bindPptRail() {
  const rail = dom.pptRail;
  const bar = dom.pptRailBar;

  // 轨道滚动 → 滑块跟着走；程序滚动不记成「用户在看」
  rail.addEventListener('scroll', () => {
    syncPptRailBar();
    if (railAutoUntil < Date.now()) railUserAt = Date.now();
  }, { passive: true });

  // 按住缩略图横向拖动平移轨道（位移超阈值才算拖，避免和「点击跳页」打架）
  rail.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (rail.scrollWidth <= rail.clientWidth) return;
    railDrag = { x: e.clientX, left: rail.scrollLeft, moved: false };
    try { rail.setPointerCapture(e.pointerId); } catch { }
  });
  rail.addEventListener('pointermove', (e) => {
    if (!railDrag) return;
    const dx = e.clientX - railDrag.x;
    if (!railDrag.moved && Math.abs(dx) < 5) return;
    if (!railDrag.moved) { railDrag.moved = true; rail.classList.add('dragging'); }
    railAutoUntil = 0;
    rail.scrollLeft = railDrag.left - dx;
    e.preventDefault();
  });
  const endRailDrag = (e) => {
    if (!railDrag) return;
    if (railDrag.moved) { railSuppressClickUntil = Date.now() + 300; railUserAt = Date.now(); }
    railDrag = null;
    rail.classList.remove('dragging');
    try { rail.releasePointerCapture(e.pointerId); } catch { }
  };
  rail.addEventListener('pointerup', endRailDrag);
  rail.addEventListener('pointercancel', endRailDrag);

  // 滑块：点哪拖哪，全程跟手（滑块中心对准指针）
  const barScrollFromPointer = (e) => {
    const b = bar.getBoundingClientRect();
    const w = dom.pptRailThumb.offsetWidth;
    const maxLeft = Math.max(0, b.width - w);
    const left = Math.min(maxLeft, Math.max(0, e.clientX - b.left - w / 2));
    dom.pptRailThumb.style.left = `${Math.round(left)}px`;
    const max = rail.scrollWidth - rail.clientWidth;
    railAutoUntil = Date.now() + 120; // 拖出来的滚动不算用户翻页
    if (max > 0) rail.scrollLeft = (left / (maxLeft || 1)) * max;
    syncPptRailBar();
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    railBarDragging = true;
    bar.classList.add('dragging');
    try { bar.setPointerCapture(e.pointerId); } catch { }
    barScrollFromPointer(e);
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => { if (railBarDragging) barScrollFromPointer(e); });
  const endBarDrag = (e) => {
    if (!railBarDragging) return;
    railBarDragging = false;
    bar.classList.remove('dragging');
    railUserAt = Date.now();
    try { bar.releasePointerCapture(e.pointerId); } catch { }
  };
  bar.addEventListener('pointerup', endBarDrag);
  bar.addEventListener('pointercancel', endBarDrag);

  window.addEventListener('resize', syncPptRailBar);
}

function renderRecents() {
  const box = dom.pptRecents;
  const frag = document.createDocumentFragment();
  (state.config.recentPpt || []).slice(0, 3).forEach((f) => {
    const chip = document.createElement('span');
    chip.className = 'recent-chip' + (f === state.selectedPpt ? ' sel' : '');
    chip.title = `${f}\n点击选用 · ✕ 从最近列表移除`;
    const nm = document.createElement('span');
    nm.className = 'rc-name';
    nm.textContent = fileName(f);
    chip.appendChild(nm);
    // ✕ 从最近使用列表移除（仅清记录，不删文件）
    const rx = document.createElement('span');
    rx.className = 'recent-chip-del';
    rx.textContent = '✕';
    rx.title = '从「最近使用」移除（不删文件）';
    rx.onclick = (e) => {
      e.stopPropagation();
      state.config.recentPpt = (state.config.recentPpt || []).filter((x) => x !== f);
      window.api.invoke('config:save', { recentPpt: state.config.recentPpt });
      if (state.selectedPpt === f) { state.selectedPpt = (state.config.recentPpt[0]) || ''; renderPptState(); }
      renderRecents();
    };
    chip.appendChild(rx);
    chip.onclick = () => { state.selectedPpt = f; state.pptUserPicked = true; renderRecents(); renderPptState(); };
    frag.appendChild(chip);
  });
  box.innerHTML = '';
  box.appendChild(frag);
}

function renderDisplays() {
  const n = state.displays.length;
  const proj = state.displays.find((d) => d.isProjection);
  const target = proj || state.displays.find((d) => !d.isPrimary);
  dom.stDisp.textContent = n > 1
    ? `显示器：教师屏0 + 投影屏${target ? target.index : '?'}`
    : `显示器：仅 1 块${(n > 0 && state.displays[0].isPrimary ? '（主屏）' : '')}`;
  if (n > 1) {
    dom.dispInfo.textContent = `已接 ${n} 块屏 · 投屏目标：${target ? target.label : '未知'}（智能识别）`;
  } else {
    dom.dispInfo.textContent = '仅检测到 1 块屏：PPT/视频将用本机屏幕（插上投影线并「一键扩展模式」后可投到第二块屏）';
  }
  renderDispSelect();
}

// 投屏目标屏下拉：默认「自动识别」，可手动固定到某一块（多屏/扩展屏位置乱时用）
function renderDispSelect() {
  const sel = dom.dispSelect;
  if (!sel) return;
  const cur = String((state.config.display && state.config.display.projectionId) || 0);
  const opts = ['<option value="0">自动识别（推荐）</option>'];
  for (const d of state.displays) {
    const mark = d.isPrimary ? '主屏' : (d.internal ? '内置副屏' : '外接屏');
    opts.push(`<option value="${d.id}">${d.label} · ${mark}</option>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = cur;
  sel.disabled = state.displays.length < 2;
  sel.title = state.displays.length < 2
    ? '只有一块屏：先接投影线并切到扩展模式，才能指定投屏目标'
    : 'PPT / 视频 / 计时统一投到这块屏；默认由系统智能识别外接屏';
}

function renderOffice() {
  const o = state.office;
  if (!o) { dom.stOffice.textContent = 'Office：检测中…'; return; }
  const name = o.officeName || '未检测到';
  // 未装 Office 在教室机上是常态而非故障，用黄色警示而非红色错误
  const cls = o.officeName ? 'ok' : 'warn';
  dom.stOffice.innerHTML = `Office：<span class="dot ${cls}"></span>${name}${o.powerpoint && o.wps ? '（WPS 备用）' : ''}`;
}

function renderMode() {
  const el = dom.stMode;
  const key = state.ppt.presenting ? 'ppt' : state.video.playing ? 'video' : engine.playing ? 'music' : 'idle';
  if (el.dataset.mode === key) return; // 状态没变不重写 innerHTML（PERF-04：音量拖动每帧都走这里）
  el.dataset.mode = key;
  if (key === 'ppt') el.innerHTML = `<i class="dot busy"></i>PPT 放映中`;
  else if (key === 'video') el.innerHTML = state.video.kind === 'img'
    ? `<i class="dot busy"></i>图片投放中`
    : `<i class="dot busy"></i>视频投放中`;
  else if (key === 'music') el.innerHTML = `<i class="dot ok"></i>音乐播放中`;
  else el.innerHTML = `<i class="dot"></i>空闲`;
}

/* ---------- 视频 ---------- */
// 只补一张芯片的缩略图（thumb:ready 用），替代原先每次缩略图就绪都整列表重建
function updateChipThumb(kind, file, thumb) {
  const box = kind === 'video' ? dom.videoChips : dom.pptChips;
  if (!box) return;
  for (const el of box.children) {
    if (el.dataset && el.dataset.file === file) {
      const holder = el.querySelector('.v-thumb');
      if (!holder) return;
      holder.classList.remove('ph');
      holder.innerHTML = `<img src="${fileUrl_(thumb)}" alt="" loading="lazy" decoding="async">`;
      return;
    }
  }
}

function renderVideos() {
  const box = dom.videoChips;
  if (!state.videos.length) {
    box.innerHTML = `<span class="dim" style="font-size:12px">媒体库为空：把 MP4 或图片（JPG/PNG…）放进视频文件夹，或点「添加视频」</span>`;
    return;
  }
  const frag = document.createDocumentFragment();
  state.videos.forEach((v) => {
    const isImg = v.kind === 'img';
    const el = document.createElement('div');
    el.className = 'video-chip sortable-chip' + (state.video.playing && state.video.file === v.file ? ' playing' : '')
      + (isImg ? ' is-img' : '');
    el.dataset.file = v.file;
    el.dataset.kind = isImg ? 'img' : 'video';
    // 缩略图：生成好了显示首帧（图片即自身），没好显示占位符（异步生成后 thumb:ready 补图）
    const thumb = v.thumb
      ? `<div class="v-thumb"><img src="${fileUrl_(v.thumb)}" alt="" loading="lazy" decoding="async"></div>`
      : `<div class="v-thumb ph"><span class="ico"></span></div>`;
    el.innerHTML = `${thumb}<div class="v-name">${esc(v.name)}</div><div class="v-size">${isImg ? '图片' : fmtSize(v.size)}</div>`;
    if (!v.thumb) Icons.set(el.querySelector('.v-thumb.ph .ico'), isImg ? 'fullscreen' : 'film', 20);
    el.title = isImg ? `${v.file}\n点击整屏投放这张图片 · 左右翻图 / 自动轮播 · 长按拖动可排序`
      : `${v.file}\n点击播放 · 长按拖动可排序`;
    // 删除按钮：悬停卡片右上角显现，移入回收站可找回
    const vdel = document.createElement('span');
    vdel.className = 'chip-del';
    vdel.title = '从媒体库删除（移入回收站）';
    vdel.textContent = '✕';
    vdel.onclick = (e) => { e.stopPropagation(); confirmDeleteFile('video', v.file, v.name); };
    el.appendChild(vdel);
    el.onclick = () => { if (Date.now() >= chipSuppressUntil) playVideo(v.file); };
    bindChipSort(el, state.videos, 'videoOrder', '#videoChips', renderVideos);
    frag.appendChild(el);
  });
  box.innerHTML = '';
  box.appendChild(frag);
}

// 课件库：点选为当前课件，长按拖动排序（与视频库同一套交互）
function renderPptChips() {
  const box = dom.pptChips;
  if (!box) return;
  if (!state.ppts || !state.ppts.length) {
    box.innerHTML = `<span class="dim" style="font-size:12px">课件库为空：把 PPT/PDF/Word/Excel/图片 放进课件文件夹（设置里可改位置）</span>`;
    return;
  }
  const frag = document.createDocumentFragment();
  state.ppts.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'ppt-chip sortable-chip' + (state.selectedPpt === p.file ? ' sel' : '');
    el.dataset.file = p.file;
    // 缩略图：PowerPoint COM 导第 1 页；没生成好显示占位符
    const thumb = p.thumb
      ? `<div class="v-thumb"><img src="${fileUrl_(p.thumb)}" alt="" loading="lazy" decoding="async"></div>`
      : `<div class="v-thumb ph"><span class="ico"></span></div>`;
    el.innerHTML = `${thumb}<div class="v-name">${esc(p.name)}</div>`;
    if (!p.thumb) Icons.set(el.querySelector('.v-thumb.ph .ico'), 'presentation', 20);
    el.title = `${p.file}\\n点选为当前课件 · 长按拖动可排序`;
    // 删除按钮：悬停卡片右上角显现，移入回收站可找回
    const pdel = document.createElement('span');
    pdel.className = 'chip-del';
    pdel.title = '从课件库删除（移入回收站）';
    pdel.textContent = '✕';
    pdel.onclick = (e) => { e.stopPropagation(); confirmDeleteFile('ppt', p.file, p.name); };
    el.appendChild(pdel);
    el.onclick = () => {
      if (Date.now() < chipSuppressUntil) return;
      state.selectedPpt = p.file;
      state.pptUserPicked = true; // 用户点选后才预热 PowerPoint（放映提速）
      state.config.recentPpt = [p.file, ...(state.config.recentPpt || []).filter((x) => x !== p.file)];
      renderRecents(); renderPptState(); renderPptChips();
    };
    bindChipSort(el, state.ppts, 'pptOrder', '#pptChips', renderPptChips);
    frag.appendChild(el);
  });
  box.innerHTML = '';
  box.appendChild(frag);
}

/* 芯片长按拖动排序（视频库/课件库共用）：
 * 长按 0.5s 或明显横移进入拖拽；竖移视为滚屏让位；落点按指针悬停的芯片中线前/后插入 */
let chipDrag = null; // {el, list, orderKey, containerSel, rerender, offX, offY}
let chipSuppressUntil = 0; // 拖拽结束后短暂抑制 click，避免误触播放/选中

function bindChipSort(el, list, orderKey, containerSel, rerender) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.chip-del')) return; // 删除按钮点击不进拖拽
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    const begin = () => {
      const r = el.getBoundingClientRect();
      el.style.width = `${r.width}px`;
      el.classList.add('chip-dragging');
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      dragging = true;
      chipDrag = { el, list, orderKey, containerSel, rerender, offX: sx - r.left, offY: sy - r.top };
    };
    const timer = setTimeout(begin, 500);
    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragging) {
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) { clearTimeout(timer); begin(); }
        else if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(timer); unlisten(); }
        return;
      }
      chipDrag.el.style.left = `${ev.clientX - chipDrag.offX}px`;
      chipDrag.el.style.top = `${ev.clientY - chipDrag.offY}px`;
      const t = chipDropTarget(ev.clientX, ev.clientY);
      $$(chipDrag.containerSel + ' .sortable-chip').forEach((c) => {
        c.classList.toggle('drag-over', !!(t && t.el === c));
      });
    };
    const onUp = (ev) => {
      clearTimeout(timer); unlisten();
      if (dragging) finishChipSort(ev.clientX, ev.clientY);
    };
    const unlisten = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

function chipDropTarget(x, y) {
  if (!chipDrag) return null;
  // 拖拽芯片离流后其余芯片会移位，严格矩形命中会产生空档漏击——按「中心点最近」定落点
  const chips = $$(chipDrag.containerSel + ' .sortable-chip').filter((c) => c !== chipDrag.el);
  let best = null, bestD = Infinity;
  for (const c of chips) {
    const r = c.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d2 = (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (d2 < bestD) { bestD = d2; best = { el: c, before: x < cx }; }
  }
  return best;
}

function finishChipSort(x, y) {
  if (!chipDrag) return;
  const d = chipDrag;
  const t = chipDropTarget(x, y);
  chipDrag = null;
  d.el.classList.remove('chip-dragging');
  d.el.style.left = d.el.style.top = d.el.style.width = '';
  $$(d.containerSel + ' .sortable-chip').forEach((c) => c.classList.remove('drag-over'));
  chipSuppressUntil = Date.now() + 200;

  if (!t) { d.rerender(); return; }
  const from = d.list.findIndex((v) => v.file === d.el.dataset.file);
  const to = d.list.findIndex((v) => v.file === t.el.dataset.file);
  if (from === -1 || to === -1 || from === to) { d.rerender(); return; }
  const [item] = d.list.splice(from, 1);
  let insertAt = t.before ? to : to + 1;
  if (insertAt > from) insertAt -= 1;
  d.list.splice(Math.max(0, insertAt), 0, item);
  const order = d.list.map((v) => v.file);
  state.config[d.orderKey] = order;
  window.api.invoke('config:save', { [d.orderKey]: order });
  d.rerender();
  toast('顺序已保存', 'ok');
}

function renderVideoState() {
  const isImg = state.video.kind === 'img';
  dom.btnStopVideo.disabled = !state.video.playing;
  // 视频播的是视频控件，图片播的是翻图/轮播控件：两排按钮只显示当前这排
  dom.videoRemote.style.display = state.video.playing && !isImg ? 'flex' : 'none';
  dom.videoImageRemote.style.display = state.video.playing && isImg ? 'flex' : 'none';
  // 进度条只在投放中显示；停播时归零，下次起播从 0:00 开始（不复用上一部的进度）
  dom.videoProgress.hidden = !state.video.playing || isImg;
  if (isImg) {
    const n = state.video.count || 1;
    const i = Math.max(0, state.video.index || 0);
    dom.imgPageInfo.textContent = `${i + 1} / ${n}`;
    dom.btnIAutoText.textContent = `自动轮播：${state.video.auto ? '开' : '关'}`;
    dom.btnIAuto.classList.toggle('on', !!state.video.auto);
    dom.btnIWinText.textContent = state.video.windowed ? '切为全屏' : '切为窗口';
  }
  if (!state.video.playing) {
    vpDur = 0;
    vpLast = null;
    setVideoProgressUI(0);
    dom.videoTimeNow.textContent = '0:00';
    dom.videoTimeAll.textContent = '0:00';
    dom.videoPlayState.textContent = '';
  }
  const mode = state.video.windowed ? '窗口模式' : '全屏投放';
  const kindText = isImg ? '图片投放' : '视频投放';
  dom.videoHint.textContent = state.video.playing ? `${kindText}：${fileName(state.video.file)}（${mode}）` : '';
  if (dom.btnVWinText) dom.btnVWinText.textContent = state.video.windowed ? '切为全屏' : '切为窗口';
  // LED 面板视频按钮同步
  dom.ledVToggle.textContent = state.video.playing ? '⏸' : '▶';
  syncVideoChipsPlaying(); // 只同步播放态 class，不再整列表重建（PERF-03）
}

/* ---------- 视频进度条（面板侧） ----------
 * 视频播在投影屏的另一个窗口里，老师手上只有控制面板：进度必须由播放窗回报过来才看得见。
 * 拖动跳转也反过来走同一条链路：面板 → 主进程 → 播放窗（LED 内联模式面板自己就是播放器，直接本地 seek）。*/
let vpDur = 0;        // 总时长（秒）
let vpDragging = false;
let vpLast = null;    // 最近一次进度回报（LED 内联模式直接读本地 <video>，不经过播放窗）

function fmtSec(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setVideoProgressUI(ratio) {
  const pct = `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(2)}%`;
  dom.videoFill.style.width = pct;
  dom.videoKnob.style.left = pct;
}

// 播放窗回报 / LED 内联 video 的 timeupdate 都走这里
function renderVideoProgress(p) {
  if (!p) return;
  vpLast = p;
  if (!dom.videoProgress || dom.videoProgress.hidden) return;
  vpDur = Number(p.d) || 0;
  const ratio = vpDur > 0 ? Math.max(0, Math.min(1, (Number(p.t) || 0) / vpDur)) : 0;
  if (!vpDragging) {
    setVideoProgressUI(ratio);
    dom.videoTimeNow.textContent = fmtSec(ratio * vpDur);
  }
  dom.videoTimeAll.textContent = vpDur > 0 ? fmtSec(vpDur) : '--:--';
  dom.videoPlayState.textContent = p.p ? '⏸ 已暂停' : '▶ 播放中';
}

// 拖动：先跟手更新 UI，松手才真正 seek —— 拖动途中每帧都发 seek 会把视频解码器打爆（每 seek 一次就要重解码）
function videoSeekRatioFromPointer(e) {
  const rect = dom.videoSeek.getBoundingClientRect();
  if (!rect.width) return null;
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  setVideoProgressUI(ratio);
  dom.videoTimeNow.textContent = fmtSec(ratio * vpDur);
  return ratio;
}

function commitVideoSeek(ratio) {
  if (vpDur <= 0) return;
  const t = ratio * vpDur;
  // LED 模式：视频就播在面板自己的 <video> 上，直接本地 seek，不绕 IPC
  if (document.body.classList.contains('led-mode') && dom.ledVideo.src) {
    dom.ledVideo.currentTime = t;
    return;
  }
  window.api.invoke('video:seek', { t }).catch(() => {});
}

function bindVideoProgress() {
  dom.videoSeek.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (vpDur <= 0) return;
    vpDragging = true;
    dom.videoSeek.classList.add('dragging');
    try { dom.videoSeek.setPointerCapture(e.pointerId); } catch { }
    videoSeekRatioFromPointer(e);
    e.preventDefault();
  });
  dom.videoSeek.addEventListener('pointermove', (e) => {
    if (!vpDragging) return;
    videoSeekRatioFromPointer(e);
  });
  const endDrag = (e) => {
    if (!vpDragging) return;
    vpDragging = false;
    dom.videoSeek.classList.remove('dragging');
    try { dom.videoSeek.releasePointerCapture(e.pointerId); } catch { }
    const ratio = videoSeekRatioFromPointer(e); // 松手位置 = 最终目标
    if (ratio != null) commitVideoSeek(ratio);
  };
  dom.videoSeek.addEventListener('pointerup', endDrag);
  dom.videoSeek.addEventListener('pointercancel', endDrag);
  dom.videoSeek.addEventListener('lostpointercapture', () => { vpDragging = false; dom.videoSeek.classList.remove('dragging'); });

  // LED 内联播放：进度直接来自面板自己的 <video>（没有第二个播放窗可回报）
  const ledTick = () => {
    if (!document.body.classList.contains('led-mode') || !state.video.playing) return;
    const v = dom.ledVideo;
    renderVideoProgress({ t: v.currentTime, d: isFinite(v.duration) ? v.duration : 0, p: v.paused ? 1 : 0 });
  };
  dom.ledVideo.addEventListener('timeupdate', ledTick);
  dom.ledVideo.addEventListener('play', ledTick);
  dom.ledVideo.addEventListener('pause', ledTick);
  dom.ledVideo.addEventListener('loadedmetadata', ledTick);
  dom.ledVideo.addEventListener('seeked', ledTick);
}

// 只切换各视频芯片的 playing 高亮，不重建 DOM（video:state 每次广播都会走到这里）
function syncVideoChipsPlaying() {
  const box = dom.videoChips;
  if (!box) return;
  for (const el of box.children) {
    if (el.dataset && el.dataset.file) {
      el.classList.toggle('playing', !!(state.video.playing && state.video.file === el.dataset.file));
    }
  }
}

async function playVideo(file) {
  const r = await window.api.invoke('video:play', file);
  if (r.ok) { state.video = { playing: true, file }; renderVideoState(); renderMode(); }
}

/* ---------- 事件绑定 ---------- */
function bindUI() {
  dom.btnPlay.onclick = () => { if (!musicBlocked()) engine.toggle(); };
  dom.btnPrev.onclick = () => { if (!musicBlocked()) engine.prev(); };
  dom.btnNext.onclick = () => { if (!musicBlocked()) engine.next(); };
  dom.btnLoop.onclick = (e) => { e.stopPropagation(); if (loopMenuEl) closeLoopMenu(); else openLoopMenu(); };
  // 「播放全部」：从第一首开始播当前选中分类（正在播该分类时再点=暂停/继续）
  dom.btnPlayCat.onclick = () => {
    const cat = state.music.find((c) => c.category === selCatView);
    if (!cat) return;
    if (musicBlocked()) return;
    if (!engine.playCategory(cat.category)) {
      toast(`「${cat.category}」还没有音乐，把 MP3/WAV 放进对应文件夹即可`, 'warn');
    }
  };

  // 模式切换
  dom.btnMode.onclick = () => toggleDisplayMode();

  // LED 浮动控制条
  dom.ledDockToggle.onclick = () => {
    const p = dom.ledPanel;
    p.style.display = p.style.display === 'none' ? 'flex' : 'none';
  };
  // LED 模式下顶栏整体隐藏，出口只能放在悬浮条上
  dom.ledModeBack.onclick = () => toggleDisplayMode();
  dom.ledPptPrev.onclick = () => window.api.invoke('ppt:prev');
  dom.ledPptNext.onclick = () => window.api.invoke('ppt:next');
  dom.ledPptPresent.onclick = () => {
    if (state.ppt.presenting) window.api.invoke('ppt:exit');
    else window.api.invoke('ppt:present', state.selectedPpt);
  };
  dom.ledVBack.onclick = () => window.api.invoke('video:control', 'back');
  dom.ledVToggle.onclick = () => window.api.invoke('video:control', 'toggle');
  dom.ledVFwd.onclick = () => window.api.invoke('video:control', 'fwd');
  dom.ledVStop.onclick = () => window.api.invoke('video:stop');
  dom.ledVPick.onclick = async () => {
    const r = await window.api.invoke('video:openDialog');
    if (!r || r.canceled) return;
    state.videos = r.videos || state.videos;
    renderVideos();
    toast(r.imported
      ? `已添加 ${r.imported} 个视频到视频库${r.transcoded ? `（含转码 ${r.transcoded} 个）` : ''}`
      : '所选视频已在视频库中', r.imported ? 'ok' : 'info');
  };

  // LED 模式下视频结束自动回到待机
  // 注意守卫：<video> 的 src 被置空、或指向非媒体文件（如误设为页面自身 URL）时，
  // Chromium 同样会抛 error（code 4 SRC_NOT_SUPPORTED）。非 LED 模式下把这个 error
  // 当成播放失败处理，会越权把 LED 待机画面盖到控制面板上（本次修复引入的回归）。
  // 所以两个 handler 都必须先确认确实处于 LED 投放中。
  dom.ledVideo.addEventListener('ended', () => {
    dom.ledVideo.hidden = true;
    if (document.body.classList.contains('led-mode')) dom.ledIdle.hidden = false;
    window.api.invoke('video:notifyEnded');
  });
  dom.ledVideo.addEventListener('error', () => {
    if (!document.body.classList.contains('led-mode')) return; // 空源/非媒体源不算播放失败
    dom.ledVideo.hidden = true;
    dom.ledIdle.hidden = false;
    window.api.invoke('video:notifyEnded');
  });

  // 无线投屏
  bindCast();

  // 顶栏「工具」：显示/隐藏投屏面板里的课堂工具卡
  dom.btnTools.onclick = () => {
    state.config.toolsVisible = state.config.toolsVisible === false; // false→true / 其他→false
    window.api.invoke('config:save', { toolsVisible: state.config.toolsVisible !== false });
    applyToolsVisibility();
  };

  // 顶栏「视频」：显示/隐藏整个视频板块（隐藏后音乐板占满整行）
  dom.btnVideo.onclick = () => {
    state.config.videoVisible = state.config.videoVisible === false; // false→true / 其他→false
    const on = state.config.videoVisible !== false;
    window.api.invoke('config:save', { videoVisible: on });
    applyVideoVisibility();
    toast(on ? '视频板块已显示' : '视频板块已隐藏，点顶栏「视频」恢复', 'info');
  };

  // 音乐管理模式开关：点亮后各分类出现「＋」添加、曲目/分类的 ✕ 删除常显、可长按拖动排序
  dom.btnAddMode.onclick = () => {
    state.addMode = !state.addMode;
    dom.btnAddMode.classList.toggle('on', state.addMode);
    document.body.classList.toggle('manage-mode', state.addMode);
    if (state.addMode) toast('管理模式已开启：✕ 删除 · ＋ 添加 · 长按拖动排序；再点「管理音乐」退出', 'info');
    syncCatShowVal();
    renderCategories();
  };

  // 分类显示数量：0=全部；N=只显示排序后的前 N 个（最少 1）。歌单栏头 −/＋ 随时调节（默认 3 个）
  dom.btnCatShowMinus.onclick = () => {
    const cur = Math.max(0, Number(state.config.catShowLimit) || 0);
    setCatShowLimit(cur === 0 ? state.music.length - 1 : cur - 1); // 「全部」时 − → 少显示一个
    catListExpanded = false;
  };
  dom.btnCatShowPlus.onclick = () => {
    const cur = Math.max(0, Number(state.config.catShowLimit) || 0);
    setCatShowLimit(cur === 0 ? 1 : cur + 1); // 「全部」时 ＋ → 从只显示 1 个开始收起
    catListExpanded = false;
  };
  syncCatShowVal();

  // 欢迎屏：打开设置弹窗
  dom.btnWelcome.onclick = () => openWelcome();
  dom.btnCloseWelcome.onclick = () => closeWelcome();
  dom.welcomeOverlay.onclick = (e) => { if (e.target.id === 'welcomeOverlay') closeWelcome(); };
  bindWelcome();
  bindMini();

  // 音量滑条防抖（rAF 合并连续 input 事件）
  let volRAF = null;
  dom.vol.oninput = (e) => {
    const val = Number(e.target.value);
    if (volRAF) cancelAnimationFrame(volRAF);
    volRAF = requestAnimationFrame(() => engine.setVolume(val / 100));
  };

  // 喇叭按钮：静音 / 取消静音
  dom.btnMute.onclick = () => toggleMusicMute();

  // 进度条：点击跳转 + 按住拖动跳转（pointer 捕获，拖出元素也能继续跟手）
  // 原来只有 onclick：拖动不跟手，老师反映「播放时长调不动」
  const seekFromPointer = (e) => {
    const ch = engine.channels[engine.active];
    const el = ch && ch.el;
    if (!el || !isFinite(el.duration) || !el.duration) return false;
    const rect = dom.npProgress.getBoundingClientRect();
    if (!rect.width) return false;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * el.duration;
    // 拖动即时反馈（rAF 循环 250ms 节流会跟上，但拖动时让它立刻反映，不滞后）
    dom.npFill.style.width = `${ratio * 100}%`;
    if (dom.npKnob) dom.npKnob.style.left = `${ratio * 100}%`;
    return true;
  };
  let progDragging = false;
  dom.npProgress.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!seekFromPointer(e)) return;
    progDragging = true;
    dom.npProgress.classList.add('dragging');
    try { dom.npProgress.setPointerCapture(e.pointerId); } catch { }
    e.preventDefault(); // 防止拖出选中文本/抢焦点，且避免后续触发多余的 click
  });
  dom.npProgress.addEventListener('pointermove', (e) => {
    if (!progDragging) return;
    seekFromPointer(e);
  });
  const endProgDrag = (e) => {
    if (!progDragging) return;
    progDragging = false;
    dom.npProgress.classList.remove('dragging');
    try { dom.npProgress.releasePointerCapture(e.pointerId); } catch { }
  };
  dom.npProgress.addEventListener('pointerup', endProgDrag);
  dom.npProgress.addEventListener('pointercancel', endProgDrag);

  // Esc：关确认弹层 / 关设置弹窗 / 退出放映中的 PPT / 停止视频投放 / 关 LED 欢迎屏（兜底）；~：切 LED 全屏。
  // 这两键只在本窗口有焦点时生效：不注册为全局快捷键（否则会吞掉 PPT 全屏放映的 Esc），
  // ~ 在输入框里打字时不触发（避免误切全屏）。
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~') {
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      // `/~ 只在 openFull 仍是默认键位时生效；已改键到别处则由全局快捷键接管，避免新旧两键同时生效
      const acc = (state.config.hotkeys.openFull || '').toLowerCase();
      if (!typing && (acc === '`' || acc === '~' || acc === 'grave' || acc === 'backquote')) handleHotkey('openFull');
      return;
    }
    // 空格：播放/暂停（本窗口内生效）。输入框打字不触发；放映 PPT 时空格让位给放映软件。
    // preventDefault 防页面滚动，也防焦点按钮被空格二次激活造成双重切换
    if (e.code === 'Space') {
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (!typing && !state.ppt.presenting && !state.ppt.loading) {
        e.preventDefault();
        if (!engine.toggle()) showOSD('先在音乐板块选个分类开始播放');
      }
      return;
    }
    // 放映中 ↑/↓（及 PgUp/PgDn）直接翻页：面板全屏、窗口、迷你形态都生效；
    // 放映窗口自身有焦点时 PowerPoint/WPS 原生就支持 ↑/↓ 翻页，无需处理
    if (state.ppt.presenting && !state.ppt.loading && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown')) {
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (!typing) {
        e.preventDefault();
        window.api.invoke(e.key === 'ArrowDown' || e.key === 'PageDown' ? 'ppt:next' : 'ppt:prev');
        return;
      }
    }
    if (e.key !== 'Escape') return;
    if (loopMenuEl) { closeLoopMenu(); return; }
    if (!dom.renameOverlay.hidden) { closeRename(); return; }
    if (!dom.confirmOverlay.hidden) { dom.confirmOverlay.hidden = true; confirmCb = null; return; }
    if (!dom.castOverlay.hidden) { dom.castOverlay.hidden = true; return; }
    if (!dom.remoteOverlay.hidden) { dom.remoteOverlay.hidden = true; return; }
    if (!dom.settingsOverlay.hidden) { closeSettings(); return; }
    if (wlIsOpen) { window.api.invoke('welcome:toggle'); return; }
    // 放映中焦点落在面板上时，Esc 会被面板吃掉、放映窗口收不到 → 表现为「按 Esc 退不出全屏」。
    // 这里转为退出投屏（走 COM 退放映），与放映窗口自身的原生 Esc 行为保持一致
    if (state.ppt.presenting || state.ppt.loading) { window.api.invoke('ppt:exit'); return; }
    if (state.video.playing) window.api.invoke('video:stop');
    if (document.body.classList.contains('led-mode')) handleHotkey('exitFull');
  });

  // 确认弹层按钮
  dom.btnConfirmOk.onclick = async () => {
    dom.confirmOverlay.hidden = true;
    if (confirmCb) { const cb = confirmCb; confirmCb = null; await cb(); }
  };
  dom.btnConfirmCancel.onclick = () => { dom.confirmOverlay.hidden = true; confirmCb = null; };
  dom.confirmOverlay.onclick = (e) => { if (e.target.id === 'confirmOverlay') { dom.confirmOverlay.hidden = true; confirmCb = null; } };

  // 重命名弹层：Enter 保存 / Esc 或点遮罩取消
  dom.btnRenameOk.onclick = () => { submitRename(); };
  dom.btnRenameCancel.onclick = () => { closeRename(); };
  dom.renameOverlay.onclick = (e) => { if (e.target.id === 'renameOverlay') closeRename(); };
  dom.renameInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') submitRename();
    else if (e.key === 'Escape') closeRename();
  };

  // PPT 翻页
  dom.btnPptNext.onclick = () => window.api.invoke('ppt:next');
  dom.btnPptPrev.onclick = () => window.api.invoke('ppt:prev');
  // 播放条里的翻页键复用同一套动作，避免两处逻辑分叉
  if (dom.btnPptNextBar) dom.btnPptNextBar.onclick = () => dom.btnPptNext.click();
  if (dom.btnPptPrevBar) dom.btnPptPrevBar.onclick = () => dom.btnPptPrev.click();

  // 课堂工具
  tmBind();

  dom.btnPin.onclick = async () => {
    const r = await window.api.invoke('window:toggleAlwaysOnTop');
    dom.btnPin.classList.toggle('on', r.alwaysOnTop);
  };
  dom.btnSettings.onclick = () => openSettings();
  dom.btnCloseSettings.onclick = () => closeSettings();
  dom.settingsOverlay.onclick = (e) => { if (e.target.id === 'settingsOverlay') closeSettings(); };

  // 设置页底部官网链接可点击打开浏览器（状态栏的网址仅作展示，不可点击）
  dom.setSite.onclick = (e) => {
    e.preventDefault();
    if (state.brand && state.brand.site) window.api.invoke('app:openExternal', state.brand.site);
  };
  // 赞助按钮：跳转赞助页（同走主进程域名校验）
  dom.btnSponsor.onclick = () => {
    if (state.brand && state.brand.sponsor) window.api.invoke('app:openExternal', state.brand.sponsor);
  };
  // 联系邮箱：点击复制到剪贴板（sandbox 渲染进程无剪贴板权限，走主进程 IPC）
  dom.contactEmail.onclick = async () => {
    const r = await window.api.invoke('app:copyText', 'aa309888654@gmail.com').catch(() => null);
    const ok = !!(r && r.ok);
    if (ok) {
      dom.contactEmail.classList.add('copied');
      setTimeout(() => dom.contactEmail.classList.remove('copied'), 1200);
    }
    toast(ok ? '联系邮箱已复制到剪贴板' : '复制失败，请手动复制', ok ? 'ok' : 'warn');
  };

  dom.btnPickPpt.onclick = async () => {
    const r = await window.api.invoke('ppt:openDialog');
    if (!r) return;
    state.pptUserPicked = true;
    if (r.ppts) { state.ppts = r.ppts; renderPptChips(); } // 课件库芯片（含新入库课件的缩略图占位）
    if (r.imported) toast('课件已加入课件库，缩略图生成中', 'ok');
    state.selectedPpt = r.file;
    state.config.recentPpt = [r.file, ...(state.config.recentPpt || []).filter((x) => x !== r.file)];
    renderRecents(); renderPptState();
  };
  dom.btnPresent.onclick = () => window.api.invoke('ppt:present', state.selectedPpt);
  dom.btnExitPresent.onclick = () => window.api.invoke('ppt:exit');
  dom.btnCast.onclick = () => toggleCast();
  dom.btnExtend.onclick = async () => {
    const r = await window.api.invoke('displays:extend');
    if (r.already) toast('已处于扩展模式', 'ok');
    else if (r.ok) toast('已切换到扩展模式：第二块屏 = 投影', 'ok');
    else toast(r.error === 'no-displayswitch' ? '系统缺少 DisplaySwitch，无法自动切换' : '未识别到第二块屏：请检查投影线/HDMI 输入源', 'warn');
  };

  dom.btnPickVideo.onclick = async () => {
    // 选视频 = 入库（复制到视频文件夹，长期保存）；冷门格式自动转码为 MP4；点视频卡片才播放
    const r = await window.api.invoke('video:openDialog');
    if (!r || r.canceled) return;
    state.videos = r.videos || state.videos;
    renderVideos();
    if (r.failed) toast(`${r.failed} 个文件转码失败，请检查文件是否损坏`, 'error');
    toast(r.imported
      ? `已添加 ${r.imported} 个视频到视频库${r.transcoded ? `（含转码 ${r.transcoded} 个）` : ''}`
      : '所选视频已在视频库中', r.imported ? 'ok' : 'info');
  };
  dom.btnStopVideo.onclick = () => window.api.invoke('video:stop');

  // 视频遥控条
  dom.btnVToggle.onclick = () => window.api.invoke('video:control', 'toggle');
  dom.btnVBack.onclick = () => window.api.invoke('video:control', 'back');
  dom.btnVFwd.onclick = () => window.api.invoke('video:control', 'fwd');
  dom.btnVVolUp.onclick = () => window.api.invoke('video:control', 'volUp');
  dom.btnVVolDown.onclick = () => window.api.invoke('video:control', 'volDown');
  dom.btnVWin.onclick = () => window.api.invoke('video:windowToggle');
  bindVideoProgress();
  bindPptRail();

  // 图片投放：上一张 / 下一张 / 自动轮播
  dom.btnIPrev.onclick = () => window.api.invoke('video:control', 'prev');
  dom.btnINext.onclick = () => window.api.invoke('video:control', 'next');
  dom.btnIAuto.onclick = () => window.api.invoke('video:control', 'auto');
  dom.btnIWin.onclick = () => window.api.invoke('video:windowToggle');

  // 投屏目标屏：手动固定到某一块（0 = 交回智能识别）
  dom.dispSelect.onchange = async (e) => {
    const r = await window.api.invoke('displays:select', Number(e.target.value) || 0);
    if (!r || !r.ok) { toast('该屏已不在线，已退回自动识别', 'warn'); renderDispSelect(); return; }
    state.config.display = { ...(state.config.display || {}), projectionId: Number(e.target.value) || 0 };
    state.displays = r.displays;
    renderDisplays();
  };

  // 设置
  dom.btnPickMusicDir.onclick = async () => {
    const dir = await window.api.invoke('dialog:pickDir', state.config.musicDir);
    if (dir) { dom.setMusicDir.textContent = dir; dom.setMusicDir.dataset.val = dir; }
  };
  dom.btnPickVideoDir.onclick = async () => {
    const dir = await window.api.invoke('dialog:pickDir', state.config.videoDir);
    if (dir) { dom.setVideoDir.textContent = dir; dom.setVideoDir.dataset.val = dir; }
  };
  dom.btnPickPptDir.onclick = async () => {
    const dir = await window.api.invoke('dialog:pickDir', state.config.pptDir);
    if (dir) { dom.setPptDir.textContent = dir; dom.setPptDir.dataset.val = dir; }
  };
  dom.btnSaveSettings.onclick = saveSettings;

  renderHotkeys();
}

/* ---------- 迷你模式（单屏 LED：极小控制面板） ---------- */
let lastMusicState = null; // 最近一次音乐状态（迷你状态行用）
let miniCollapseTimer = null;

async function toggleMiniMode(opts) {
  const entering = !document.body.classList.contains('mini-mode');
  if (entering) {
    // 与 LED 模式互斥：迷你模式是「主面板缩成遥控器」，LED 是「主面板变展示窗」
    if (document.body.classList.contains('led-mode')) {
      state.config = await window.api.invoke('config:save', { displayMode: 'control' });
      applyDisplayMode('control');
    }
    const r = await window.api.invoke('window:miniMode',
      opts && (opts.dockCorner || opts.compact) ? { on: true, dockCorner: !!opts.dockCorner, compact: !!opts.compact } : true);
    if (r && r.ok) {
      document.body.classList.add('mini-mode');
      dom.miniDock.hidden = false;
      state.config = await window.api.invoke('config:save', { miniMode: true });
      syncMiniStatus();
      if (!opts || !opts.dockCorner) toast('已进入迷你模式：拖到右下角可自动隐藏', 'ok');
    }
  } else {
    document.body.classList.remove('mini-mode', 'mini-collapsed');
    await window.api.invoke('window:miniExpand').catch(() => { }); // 收起态先还原尺寸再退出
    await window.api.invoke('window:miniMode', false);
    dom.miniDock.hidden = true;
    state.config = await window.api.invoke('config:save', { miniMode: false });
  }
}

function bindMini() {
  dom.btnMini.onclick = () => toggleMiniMode();
  dom.miniExpand.onclick = () => toggleMiniMode();
  // 收起态小把手：点它展开（BUG-08：原来只有 mouseenter 一条恢复路径，触屏/点击无效）
  if (dom.miniHandle) {
    dom.miniHandle.onclick = async () => {
      const r = await window.api.invoke('window:miniExpand').catch(() => null);
      if (r && r.ok) document.body.classList.remove('mini-collapsed');
    };
  }
  // 迷你按钮全部代理到主面板现有按钮/引擎，零逻辑重复
  dom.miniPlay.onclick = () => dom.btnPlay.click();
  dom.miniNext.onclick = () => dom.btnNext.click();
  dom.miniCat.onclick = () => {
    const cats = state.music.map((c) => c.category);
    if (!cats.length) return;
    const i = cats.indexOf(engine.category);
    engine.playCategory(cats[(i + 1) % cats.length]);
  };
  dom.miniPptImport.onclick = () => dom.btnPickPpt.click();
  dom.miniPptPresent.onclick = () => { if (state.ppt.presenting) dom.btnExitPresent.click(); else dom.btnPresent.click(); };
  dom.miniPptPrev.onclick = () => dom.btnPptPrev.click();
  dom.miniPptNext.onclick = () => dom.btnPptNext.click();

  // 自动隐藏：鼠标离开窗口 0.9s 后收起成右下角小把手（主进程判定是否已停靠角落）
  document.addEventListener('mouseleave', () => {
    if (!document.body.classList.contains('mini-mode') || document.body.classList.contains('mini-collapsed')) return;
    clearTimeout(miniCollapseTimer);
    miniCollapseTimer = setTimeout(async () => {
      const r = await window.api.invoke('window:miniCollapse').catch(() => null);
      if (r && r.ok) document.body.classList.add('mini-collapsed');
    }, 900);
  });
  document.addEventListener('mouseenter', async () => {
    clearTimeout(miniCollapseTimer);
    if (!document.body.classList.contains('mini-collapsed')) return;
    document.body.classList.remove('mini-collapsed');
    await window.api.invoke('window:miniExpand').catch(() => { });
  });
}

function syncMiniStatus() {
  if (!dom.miniStatus) return;
  const s = lastMusicState;
  const music = s && s.track ? `♪ ${s.track}${s.playing ? '' : '（已暂停）'}` : '未在播放';
  const ppt = state.ppt && state.ppt.presenting
    ? ` · ▶ ${state.pptPage ? `${state.pptPage.position}/${state.pptPage.total}` : '放映中'}`
    : '';
  dom.miniStatus.textContent = music + ppt;
}

/* ---------- 无线投屏（顶栏按钮 + 弹窗） ---------- */
let castRunning = false;
let remoteUrl = '';
let castToken = ''; // 信令服务访问令牌（内联接收端用 X-Token 头）

function bindCast() {
  // 启动时若服务还在跑（重载页面），恢复按钮与信息
  window.api.invoke('cast:state').then((s) => { if (s && s.running) renderCast({ running: true, url: s.url, token: s.token, inline: document.body.classList.contains('led-mode') }); }).catch(() => { });
  // 顶栏「无线投屏」按钮：开关弹窗；开关投屏在弹窗里操作
  dom.btnCastTop.onclick = () => { dom.castOverlay.hidden = !dom.castOverlay.hidden; };
  dom.btnCloseCast.onclick = () => { dom.castOverlay.hidden = true; };
  dom.castOverlay.onclick = (e) => { if (e.target.id === 'castOverlay') dom.castOverlay.hidden = true; };
  // 无线遥控：打开弹窗（服务未开则自动开启），同一服务同时供投屏与遥控
  dom.btnRemote.onclick = async () => {
    dom.remoteOverlay.hidden = false;
    if (!castRunning) { const r = await window.api.invoke('cast:toggle'); if (r) renderCast(r); }
    if (remoteUrl) drawRemoteQr(remoteUrl);
    window.api.invoke('peer:scanStart').catch(() => { }); // 遥控另一台电脑：开始扫描局域网信标
  };
  dom.btnCloseRemote.onclick = () => { dom.remoteOverlay.hidden = true; window.api.invoke('peer:scanStop').catch(() => { }); };
  dom.remoteOverlay.onclick = (e) => { if (e.target.id === 'remoteOverlay') { dom.remoteOverlay.hidden = true; window.api.invoke('peer:scanStop').catch(() => { }); } };
  dom.btnRemoteToggle.onclick = () => toggleCast();
  // 页面重载后恢复已在的遥控会话（主进程侧 session 不随页面销毁）
  window.api.invoke('peer:session').then((s) => { if (s) onPeerConnected(s); }).catch(() => { });
  // 手动输入 IP 连接（支持 ip:port）
  dom.btnPeerConnectManual.onclick = () => {
    const raw = dom.peerIp.value.trim();
    if (!raw) { toast('请输入被控电脑的 IP', 'error'); return; }
    const m = /^(.+):(\d+)$/.exec(raw);
    connectPeer(m ? m[1] : raw, m ? Number(m[2]) || 18333 : 18333, m ? m[1] : raw);
  };
  dom.btnPeerDisconnect.onclick = async () => {
    await window.api.invoke('peer:disconnect').catch(() => { });
    stopPeerPoll();
    peerSession = null;
    dom.peerPanel.hidden = true;
    dom.peerStatus.textContent = '—';
  };
  // 面板里的音乐/PPT/视频按钮：统一按 data-peer/data-cmd 委托下发
  dom.remoteOverlay.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-peer]');
    if (!btn || !peerSession) return;
    window.api.invoke('peer:cmd', { target: btn.dataset.peer, cmd: btn.dataset.cmd, page: Number(btn.dataset.page || 0) })
      .then((r) => { if (r && r.ok === false) toast(peerErrText(r.error), 'error'); })
      .catch(() => { });
  });
}

/* ---------- 局域网遥控另一台电脑（控制端） ---------- */
let peerPollTimer = null;
let peerSession = null; // { name, ip, port }

function peerErrText(err) {
  const map = {
    'no-ip': '请输入被控电脑的 IP',
    unreachable: '连不上对方：检查 IP 是否正确、对方是否已开启遥控',
    'no-token': '对方服务未就绪，请稍后重试',
    unauthorized: '鉴权失效，请重新连接',
    'not-connected': '尚未连接',
    'bad-cmd': '对方不支持该操作',
  };
  return map[err] || '操作失败';
}

async function connectPeer(ip, port, name) {
  // 成功后会收到 peer:connected 广播，UI 切换在 onPeerConnected 里做
  const r = await window.api.invoke('peer:connect', { ip, port, name }).catch(() => ({ ok: false, error: 'unreachable' }));
  if (!r || !r.ok) toast(peerErrText(r && r.error), 'error');
}

function onPeerConnected(s) {
  peerSession = s;
  dom.peerPanel.hidden = false;
  dom.peerBadge.textContent = '已连接';
  dom.peerBadge.classList.remove('idle');
  const label = `${s.name || s.ip} · ${s.ip}:${s.port}`;
  dom.peerName.textContent = label;
  dom.peerName.title = label;
  renderPeerStatus({});
  startPeerPoll();
  toast(`已连接到 ${s.name || s.ip}`, 'ok');
}

function onPeerLost() {
  stopPeerPoll();
  peerSession = null;
  dom.peerPanel.hidden = true;
  dom.peerStatus.textContent = '连接已断开';
  toast('与被控电脑的连接已断开', 'error');
}

function startPeerPoll() {
  stopPeerPoll();
  peerPollTimer = setInterval(async () => {
    const r = await window.api.invoke('peer:state').catch(() => null);
    if (!r || !r.ok) { onPeerLost(); return; }
    renderPeerStatus(r.state || {});
  }, 1500);
}
function stopPeerPoll() { if (peerPollTimer) clearInterval(peerPollTimer); peerPollTimer = null; }

function renderPeerStatus(s) {
  const m = s.music || {}, p = s.ppt || {}, v = s.video || {};
  dom.peerStatus.textContent = [
    m.playing ? `音乐 ${m.track || '播放中'} ${m.volume || 0}%` : '音乐 停止',
    p.presenting ? `PPT ${p.position || 0}/${p.total || 0}` : 'PPT 未放映',
    v.playing ? '视频 播放中' : '视频 停止',
  ].join(' | ');
}

function renderPeerList(list) {
  const peers = Array.isArray(list) ? list : [];
  if (!peers.length) {
    dom.peerList.innerHTML = '<div class="peer-empty dim">未发现可遥控的电脑（对方需开启「遥控」服务且在同一 WiFi）</div>';
    return;
  }
  dom.peerList.innerHTML = '';
  for (const p of peers) {
    const el = document.createElement('div');
    el.className = 'peer-item' + (peerSession && peerSession.ip === p.ip && peerSession.port === p.port ? ' on' : '');
    el.innerHTML = '<span class="ico" data-ico="monitor" data-ico-size="13"></span><span class="nm"></span><span class="ip mono"></span>';
    el.querySelector('.nm').textContent = p.name || p.ip;
    el.querySelector('.ip').textContent = `${p.ip}:${p.port}`;
    el.title = `点击连接 ${p.name || p.ip}`;
    el.onclick = () => connectPeer(p.ip, p.port, p.name);
    dom.peerList.appendChild(el);
  }
  Icons.hydrate(dom.peerList);
}

async function toggleCast() {
  const r = await window.api.invoke('cast:toggle');
  if (!r || !r.ok) {
    toast(r && r.error === 'port-busy' ? '投屏端口被占用，请先关闭占用端口的程序' : '无线投屏开启失败', 'error');
    return;
  }
  renderCast(r);
}

function renderCast(s) {
  castRunning = !!s.running;
  castToken = s.token || '';
  // 顶栏按钮同步：开启时点亮
  remoteUrl = castRunning && s.url ? s.url + '/remote' : '';
  dom.btnCastTop.classList.toggle('on', castRunning);
  dom.btnRemote.classList.toggle('on', castRunning);
  dom.remoteBadge.textContent = castRunning ? '已开启' : '未开启';
  dom.remoteBadge.classList.toggle('idle', !castRunning);
  dom.remoteInfo.style.display = castRunning && remoteUrl ? 'flex' : 'none';
  if (castRunning && remoteUrl) {
    dom.remoteUrl.textContent = remoteUrl;
    drawRemoteQr(remoteUrl);
  }
  dom.btnRemoteToggle.textContent = castRunning ? '停止服务' : '开启服务';
  dom.btnCastTop.title = castRunning ? `无线投屏运行中${s.url ? ` · ${s.url}` : ''}（点击查看/关闭）` : '无线投屏：同一 WiFi 下手机/电脑打开网址即可投屏';
  dom.btnCast.innerHTML = `<span class="ico"></span> ${castRunning ? '停止投屏' : '开启无线投屏'}`;
  Icons.set(dom.btnCast.querySelector('.ico'), castRunning ? 'stop' : 'cast', 13);
  dom.castBadge.textContent = castRunning ? '已开启 · 等待设备接入' : '未开启';
  dom.castBadge.classList.toggle('idle', !castRunning);
  dom.castInfo.style.display = castRunning ? 'flex' : 'none';
  if (castRunning && s.url) {
    dom.castUrl.textContent = s.url;
    drawCastQr(s.url);
  }
  if (castRunning && s.inline) startInlineReceiver(s.url, s.token);
  if (!castRunning) stopInlineReceiver();
}

function drawRemoteQr(text) {
  const canvas = dom.remoteQr;
  const m = window.QRLite && window.QRLite.encode(text);
  if (!m) { canvas.style.display = 'none'; return; }
  canvas.style.display = 'block';
  const q = 3, scale = 4, size = m.size;
  canvas.width = canvas.height = (size + q * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m.dark(r, c)) ctx.fillRect((c + q) * scale, (r + q) * scale, scale, scale);
    }
  }
}

function drawCastQr(text) {
  const canvas = dom.castQr;
  const m = window.QRLite && window.QRLite.encode(text);
  if (!m) { canvas.style.display = 'none'; return; }
  canvas.style.display = 'block';
  const q = 3, scale = 4, size = m.size;
  canvas.width = canvas.height = (size + q * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m.dark(r, c)) ctx.fillRect((c + q) * scale, (r + q) * scale, scale, scale);
    }
  }
}

function onCastStatus(event) {
  if (event === 'sender-found') {
    dom.castBadge.textContent = '设备已接入 · 建链中';
    dom.castBadge.classList.remove('idle');
    toast('检测到设备发起投屏，正在建立连接…');
  } else if (event === 'connected') {
    dom.castBadge.textContent = '已连接 · 投屏播放中';
    dom.castBadge.classList.remove('idle');
    toast('设备已接入，投屏开始', 'ok');
  } else if (event === 'port-busy') {
    toast('投屏端口 18333 被占用，请先关闭占用该端口的程序', 'error');
  }
}

// LED 模式：接收主进程告诉 inline 启动后，由面板直接在 ledVideo 上播放
let inlineReceiver = null;
function startInlineReceiver(url, token) {
  if (!document.body.classList.contains('led-mode')) return;
  let port = 0;
  try { port = Number(new URL(url).port) || 0; } catch { }
  if (!port) return;
  if (inlineReceiver) stopInlineReceiver();
  inlineReceiver = true;
  window.CastReceiver.start({
    port,
    token: token || castToken || '',
    video: dom.ledVideo,
    onState: (s) => {
      if (s === 'playing') dom.ledIdle.hidden = true;
      if (s === 'disconnected' || s === 'bye') dom.ledIdle.hidden = false;
    },
  });
}
function stopInlineReceiver() {
  inlineReceiver = null;
  window.CastReceiver.stop();
}

/* ---------- 欢迎屏 ---------- */
const WL_STYLES = [
  ['晓光', 'ts1'], ['鎏金', 'ts2'], ['朗红', 'ts3'], ['楷风', 'ts4'], ['隶韵', 'ts5'],
  ['行楷', 'ts6'], ['霓虹', 'ts7'], ['简白', 'ts8'], ['天际', 'ts9'], ['墨影', 'ts10'],
];
// 字体（与大屏页 welcome.html 的 WL_FONTS_CSS 顺序一致，改动需两边同步）
const WL_FONTS = [
  ['雅黑', '"Microsoft YaHei","PingFang SC",sans-serif'],
  ['黑体', 'SimHei,"Microsoft YaHei",sans-serif'],
  ['楷体', 'KaiTi,STKaiti,"Microsoft YaHei",serif'],
  ['隶书', 'LiSu,STLiti,KaiTi,serif'],
  ['行楷', 'STXingkai,KaiTi,serif'],
  ['新魏', 'STXinwei,KaiTi,serif'],
  ['宋体', 'SimSun,STSong,serif'],
  ['仿宋', 'FangSong,STFangsong,serif'],
  ['中宋', 'STZhongsong,SimSun,serif'],
  ['幼圆', 'YouYuan,"Microsoft YaHei",sans-serif'],
];
// LOGO 位置：左上/右上/顶中/左下/右下（与 welcome.css .w-logo-* 同名）
const WL_LOGO_POS = [['左上', 'tl'], ['顶中', 'tc'], ['右上', 'tr'], ['左下', 'bl'], ['右下', 'br']];
let wlState = { text: '', sub: '', bg: 1, style: 1, font: 1, logo: { path: '', pos: 'tl' }, bgDir: '', bgs: [] };
let wlIsOpen = false; // 大屏开屏状态（面板 Esc 兜底关屏用）

function bindWelcome() {
  dom.wlText.addEventListener('input', () => { wlState.text = dom.wlText.value; wlPreview(); wlSave(); });
  dom.wlSub.addEventListener('input', () => { wlState.sub = dom.wlSub.value; wlPreview(); wlSave(); });
  dom.btnWelcomeOpen.onclick = () => wlOpen();
  dom.btnWelcomeClose.onclick = () => wlCloseWin();
  dom.btnWlLogoPick.onclick = async () => {
    const r = await window.api.invoke('welcome:pickLogo');
    if (r && r.ok && r.path) {
      wlState.logo.path = r.path;
      renderWlLogo(); wlPreview(); wlSave();
    }
  };
  dom.btnWlLogoClear.onclick = () => {
    wlState.logo.path = '';
    renderWlLogo(); wlPreview(); wlSave();
  };
  Icons.hydrate(dom.welcomeOverlay);
}

// 文件 URL：# 与 ? 是 URL 保留字符，encodeURI 不转义它们。
// 文件名里带 # 时（Windows 允许）浏览器会把 # 之后当成 fragment → 资源 404、缩略图永久裂图。
// 与 audioEngine.fileUrl（:151）保持一致——同一逻辑三处写法原本不一致。
function fileUrl_(p) { return encodeURI(`file:///${String(p).replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F'); }

async function openWelcome() {
  const cfg = (window.api && (await window.api.invoke('config:save', {}))) || state.config;
  const w = (cfg && cfg.welcome) || (state.config && state.config.welcome) || {};
  const init = await window.api.invoke('app:getInit');
  wlState.bgDir = init.welcomeBgDir || wlState.bgDir;
  wlState.bgs = (Array.isArray(init.welcomeBgs) && init.welcomeBgs.length) ? init.welcomeBgs : [{ file: '01.png', label: '鎏金风华' }];
  wlState.text = w.text ?? wlState.text ?? '欢迎各位领导莅临指导';
  wlState.sub = w.sub ?? wlState.sub ?? '';
  wlState.bg = Number(w.bg || 1);
  wlState.style = Number(w.style || 1);
  wlState.font = Number(w.font || 1);
  wlState.logo = (w.logo && typeof w.logo === 'object') ? { path: w.logo.path || '', pos: w.logo.pos || 'tl' } : { path: '', pos: 'tl' };
  dom.wlText.value = wlState.text;
  dom.wlSub.value = wlState.sub;
  renderWlStyles();
  renderWlFonts();
  renderWlLogo();
  renderWlBgs();
  wlPreview();
  renderWelcomeState({ open: await window.api.invoke('welcome:state').then((s) => s.open).catch(() => false) });
  dom.welcomeOverlay.hidden = false;
}
function closeWelcome() { dom.welcomeOverlay.hidden = true; }

let wlSaveTimer = null;
function wlSave() {
  clearTimeout(wlSaveTimer);
  wlSaveTimer = setTimeout(() => {
    window.api.invoke('config:save', { welcome: { text: wlState.text, sub: wlState.sub, bg: wlState.bg, style: wlState.style, font: wlState.font, logo: wlState.logo } });
  }, 500);
}

function renderWlStyles() {
  const box = dom.wlStyles;
  box.innerHTML = '';
  WL_STYLES.forEach(([name, cls], i) => {
    const el = document.createElement('div');
    el.className = 'wl-style-chip' + (wlState.style === i + 1 ? ' on' : '');
    el.textContent = name;
    el.onclick = () => { wlState.style = i + 1; renderWlStyles(); wlPreview(); wlSave(); };
    box.appendChild(el);
  });
}

function wlBgFile(i) {
  const it = wlState.bgs[i - 1];
  return (it && it.file) || '01.png';
}
function renderWlFonts() {
  const box = dom.wlFonts;
  if (!box) return;
  box.innerHTML = '';
  WL_FONTS.forEach(([name, css], i) => {
    const el = document.createElement('div');
    el.className = 'wl-style-chip' + (wlState.font === i + 1 ? ' on' : '');
    el.textContent = name;
    el.title = name;
    el.style.fontFamily = css;
    el.onclick = () => { wlState.font = i + 1; renderWlFonts(); wlPreview(); wlSave(); };
    box.appendChild(el);
  });
}
function renderWlLogo() {
  const thumb = dom.wlLogoThumb, img = dom.wlLogoImg, empty = dom.wlLogoEmpty;
  const posBox = dom.wlLogoPos;
  const hasLogo = !!wlState.logo.path;
  img.hidden = !hasLogo; empty.hidden = hasLogo;
  if (hasLogo) img.src = fileUrl_(wlState.logo.path);
  dom.btnWlLogoClear.disabled = !hasLogo;
  posBox.innerHTML = '';
  WL_LOGO_POS.forEach(([name, code]) => {
    const el = document.createElement('div');
    el.className = 'wl-style-chip' + (wlState.logo.pos === code ? ' on' : '');
    el.textContent = name;
    el.title = name;
    el.onclick = () => { wlState.logo.pos = code; renderWlLogo(); wlPreview(); wlSave(); };
    posBox.appendChild(el);
  });
}
function renderWlBgs() {
  const box = dom.wlBgs;
  box.innerHTML = '';
  for (let i = 1; i <= wlState.bgs.length; i++) {
    const label = (wlState.bgs[i - 1] && wlState.bgs[i - 1].label) || `背景 ${i}`;
    const el = document.createElement('div');
    el.className = 'wl-bg-chip' + (wlState.bg === i ? ' on' : '');
    const url = fileUrl_(`${wlState.bgDir}\\${wlBgFile(i)}`);
    el.innerHTML = `<img src="${url}" alt="${label}" loading="lazy" decoding="async"><span class="wl-bg-name">${label}</span>`;
    el.onclick = () => { wlState.bg = i; renderWlBgs(); wlPreview(); wlSave(); };
    box.appendChild(el);
  }
}

function wlPreview() {
  const p = dom.wlPreview;
  const n = wlState.style;
  const fontCss = (WL_FONTS[wlState.font - 1] || WL_FONTS[0])[1];
  const t = (wlState.text || '欢迎各位领导莅临指导')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    .replace(/\n/g, '<br>');
  // 预览只是右栏里的小窗，不能带 w-fs（fixed 全屏会盖住左侧输入区）
  p.className = `wl-preview ts${n}`;
  p.style.setProperty('--wl-font', fontCss);
  const logoHtml = wlState.logo.path
    ? `<img class="w-logo w-logo-${wlState.logo.pos}" src="${fileUrl_(wlState.logo.path)}" alt="LOGO">`
    : '';
  p.innerHTML = `
    <div class="w-bg" style="background-image:url('${fileUrl_(`${wlState.bgDir}\\${wlBgFile(wlState.bg)}`)}')"></div>
    <div class="w-dim"></div>
    <div class="w-main">
      <div class="w-title">${t}</div>
      <div class="w-sub">${(wlState.sub || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</div>
    </div>${logoHtml}`;
}

async function wlOpen() {
  wlSave();
  const r = await window.api.invoke('welcome:toggle', {
    text: wlState.text, sub: wlState.sub, bg: wlState.bg, style: wlState.style, font: wlState.font,
    logoPath: wlState.logo.path, logoPos: wlState.logo.pos,
  });
  if (r && r.open) {
    closeWelcome();
    toast('欢迎屏已上 LED 大屏', 'ok');
  }
  renderWelcomeState({ open: !!(r && r.open) });
}
async function wlCloseWin() {
  await window.api.invoke('welcome:toggle');
  renderWelcomeState({ open: false });
}

function renderWelcomeState(s) {
  const open = !!(s && s.open);
  wlIsOpen = open;
  dom.btnWelcome.classList.toggle('on', open);
  dom.btnWelcomeClose.disabled = !open;
  dom.btnWelcomeOpen.textContent = open ? '✨ 重新开屏（刷新内容）' : '🚀 开屏（上 LED）';
  dom.btnWelcomeOpen.innerHTML = `<span class="ico"></span> ${open ? '重新开屏（刷新内容） ' : '开屏（上 LED）'}`;
  Icons.set(dom.btnWelcomeOpen.querySelector('.ico'), 'cast', 14);
}

/* ---------- 课堂计时器 ---------- */
let tmMode = 'countdown';
let tmDurationMs = 5 * 60 * 1000;
let tmLastSnap = null;

function tmBind() {
  $$('#tmModes .chip').forEach((c) => {
    c.onclick = () => {
      $$('#tmModes .chip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      tmMode = c.dataset.mode;
      dom.tmPresets.style.display = tmMode === 'countdown' ? 'flex' : 'none';
    };
  });
  $$('#tmPresets .btn[data-min]').forEach((b) => {
    b.onclick = () => { tmDurationMs = Number(b.dataset.min) * 60000; dom.tmDisplay.textContent = fmtTime(tmDurationMs / 1000); };
  });
  dom.tmSetCustom.onclick = () => {
    const m = dom.tmCustom.value.trim().match(/^(\d{1,3}):([0-5]?\d)$/);
    if (!m) { toast('格式：分:秒，如 2:30', 'warn'); return; }
    tmDurationMs = (Number(m[1]) * 60 + Number(m[2])) * 1000;
    dom.tmDisplay.textContent = fmtTime(tmDurationMs / 1000);
  };
  dom.tmToggle.onclick = () => {
    if (tmLastSnap && tmLastSnap.finished) { window.api.invoke('timer:reset'); return; }
    if (!tmLastSnap || !tmLastSnap.started) window.api.invoke('timer:start', { mode: tmMode, duration: tmDurationMs });
    else window.api.invoke('timer:toggle');
  };
  dom.tmReset.onclick = () => window.api.invoke('timer:reset');
  dom.tmShow.onclick = () => window.api.invoke('timer:toggleShow');
}

function renderTimer(s) {
  tmLastSnap = s;
  const ms = s.mode === 'countdown' ? s.remaining : s.elapsed;
  dom.tmDisplay.textContent = fmtTime(ms / 1000);
  dom.tmDisplay.classList.toggle('warn', !!s.finished || (s.mode === 'countdown' && s.running && s.remaining <= 10000));
  const btn = dom.tmToggle;
  const [icon, text] = s.finished ? ['reset', '重置'] : s.running ? ['pause', '暂停'] : s.started ? ['play', '继续'] : ['play', '开始'];
  // 计时器每 250ms 一跳；无条件重建 innerHTML + SVG 会让整块面板持续重排（一节课全程）。
  // 沿用 renderMusic/renderMode 已有的 dataset 去抖写法，仅在签名真变了才重写。
  const sig = `${icon}|${text}`;
  if (btn.dataset.ico !== sig) {
    btn.dataset.ico = sig;
    btn.innerHTML = `<span class="ico"></span> ${text}`;
    Icons.set(btn.querySelector('.ico'), icon, 13);
  }
}

// 倒计时提示音：复用同一个 AudioContext，播完主动 close()。
// 原来每次 beep 都 new 一个且从不 close —— Chromium 硬件 AudioContext 上限约 6，
// 一节课内反复用倒计时会累积到无声。
let beepCtx = null;
function beep(times = 3) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!beepCtx || beepCtx.state === 'closed') beepCtx = new AC();
    if (beepCtx.state === 'suspended') beepCtx.resume().catch(() => { });
    const ctx = beepCtx;
    const span = (times - 1) * 0.45 + 0.34;
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.type = 'sine';
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.45;
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      o.start(t); o.stop(t + 0.34);
    }
    clearTimeout(beepCloseTimer);
    beepCloseTimer = setTimeout(() => {
      beepCloseTimer = null; beepCtx = null;
      try { ctx.close(); } catch { }
    }, (span + 0.2) * 1000);
  } catch { }
}
let beepCloseTimer = null;

/* ---------- 设置 ---------- */
function syncConfigUI() {
  const c = state.config;
  dom.setMusicDir.textContent = c.musicDir; dom.setMusicDir.dataset.val = c.musicDir;
  dom.setVideoDir.textContent = c.videoDir; dom.setVideoDir.dataset.val = c.videoDir;
  dom.setPptDir.textContent = c.pptDir || ''; dom.setPptDir.dataset.val = c.pptDir || '';
  dom.setBuiltin.checked = !!c.builtinMusicEnabled;
  dom.setCrossfade.value = String(c.crossfadeSeconds);
  dom.setDensity.value = c.uiDensity || 'compact';
  dom.setDisplayMode.value = c.displayMode || 'control';
  dom.setRestore.checked = !!c.exitAction.restoreMusic;
  dom.setClosePp.checked = !!c.exitAction.closePowerpoint;
  if (dom.setCompat) dom.setCompat.checked = !!c.compatMode;
  if (dom.setMiniAutoHide) dom.setMiniAutoHide.checked = c.miniAutoHide !== false;
  if (dom.setAutoLaunch) dom.setAutoLaunch.checked = !!c.autoLaunch;
  if (dom.setCastTrustCert) dom.setCastTrustCert.checked = c.castAutoTrustCert !== false;
  if (dom.setAutoTop) dom.setAutoTop.checked = !(c.display && c.display.autoTopOnPresent === false);
}

function openSettings() { syncConfigUI(); renderHotkeys(); dom.settingsOverlay.hidden = false; }
function closeSettings() { dom.settingsOverlay.hidden = true; }

async function saveSettings() {
  const patch = {
    musicDir: dom.setMusicDir.dataset.val || state.config.musicDir,
    videoDir: dom.setVideoDir.dataset.val || state.config.videoDir,
    pptDir: dom.setPptDir.dataset.val || state.config.pptDir,
    builtinMusicEnabled: dom.setBuiltin.checked,
    crossfadeSeconds: Number(dom.setCrossfade.value),
    uiDensity: dom.setDensity.value,
    displayMode: dom.setDisplayMode.value,
    exitAction: { restoreMusic: dom.setRestore.checked, closePowerpoint: dom.setClosePp.checked },
    miniAutoHide: dom.setMiniAutoHide ? dom.setMiniAutoHide.checked : true,
    compatMode: dom.setCompat ? dom.setCompat.checked : false,
    autoLaunch: dom.setAutoLaunch ? dom.setAutoLaunch.checked : false,
    castAutoTrustCert: dom.setCastTrustCert ? dom.setCastTrustCert.checked : true,
    // display 是对象：config:save 走深合并，只补 autoTopOnPresent，不动 teacherScreenIndex 等既有项
    display: { autoTopOnPresent: dom.setAutoTop ? dom.setAutoTop.checked : true },
  };
  state.config = await window.api.invoke('config:save', patch);
  engine.crossfade = state.config.crossfadeSeconds;
  applyDensity(state.config.uiDensity);
  applyDisplayMode(state.config.displayMode);
  const lib = await window.api.invoke('library:scan');
  state.music = lib.music; state.videos = lib.videos; state.ppts = lib.ppts || [];
  applyCatOrder();
  applyPinned();
  engine.setCategories(state.music);
  renderAll();
  closeSettings();
  toast('设置已保存', 'ok');
}

// 快捷键显示别名（反引号键/Esc 显示得友好一点；Mac 上修饰键显示为 ⌘⌥⌃⇧ 符号）
function dispAcc(a) {
  if (a === '`' || a === 'Backquote') return '~';
  if (a === 'Escape') return 'Esc';
  let s = String(a);
  if (state.platform === 'darwin') {
    s = s.replace(/CommandOrControl|Super|Command|Cmd|Meta/g, '⌘')
         .replace(/Alt|Option/g, '⌥')
         .replace(/Control/g, '⌃')
         .replace(/Shift/g, '⇧')
         .replace(/\+/g, '');
    return s;
  }
  return s.replace('Control+', 'Ctrl+').replace('Super+', 'Win+');
}

function renderHotkeys() {
  const box = dom.hotkeyList;
  const frag = document.createDocumentFragment();
  const conflicts = state.conflicts.map((c) => c.action);
  Object.entries(state.config.hotkeys).forEach(([action, acc]) => {
    if (!HK_LABELS[action]) return;
    const row = document.createElement('div');
    row.className = 'hk-row';
    row.innerHTML = `<span class="hk-name">${HK_LABELS[action]}</span>
      <span class="hk-key ${conflicts.includes(action) ? 'conflict' : ''}" data-action="${action}" title="点击修改">${dispAcc(acc)}</span>`;
    row.querySelector('.hk-key').onclick = (e) => startCapture(action, e.target);
    frag.appendChild(row);
  });
  box.innerHTML = '';
  box.appendChild(frag);
}

function startCapture(action, el) {
  if (el.classList.contains('capturing')) return;
  el.classList.add('capturing');
  el.textContent = '按下新组合…';
  const handler = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { cleanup(); restore(); return; }
    const parts = [];
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    key = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' }[key] || key;
    if (['Control', 'Alt', 'Shift', 'Super', 'Meta', 'AltGraph'].includes(e.key)) return;
    parts.push(key);
    const acc = parts.join('+');
    // 含修饰键 或 功能/具名键（F1-F12/Esc/`~`）才放行——否则全局钩子会吞掉普通字母键
    const standaloneOK = /^(F([1-9]|1[0-9]|2[0-4])|Escape|Backquote|Grave|`)$/.test(key) || key === '~';
    if (!standaloneOK && !['Control', 'Alt', 'Shift', 'Super'].some((m) => parts.includes(m))) {
      cleanup(); restore();
      toast(state.platform === 'darwin' ? '需含修饰键（⌘/⌥/⌃/⇧），或使用 F1-F12、Esc、~ 单键' : '需含修饰键（Ctrl/Alt/Shift），或使用 F1-F12、Esc、~ 单键', 'warn');
      return;
    }
    window.api.invoke('hotkey:remap', { action, accelerator: acc }).then((r) => {
      cleanup();
      if (r.ok) {
        // 同步本地配置与冲突标记，否则重开设置页会显示旧键位
        state.config.hotkeys[action] = acc;
        state.conflicts = state.conflicts.filter((c) => c.action !== action);
        el.classList.remove('conflict');
        el.textContent = dispAcc(acc);
        toast(`已设为 ${dispAcc(acc)}`, 'ok');
      }
      else {
        restore();
        const msg = r.error === 'need-modifier' ? '快捷键需包含修饰键（Ctrl/Alt/Shift）'
          : r.error === 'reserved' ? '该组合是系统保留快捷键（如复制/粘贴/关窗），请换一个'
          : r.error === 'in-window-only' ? '该键只在本窗口内生效，不能设为全局快捷键，已保留原键位'
          : '该组合被其他软件占用，已保留原键位';
        toast(msg, 'error');
      }
    });
    function cleanup() { window.removeEventListener('keydown', handler, true); el.classList.remove('capturing'); }
    function restore() { el.textContent = dispAcc(state.config.hotkeys[action] || ''); }
  };
  window.addEventListener('keydown', handler, true);
}

/* ---------- 通用 ---------- */
function toast(text, type = 'info') {
  const box = dom.toasts;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 2600);
}

let osdTimer = null;
function showOSD(text) {
  const osd = dom.osd;
  osd.textContent = text;
  osd.hidden = false;
  osd.style.opacity = '1';
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => { osd.style.opacity = '0'; setTimeout(() => (osd.hidden = true), 400); }, 1200);
}

function fileName(p) { return String(p).split(/[\\/]/).pop(); }
function fmtSize(n) {
  if (!n) return '';
  if (n > 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB';
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
