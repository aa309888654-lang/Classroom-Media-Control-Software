/* ===== 小天AIGC · 主控面板逻辑 ===== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

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
  video: { playing: false, file: '' },
  selectedPpt: '',
  conflicts: [],
};

const CAT_ICON = {}; // 卡片不再使用图标头像，保留空映射以备引用
const CAT_ICON_POOL = ['music'];
const HK_LABELS = {
  playPause: '播放 / 暂停', prev: '上一首', next: '下一首', mute: '静音',
  volUp: '音量 +', volDown: '音量 −', cat1: '分类 1 播放', cat2: '分类 2 播放',
  present: '放映当前课件', exitPresent: '退出投屏',
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
  if (b.version) dom.stVer.textContent = `v${b.version}`;
  if (b.site) dom.stSite.textContent = b.site;
}

async function init() {
  cacheDom();
  const d = await window.api.invoke('app:getInit');
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

  engine.setCategories(state.music);
  engine.volume = state.config.volume;
  engine.crossfade = state.config.crossfadeSeconds;
  engine.ppFade = state.config.playPauseFadeSeconds;
  engine.loopMode = state.config.loopMode;
  engine.onState = onMusicState;
  applyDensity(state.config.uiDensity);
  applyDisplayMode(state.config.displayMode);
  // 迷你模式记忆：上次关机时若在迷你模式，直接以迷你面板启动（LED 模式优先，互斥）
  if (state.config.miniMode && state.config.displayMode !== 'led') {
    document.body.classList.add('mini-mode');
    dom.miniDock.hidden = false;
    window.api.invoke('window:miniMode', true).catch(() => { });
  }

  bindUI();
  renderAll();
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
    `快捷键 ${acc('playPause')} 播放/暂停 · ${acc('prev')}/${acc('next')} 切歌 · ${acc('mute')} 静音 · ${acc('volDown')}/${acc('volUp')} 音量−/＋ · ${acc('cat1')}/${acc('cat2')} 切分类 · ~ 全屏 · Esc 退出全屏 · 长按卡片排序 · ☆置顶 · ⤒导入`;
  if (dom.hkHintPpt) dom.hkHintPpt.textContent =
    `PPT 放映在投影屏全屏 · ${acc('present')} 放映 · ${acc('exitPresent')} 退出 · 课件库长按拖动排序`;
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
  window.api.on('music:restore', ({ action }) => (action === 'duck' ? engine.duck() : engine.restore()));
  window.api.on('ppt:state', (s) => { state.ppt = { ...state.ppt, ...s }; renderPptState(); renderMode(); });
  window.api.on('video:state', (v) => { state.video = v; renderVideoState(); renderMode(); });
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
    case 'volUp': v.volume = Math.min(1, v.volume + 0.1); break;
    case 'volDown': v.volume = Math.max(0, v.volume - 0.1); break;
    case 'stop':
      v.pause(); v.src = ''; v.hidden = true;
      dom.ledIdle.hidden = false;
      break;
    default: break;
  }
}

/* ---------- 播放进度条（requestAnimationFrame，仅播放中且页面可见时逐帧刷新） ---------- */
let progressRAF = null;
function tickProgress() {
  progressRAF = null;
  const ch = engine.channels[engine.active];
  const el = ch && ch.el;
  const dur = el && isFinite(el.duration) ? el.duration : 0;
  const show = engine.idx >= 0 && dur > 0;
  dom.npProgress.style.display = show ? 'block' : 'none';
  dom.npTime.style.display = show ? 'block' : 'none';
  if (show) {
    dom.npFill.style.width = `${(el.currentTime / dur) * 100}%`;
    dom.npTime.textContent = `${fmtTime(el.currentTime)} / ${fmtTime(dur)}`;
  }
  // 有曲目在（播放/暂停/元数据加载中）就续帧等它；完全空闲（从未播放/已停止）才彻底停
  if (engine.idx >= 0) progressRAF = requestAnimationFrame(tickProgress);
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

/* ---------- 音乐 ---------- */
const expandedCats = new Set(); // 记住用户展开了哪些分类（默认只露 3 首）
const CAT_SHOW_DEFAULT = 3;

function renderCategories() {
  const box = dom.catCards;
  const frag = document.createDocumentFragment();
  state.music.forEach((cat, i) => {
    const el = document.createElement('div');
    el.className = 'cat-card' + (engine.category === cat.category && engine.playing ? ' active' : '');

    // 头部（图标 + 名称 + 曲数）：点击 = 播放/暂停该分类（保持原交互）
    const head = document.createElement('div');
    head.className = 'cat-head';
    // 不要左上角图标：分类名+数字，直接顶在卡左上角
    head.innerHTML = `
      <span>
        <div class="cat-name">${esc(cat.category)}</div>
        <div class="cat-count">${cat.tracks.length} 首</div>
      </span>`;
    head.onclick = () => {
      if (Date.now() < suppressClickUntil) return; // 刚拖完，别误触发播放
      if (!engine.playCategory(cat.category)) {
        toast(`「${cat.category}」还没有音乐，把 MP3/WAV 放进对应文件夹即可`, 'warn');
      }
    };
    el.appendChild(head);
    el.dataset.cat = cat.category;
    bindCardDrag(el, cat); // 整卡长按拖动排序

    // 添加模式打开时，才显示该分类的「＋」添加小图标（默认收起，不占视觉）
    if (state.addMode) {
      const imp = document.createElement('span');
      imp.className = 'cat-import mini';
      imp.innerHTML = '<span class="ico"></span>';
      Icons.set(imp.querySelector('.ico'), 'plus', 13);
      imp.title = '添加音乐到该分类（复制到音乐文件夹，长期保存）';
      imp.onclick = async (e) => {
        e.stopPropagation();
        const r = await window.api.invoke('music:import', cat.category);
        if (!r || r.canceled) return;
        if (r.ok && r.imported > 0) {
          state.music = r.music;
          applyCatOrder();
          applyPinned();
          engine.setCategories(state.music);
          renderCategories();
          toast(`已添加 ${r.imported} 首到「${cat.category}」，已存入音乐文件夹`, 'ok');
        } else if (r.ok) {
          toast('未添加：所选文件不是支持的音频格式', 'warn');
        } else {
          toast('添加失败', 'error');
        }
      };
      head.appendChild(imp);
    }

    // 曲目列表：默认显示 3 首，点曲名直接点播那一首
    if (cat.tracks.length) {
      const list = document.createElement('div');
      list.className = 'cat-tracks';
      const showAll = expandedCats.has(cat.category);
      const pinnedFiles = (state.config.catPinned || {})[cat.category] || [];
      cat.tracks.slice(0, showAll ? cat.tracks.length : CAT_SHOW_DEFAULT).forEach((f, idx) => {
        const row = document.createElement('div');
        row.className = 'cat-track' + (engine.category === cat.category && engine.idx === idx ? ' playing' : '');
        row.dataset.cat = cat.category;
        row.dataset.idx = String(idx);
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
        row.title = fileName(f);
        row.onclick = (e) => { e.stopPropagation(); engine.playTrack(cat.category, idx); };
        bindTrackDrag(row, cat, idx); // 曲目行长按/竖拖排序
        list.appendChild(row);
      });
      if (cat.tracks.length > CAT_SHOW_DEFAULT) {
        const more = document.createElement('div');
        more.className = 'cat-more';
        more.textContent = showAll ? '▴ 收起' : `▾ 其余 ${cat.tracks.length - CAT_SHOW_DEFAULT} 首`;
        more.onclick = (e) => {
          e.stopPropagation();
          if (showAll) expandedCats.delete(cat.category); else expandedCats.add(cat.category);
          renderCategories();
        };
        list.appendChild(more);
      }
      el.appendChild(list);
    }

    if (!cat.builtin && !cat.virtual) {
      const del = document.createElement('span');
      del.className = 'cat-del';
      del.title = '删除分类（文件夹移入回收站）';
      Icons.set(del, 'x', 10);
      del.onclick = (e) => { e.stopPropagation(); confirmDeleteCategory(cat.category); };
      el.appendChild(del);
    }
    frag.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'cat-card cat-add';
  // 与分类卡一致：无图标，纯文字
  add.innerHTML = `<span><div class="cat-name">添加分类</div><div class="cat-count">自定义按钮</div></span>`;
  add.onclick = () => showAddCategory(add);
  frag.appendChild(add);
  if (!state.music.length) {
    const tip = document.createElement('div');
    tip.className = 'card dim';
    tip.style.gridColumn = '1/-1';
    tip.textContent = '曲库为空：点「＋添加分类」建一个，再往文件夹里放 MP3/WAV';
    frag.appendChild(tip);
  }
  box.innerHTML = '';
  box.appendChild(frag);
}

/* ---------- 曲目行键盘归类（保留注释位置）：拖动排序实现 ---------- */
let trackDrag = null; // {el, cat, fromIdx, offY, baseRect}

function bindTrackDrag(row, cat, idx) {
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.cat-pin')) return; // 星标点击留给置顶
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
  trackDrag = { el: row, cat, fromIdx: idx, offY: y - r.top };
}

function moveTrackDrag(y) {
  if (!trackDrag) return;
  trackDrag.el.style.top = `${y - trackDrag.offY}px`;
  const t = trackTargetAt(y, trackDrag.cat);
  $$(`#catCards .cat-track[data-cat="${trackDrag.cat.category}"]`).forEach((c) => {
    c.classList.toggle('drag-over', !!(t && t.el === c));
  });
}

function trackTargetAt(y, cat) {
  // 拖拽行离流后其余行会上移，漏击概率高——按「行中线最近」决定插入点，任何 y 都有落点
  const rows = $$(`#catCards .cat-track[data-cat="${cat.category}"]`).filter((c) => c !== trackDrag.el);
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

/* ---------- 分类卡片：长按拖动排序 ---------- */
let dragState = null;      // {el, cat, offX, offY, baseLeft, baseTop}
let suppressClickUntil = 0; // 拖拽结束后短暂抑制 click，避免误触发播放

function bindCardDrag(el, cat) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 曲目行/置顶星/删除/导入/输入框保留各自点击，不进拖拽
    if (e.target.closest('.cat-track, .cat-more, .cat-pin, .cat-del, .cat-import, .cat-input, .icon-btn, button')) return;
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    // 通道一：长按 0.5s 纹丝不动进入拖拽（触屏友好）
    const timer = setTimeout(() => { dragging = true; startDrag(el, cat, sx, sy); }, 500);
    const onMove = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!dragging) {
        // 通道二：明显横向拖动 → 立即进入拖拽（鼠标用户的手感，无需干等）
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          clearTimeout(timer);
          dragging = true;
          startDrag(el, cat, sx, sy);
        } else if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          clearTimeout(timer); unlisten(); // 竖向滑动视为滚屏，让位
        }
        return;
      }
      moveDrag(ev.clientX, ev.clientY);
    };
    const onUp = (ev) => {
      clearTimeout(timer); unlisten();
      if (dragging) finishDrag(ev.clientX, ev.clientY, cat);
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

function startDrag(el, cat, x, y) {
  const r = el.getBoundingClientRect();
  el.style.width = `${r.width}px`;
  el.classList.add('dragging');
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  dragState = { el, cat, offX: x - r.left, offY: y - r.top };
}

function moveDrag(x, y) {
  if (!dragState) return;
  dragState.el.style.left = `${x - dragState.offX}px`;
  dragState.el.style.top = `${y - dragState.offY}px`;
  const t = dropTargetAt(x, y);
  $$('#catCards .cat-card').forEach((c) => {
    c.classList.toggle('drag-over', !!(t && t.el === c));
  });
}

function dropTargetAt(x, y) {
  const cards = $$('#catCards .cat-card:not(.cat-add)').filter((c) => c !== (dragState && dragState.el));
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const target = state.music.find((m) => m.category === c.dataset.cat);
      if (target) return { cat: target, before: x < r.left + r.width / 2, el: c };
    }
  }
  return null;
}

function finishDrag(x, y, cat) {
  if (!dragState) return;
  const target = dropTargetAt(x, y);
  const el = dragState.el;
  el.classList.remove('dragging');
  el.style.left = el.style.top = el.style.width = '';
  $$('#catCards .cat-card').forEach((c) => c.classList.remove('drag-over'));
  dragState = null;
  suppressClickUntil = Date.now() + 150;

  const from = state.music.findIndex((c) => c.category === cat.category);
  if (target && target.cat.category !== cat.category && from !== -1) {
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

function onMusicState(s) {
  lastMusicState = s;
  scheduleRenderCategories(); // 分类卡激活态与当前曲目高亮都跟着音乐状态走（防抖）
  kickProgressLoop(); // 开始播放时唤起进度条循环（空闲时它是停的）
  syncMiniStatus();
  if (dom.miniPlay) Icons.set(dom.miniPlay.querySelector('.ico'), s.playing ? 'pause' : 'play', 22);
  dom.nowTrack.textContent = s.track || (s.playing ? '播放中' : '未在播放');
  const total = state.music.find((c) => c.category === s.category)?.tracks.length || '?';
  dom.nowCat.textContent = s.playing
    ? `分类：${s.category || '—'} · ${s.index + 1}/${total}`
    : s.track ? `已暂停 · ${s.category || ''}` : '选择一个分类开始播放';
  document.querySelector('.now-playing').classList.toggle('playing', s.playing);
  dom.btnPlay.innerHTML = '<span class="ico"></span>';
  Icons.set(dom.btnPlay.querySelector('.ico'), s.playing ? 'pause' : 'play', 18);
  const volPct = Math.round(s.volume * 100);
  dom.vol.value = volPct;
  dom.vol.style.setProperty('--fill', volPct + '%');
  dom.volVal.textContent = `${volPct}%`;
  dom.btnLoop.textContent = `循环：${s.loopMode === 'single' ? '单曲' : '列表'}`;
  renderMode();
  window.api.invoke('music:setState', { playing: s.playing, category: s.category, track: s.track, volume: s.volume, loopMode: s.loopMode });
}

function handleHotkey(action) {
  switch (action) {
    case 'playPause': engine.toggle(); break;
    case 'prev': engine.prev(); break;
    case 'next': engine.next(); break;
    case 'volUp': nudgeVolume(0.1); break;
    case 'volDown': nudgeVolume(-0.1); break;
    case 'cat1': playCatIndex(0); break;
    case 'cat2': playCatIndex(1); break;
    case 'mute': showOSD(engine.toggleMute() ? '🔇 静音' : `🔊 ${Math.round(engine.volume * 100)}%`); break;
    case 'openFull': if (!document.body.classList.contains('led-mode')) toggleDisplayMode(); break;
    case 'exitFull': if (document.body.classList.contains('led-mode')) toggleDisplayMode(); break;
    default: break;
  }
}

function playCatIndex(i) {
  const cat = state.music[i];
  if (!cat) { toast('该分类不存在（曲库为空或只有一类）', 'warn'); return; }
  engine.playCategory(cat.category);
}

function nudgeVolume(delta) {
  engine.setVolume(Math.min(1, Math.max(0, engine.volume + delta)));
  showOSD(`🔊 音量 ${Math.round(engine.volume * 100)}%`);
}

/* ---------- 投屏 ---------- */
function renderPptState() {
  const p = state.ppt;
  dom.pptFile.textContent = p.file || state.selectedPpt || '未选择';
  dom.pptFile.title = p.file || state.selectedPpt || '';
  dom.btnPresent.disabled = !!p.presenting || !!p.loading;
  dom.btnPresent.textContent = p.loading ? '⏳ 正在打开…' : p.presenting ? '🟢 正在放映中' : '▶ 一键放映 PPT';
  dom.btnExitPresent.disabled = !p.presenting && !p.loading;
  dom.pptFlipRow.style.display = p.presenting ? 'flex' : 'none';
  if (!p.presenting) dom.presenterStrip.style.display = 'none';
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
  dom.presenterStrip.style.display = 'flex';
  dom.pptPageInfo.textContent = `第 ${s.position} / ${s.total} 页`;
  if (s.curImg) dom.pptCurImg.src = fileUrlImg(s.curImg);
  if (s.nextImg) dom.pptNextImg.src = fileUrlImg(s.nextImg);
  dom.pptNotes.textContent = s.notes || '（无备注）';
  dom.pptNextNotes.textContent = s.nextNotes || '（无备注）';
}

function fileUrlImg(p) {
  return encodeURI(`file:///${String(p).replace(/\\/g, '/')}`) + '?t=' + Date.now();
}

function renderRecents() {
  const box = dom.pptRecents;
  const frag = document.createDocumentFragment();
  (state.config.recentPpt || []).slice(0, 3).forEach((f) => {
    const chip = document.createElement('span');
    chip.className = 'recent-chip' + (f === state.selectedPpt ? ' sel' : '');
    chip.textContent = fileName(f);
    chip.title = f;
    chip.onclick = () => { state.selectedPpt = f; renderRecents(); renderPptState(); };
    frag.appendChild(chip);
  });
  box.innerHTML = '';
  box.appendChild(frag);
}

function renderDisplays() {
  const n = state.displays.length;
  const proj = state.displays.find((d) => !d.isPrimary);
  dom.stDisp.textContent = n > 1 ? `显示器：教师屏0 + 投影屏${proj.index}` : `显示器：仅 1 块（${n > 0 && state.displays[0].isPrimary ? '主屏' : ''}）`;
  dom.dispInfo.textContent = n > 1
    ? state.displays.map((d) => `屏${d.index}·${d.isPrimary ? '教师' : '投影'}`).join('  ')
    : '仅检测到 1 块屏，视频/放映将用当前屏';
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
  if (state.ppt.presenting) el.innerHTML = `<i class="dot busy"></i>PPT 放映中`;
  else if (state.video.playing) el.innerHTML = `<i class="dot busy"></i>视频投放中`;
  else if (engine.playing) el.innerHTML = `<i class="dot ok"></i>音乐播放中`;
  else el.innerHTML = `<i class="dot"></i>空闲`;
}

/* ---------- 视频 ---------- */
function renderVideos() {
  const box = dom.videoChips;
  if (!state.videos.length) {
    box.innerHTML = `<span class="dim" style="font-size:12px">视频库为空：把 MP4 放进视频文件夹，或点「选择视频」</span>`;
    return;
  }
  const frag = document.createDocumentFragment();
  state.videos.forEach((v) => {
    const el = document.createElement('div');
    el.className = 'video-chip sortable-chip' + (state.video.playing && state.video.file === v.file ? ' playing' : '');
    el.dataset.file = v.file;
    el.innerHTML = `<div class="v-name">${esc(v.name)}</div><div class="v-size">${fmtSize(v.size)}</div>`;
    el.title = `${v.file}\n长按拖动可排序`;
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
    box.innerHTML = `<span class="dim" style="font-size:12px">课件库为空：把 PPT 放进课件文件夹（设置里可改位置）</span>`;
    return;
  }
  const frag = document.createDocumentFragment();
  state.ppts.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'ppt-chip sortable-chip' + (state.selectedPpt === p.file ? ' sel' : '');
    el.dataset.file = p.file;
    el.innerHTML = `<div class="v-name">${esc(p.name)}</div><div class="v-size">${fmtSize(p.size)}</div>`;
    el.title = `${p.file}\n点选为当前课件 · 长按拖动可排序`;
    el.onclick = () => {
      if (Date.now() < chipSuppressUntil) return;
      state.selectedPpt = p.file;
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
  dom.btnStopVideo.disabled = !state.video.playing;
  dom.videoRemote.style.display = state.video.playing ? 'flex' : 'none';
  dom.videoHint.textContent = state.video.playing ? `投放中：${fileName(state.video.file)}（投影屏全屏）` : '';
  // LED 面板视频按钮同步
  dom.ledVToggle.textContent = state.video.playing ? '⏸' : '▶';
  renderVideos();
}

async function playVideo(file) {
  const r = await window.api.invoke('video:play', file);
  if (r.ok) { state.video = { playing: true, file }; renderVideoState(); renderMode(); }
}

/* ---------- 事件绑定 ---------- */
function bindUI() {
  dom.btnPlay.onclick = () => engine.toggle();
  dom.btnPrev.onclick = () => engine.prev();
  dom.btnNext.onclick = () => engine.next();
  dom.btnLoop.onclick = () => engine.setLoopMode(engine.loopMode === 'list' ? 'single' : 'list');

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
    const f = await window.api.invoke('video:openDialog');
    if (f) playVideo(f);
  };

  // LED 模式下视频结束自动回到待机
  dom.ledVideo.addEventListener('ended', () => {
    dom.ledVideo.hidden = true;
    dom.ledIdle.hidden = false;
    window.api.invoke('video:notifyEnded');
  });

  // 无线同屏
  bindCast();

  // 音乐添加模式开关：点亮后各分类出现「＋」添加小图标
  dom.btnAddMode.onclick = () => {
    state.addMode = !state.addMode;
    dom.btnAddMode.classList.toggle('on', state.addMode);
    renderCategories();
  };

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

  // 进度条点击跳转
  dom.npProgress.onclick = (e) => {
    const ch = engine.channels[engine.active];
    const el = ch && ch.el;
    if (!el || !isFinite(el.duration) || !el.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.currentTime = Math.min(el.duration, Math.max(0, ((e.clientX - rect.left) / rect.width) * el.duration));
  };

  // Esc：关确认弹层 / 关设置弹窗 / 停止视频投放 / 关 LED 欢迎屏（兜底）
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!dom.confirmOverlay.hidden) { dom.confirmOverlay.hidden = true; confirmCb = null; return; }
    if (!dom.settingsOverlay.hidden) { closeSettings(); return; }
    if (wlIsOpen) { window.api.invoke('welcome:toggle'); return; }
    if (state.video.playing) window.api.invoke('video:stop');
  });

  // 确认弹层按钮
  dom.btnConfirmOk.onclick = async () => {
    dom.confirmOverlay.hidden = true;
    if (confirmCb) { const cb = confirmCb; confirmCb = null; await cb(); }
  };
  dom.btnConfirmCancel.onclick = () => { dom.confirmOverlay.hidden = true; confirmCb = null; };
  dom.confirmOverlay.onclick = (e) => { if (e.target.id === 'confirmOverlay') { dom.confirmOverlay.hidden = true; confirmCb = null; } };

  // PPT 翻页
  dom.btnPptNext.onclick = () => window.api.invoke('ppt:next');
  dom.btnPptPrev.onclick = () => window.api.invoke('ppt:prev');

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
    const f = await window.api.invoke('ppt:openDialog');
    if (f) { state.selectedPpt = f; state.config.recentPpt = [f, ...(state.config.recentPpt || []).filter((x) => x !== f)]; renderRecents(); renderPptState(); }
  };
  dom.btnPresent.onclick = () => window.api.invoke('ppt:present', state.selectedPpt);
  dom.btnExitPresent.onclick = () => window.api.invoke('ppt:exit');
  dom.btnCast.onclick = () => toggleCast();
  dom.btnExtend.onclick = async () => {
    const r = await window.api.invoke('displays:extend');
    toast(r.ok ? '已发送扩展模式指令' : 'DisplaySwitch 不可用', r.ok ? 'ok' : 'error');
  };

  dom.btnPickVideo.onclick = async () => {
    const f = await window.api.invoke('video:openDialog');
    if (f) playVideo(f);
  };
  dom.btnStopVideo.onclick = () => window.api.invoke('video:stop');

  // 视频遥控条
  dom.btnVToggle.onclick = () => window.api.invoke('video:control', 'toggle');
  dom.btnVBack.onclick = () => window.api.invoke('video:control', 'back');
  dom.btnVFwd.onclick = () => window.api.invoke('video:control', 'fwd');
  dom.btnVVolUp.onclick = () => window.api.invoke('video:control', 'volUp');
  dom.btnVVolDown.onclick = () => window.api.invoke('video:control', 'volDown');

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

async function toggleMiniMode() {
  const entering = !document.body.classList.contains('mini-mode');
  if (entering) {
    // 与 LED 模式互斥：迷你模式是「主面板缩成遥控器」，LED 是「主面板变展示窗」
    if (document.body.classList.contains('led-mode')) {
      state.config = await window.api.invoke('config:save', { displayMode: 'control' });
      applyDisplayMode('control');
    }
    const r = await window.api.invoke('window:miniMode', true);
    if (r && r.ok) {
      document.body.classList.add('mini-mode');
      dom.miniDock.hidden = false;
      state.config = await window.api.invoke('config:save', { miniMode: true });
      syncMiniStatus();
      toast('已进入迷你模式：拖到右下角可自动隐藏', 'ok');
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
  const ppt = state.ppt && state.ppt.presenting ? ' · ▶ 放映中' : '';
  dom.miniStatus.textContent = music + ppt;
}

/* ---------- 无线同屏 ---------- */
let castRunning = false;


function bindCast() {
  // 启动时若服务还在跑（重载页面），恢复按钮与信息
  window.api.invoke('cast:state').then((s) => { if (s && s.running) renderCast({ running: true, url: s.url, inline: document.body.classList.contains('led-mode') }); }).catch(() => { });
}

async function toggleCast() {
  const r = await window.api.invoke('cast:toggle');
  if (!r || !r.ok) {
    toast(r && r.error === 'port-busy' ? '同屏端口被占用，请先关闭占用端口的程序' : '同屏开启失败', 'error');
    return;
  }
  renderCast(r);
}

function renderCast(s) {
  castRunning = !!s.running;
  dom.btnCast.innerHTML = `<span class="ico"></span> ${castRunning ? '关闭同屏' : '开启同屏'}`;
  Icons.set(dom.btnCast.querySelector('.ico'), castRunning ? 'stop' : 'cast', 13);
  dom.castBadge.textContent = castRunning ? '已开启 · 等待设备接入' : '未开启';
  dom.castBadge.classList.toggle('idle', !castRunning);
  dom.castInfo.style.display = castRunning ? 'flex' : 'none';
  if (castRunning && s.url) {
    dom.castUrl.textContent = s.url;
    drawCastQr(s.url);
  }
  if (castRunning && s.inline) startInlineReceiver(s.url);
  if (!castRunning) stopInlineReceiver();
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
    toast('检测到设备发起同屏，正在建立连接…');
  } else if (event === 'connected') {
    dom.castBadge.textContent = '已连接 · 同屏播放中';
    dom.castBadge.classList.remove('idle');
    toast('设备已接入，同屏开始播放', 'ok');
  } else if (event === 'port-busy') {
    toast('同屏端口 18333 被占用，请先关闭占用该端口的程序', 'error');
  }
}

// LED 模式：接收主进程告诉 inline 启动后，由面板直接在 ledVideo 上播放
let inlineReceiver = null;
function startInlineReceiver(url) {
  if (!document.body.classList.contains('led-mode')) return;
  let port = 0;
  try { port = Number(new URL(url).port) || 0; } catch { }
  if (!port) return;
  if (inlineReceiver) stopInlineReceiver();
  inlineReceiver = true;
  window.CastReceiver.start({
    port,
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

function fileUrl_(p) { return encodeURI(`file:///${String(p).replace(/\\/g, '/')}`); }

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
  btn.innerHTML = `<span class="ico"></span> ${text}`;
  Icons.set(btn.querySelector('.ico'), icon, 13);
}

function beep(times = 3) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.type = 'sine';
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.45;
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      o.start(t); o.stop(t + 0.34);
    }
  } catch { }
}

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
  if (dom.setMiniAutoHide) dom.setMiniAutoHide.checked = c.miniAutoHide !== false;
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
    const standaloneOK = /^(F[1-9]|F1[0-2]|Escape|Backquote|Grave|`)$/.test(key) || key === '~';
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
      else { restore(); toast(r.error === 'need-modifier' ? '快捷键需包含修饰键（Ctrl/Alt/Shift）' : '该组合被其他软件占用，已保留原键位', 'error'); }
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
