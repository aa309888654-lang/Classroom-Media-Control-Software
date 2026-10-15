/* ===== 音乐引擎：Web Audio 双通道交叉淡入淡出 ===== */
// Chromium 原生可播的音频扩展名（与主进程 transcode.AUDIO_SAFE 镜像）：
// 这些直接播、零延迟；其余冷门格式（wma/ape/amr/ra/ac3/dts/mka…）播放前由主进程转码为缓存的 MP3。
const SAFE_AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.opus']);

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.channels = [null, null]; // {el, gain}
    this.active = 0;
    this.categories = [];
    this.playlist = [];
    this.category = '';
    this.idx = -1;
    this.volume = 0.7;
    this.loopMode = 'list';
    this.crossfade = 2;
    this.ppFade = 0.5;
    this.playing = false;
    this.wasDucked = false;
    this.onState = () => { };
    this.preloader = null;
    this.pauseTimer = null; // 淡出完成后 el.pause() 的延迟定时器；恢复/切歌时必须取消
    this.fadeTimer = null;  // 跨歌交叉淡出后停旧声道的定时器；同样必须取消，否则会误停当前声道（BUG-D）
    this.muted = false;
    this.savedVolume = 0.7; // 静音前音量
  }

  // F4：静音 / 恢复（不影响播放进度，只切总线增益）
  toggleMute() {
    this.ensureCtx();
    if (this.muted) {
      this.muted = false;
      this.rampMaster(this.savedVolume);
    } else {
      this.savedVolume = this.volume;
      this.muted = true;
      this.rampMaster(0);
    }
    this.emit(); // 广播静音状态：面板喇叭图标/遥控页状态随之刷新
    return this.muted;
  }

  rampMaster(v) {
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(v, now + 0.12);
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  channel(i) {
    if (!this.channels[i]) {
      const el = new Audio();
      el.preload = 'auto';
      const src = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(this.master);
      el.addEventListener('ended', () => {
        if (i !== this.active || !this.playing) return;
        // 单曲循环由 el.loop 处理；once=列表播完自动停止；list=交叉淡入下一首（末尾绕回）
        if (this.loopMode === 'single') return;
        if (this.loopMode === 'once') {
          if (this.idx >= this.playlist.length - 1) {
            this.playing = false;
            this.emit();
            return;
          }
          this.next();
          return;
        }
        this.next();
      });
      // 文件损坏/读不出（U盘拔出、权限、坏文件）：提示并自动跳下一首；连续全灭则停止
      el.addEventListener('error', () => {
        if (i !== this.active || !this.playing) return;
        const name = (this.playlist[this.idx] || '').split(/[\\/]/).pop();
        this.failCount = (this.failCount || 0) + 1;
        if (this.onError) this.onError(name, this.failCount);
        if (this.failCount >= Math.min(3, this.playlist.length)) {
          // 连续失败过多：停止，避免无限循环报错
          this.playing = false;
          this.emit();
          return;
        }
        this.next();
      });
      el.addEventListener('playing', () => { this.failCount = 0; });
      this.channels[i] = { el, gain };
    }
    return this.channels[i];
  }

  setCategories(cats) { this.categories = cats || []; }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this.muted = false; // 手动调音量即视为解除静音
    this.savedVolume = this.volume;
    if (this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(this.volume, now + 0.08);
    }
    this.emit();
  }

  // 循环模式：list=列表循环 · single=单曲循环 · once=顺序播放（列表播完停止）
  setLoopMode(m) {
    this.loopMode = m;
    if (this.channels[this.active]) this.channels[this.active].el.loop = m === 'single';
    this.emit();
  }
  setFades(crossfade, ppFade) { this.crossfade = crossfade; this.ppFade = ppFade; }

  playCategory(name) {
    const cat = this.categories.find((c) => c.category === name);
    if (!cat || !cat.tracks.length) return false;
    if (this.category === name) { this.toggle(); return true; }
    this.category = name;
    this.playlist = cat.tracks.slice();
    this.startTrack(0, this.playing ? this.crossfade : this.ppFade);
    return true;
  }

  // 点播分类里的某一首（切列表保持该分类，直接从 idx 开始）
  playTrack(category, idx) {
    const cat = this.categories.find((c) => c.category === category);
    if (!cat || !cat.tracks[idx]) return false;
    this.category = category;
    this.playlist = cat.tracks.slice();
    this.startTrack(idx, this.playing ? this.crossfade : this.ppFade);
    return true;
  }

  // Windows 路径 → file:/// URL（显式转换，避免反斜杠歧义）
  fileUrl(p) {
    return encodeURI(`file:///${String(p).replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  async startTrack(i, fadeSec) {
    this.ensureCtx();
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    clearTimeout(this.fadeTimer); // 切歌时作废上一轮跨歌淡出的待停任务（BUG-D）
    this.fadeTimer = null;
    // generation 守卫：冷门格式转码期间又切歌的话，旧的一次放弃，只播最新这次
    this._gen = (this._gen || 0) + 1;
    const gen = this._gen;
    // 解析可播放路径：安全格式直接用原文件（同步、零延迟）；冷门格式主进程转码为缓存 MP3 再播
    let playable = this.playlist[i];
    const dot = playable.lastIndexOf('.');
    const ext = dot >= 0 ? playable.slice(dot).toLowerCase() : '';
    if (!SAFE_AUDIO_EXT.has(ext)) {
      try {
        const r = await window.api.invoke('music:playable', playable);
        if (r && r.file) playable = r.file;
      } catch { /* IPC 失败用原文件兜底 */ }
      if (gen !== this._gen) return; // 已被更新的切歌取代，本次作废
    }

    const n = 1 - this.active;
    const ch = this.channel(n);
    const now = this.ctx.currentTime;
    const fade = Math.max(0.05, fadeSec);

    ch.el.src = this.fileUrl(playable);
    ch.el.loop = this.loopMode === 'single';
    ch.gain.gain.cancelScheduledValues(now);
    ch.gain.gain.setValueAtTime(0.0001, now);
    ch.gain.gain.linearRampToValueAtTime(1, now + fade);
    ch.el.play().catch(() => { });

    const old = this.channels[this.active];
    if (old && old !== ch && old.el.src) {
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(Math.max(0.0001, old.gain.gain.value), now);
      old.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
      const el = old.el;
      // 淡出后的 el.pause() 必须登记 id 并在 startTrack/resume 清除（BUG-D）：
      // 否则淡化窗口内连点「下一首」（A→B→A，旧 A 被复用为当前声道）时，
      // 旧定时器到点会把**正在播放的** A 元素 pause 掉 —— 表现为「显示播放中但没声音」。
      clearTimeout(this.fadeTimer);
      this.fadeTimer = setTimeout(() => {
        this.fadeTimer = null;
        // 双保险：只有当该元素已不是当前声道时才允许停，避免任何跨声道误停
        const cur = this.channels[this.active];
        if (cur && cur.el === el) return;
        try { el.pause(); } catch { }
      }, fade * 1000 + 120);
    }

    this.active = n;
    this.idx = i;
    this.playing = true;
    this.wasDucked = false;
    this.preloadNext();
    this.emit();
  }

  // 预加载下一首，保证切换无起播卡顿（复用同一个 Audio 元素，避免内存泄漏）
  preloadNext() {
    if (this.playlist.length < 2) return;
    const next = this.playlist[(this.idx + 1) % this.playlist.length];
    // 冷门格式 Chromium 解不了，预加载原文件只会报错；这种等真正切到时再转码播放
    const dot = next.lastIndexOf('.');
    const ext = dot >= 0 ? next.slice(dot).toLowerCase() : '';
    if (!SAFE_AUDIO_EXT.has(ext)) return;
    if (this.preloader) {
      if (this.preloader.dataset.src === next) return;
      this.preloader.src = '';
    } else {
      this.preloader = new Audio();
      this.preloader.preload = 'auto';
    }
    this.preloader.dataset.src = next;
    this.preloader.src = this.fileUrl(next);
  }

  toggle() {
    if (!this.playlist.length) return false;
    if (this.playing) this.pause(); else this.resume();
    return true;
  }

  pause() {
    if (!this.playing || !this.ctx) return;
    const ch = this.channels[this.active];
    const now = this.ctx.currentTime;
    ch.gain.gain.cancelScheduledValues(now);
    ch.gain.gain.setValueAtTime(Math.max(0.0001, ch.gain.gain.value), now);
    ch.gain.gain.linearRampToValueAtTime(0.0001, now + this.ppFade);
    const el = ch.el;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => { try { el.pause(); } catch { } }, this.ppFade * 1000 + 60);
    this.playing = false;
    this.emit();
  }

  resume() {
    if (this.idx < 0) return;
    this.ensureCtx();
    // 取消 pause() 遗留的延迟暂停，否则快速「暂停→继续」会把刚恢复的元素又停掉
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    clearTimeout(this.fadeTimer); // 同理作废跨歌淡出的待停任务（BUG-D）
    this.fadeTimer = null;
    const ch = this.channel(this.active);
    const now = this.ctx.currentTime;
    ch.el.play().catch(() => { });
    ch.gain.gain.cancelScheduledValues(now);
    ch.gain.gain.setValueAtTime(0.0001, now);
    ch.gain.gain.linearRampToValueAtTime(1, now + Math.max(0.05, this.ppFade));
    this.playing = true;
    this.wasDucked = false;
    this.emit();
  }

  next() {
    if (!this.playlist.length) return;
    this.startTrack((this.idx + 1) % this.playlist.length, this.crossfade);
  }

  prev() {
    if (!this.playlist.length) return;
    this.startTrack((this.idx - 1 + this.playlist.length) % this.playlist.length, this.crossfade);
  }

  // 放映 PPT / 播视频前：淡出并暂停，记住现场
  // immediate=true（播视频时用）：不等淡出，直接掐断 —— 否则视频已经出声、音乐还在
  // 0.5s 淡出尾巴里，每次起播都有半秒「撞音」（BUG-C）。
  duck(immediate = false) {
    if (!this.playing) return;
    this.wasDucked = true;
    if (!immediate) { this.pause(); return; }
    const ch = this.channels[this.active];
    clearTimeout(this.pauseTimer); this.pauseTimer = null;
    clearTimeout(this.fadeTimer); this.fadeTimer = null;
    if (ch && this.ctx) {
      const now = this.ctx.currentTime;
      ch.gain.gain.cancelScheduledValues(now);
      ch.gain.gain.setValueAtTime(0.0001, now);
      try { ch.el.pause(); } catch { }
    }
    this.playing = false;
    this.emit();
  }

  // 退出投屏后：从暂停处淡入恢复
  restore() {
    if (this.wasDucked && !this.playing) {
      this.wasDucked = false;
      this.resume();
    }
  }

  currentTrackName() {
    if (this.idx < 0) return '';
    const f = this.playlist[this.idx] || '';
    return f.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  }

  emit() {
    this.onState({
      playing: this.playing,
      category: this.category,
      track: this.currentTrackName(),
      index: this.idx,
      volume: this.volume,
      muted: this.muted,
      loopMode: this.loopMode,
    });
  }
}

window.engine = new AudioEngine();
