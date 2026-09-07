/* ===== 音乐引擎：Web Audio 双通道交叉淡入淡出 ===== */
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
        // 单曲循环由 el.loop 处理；列表模式自然播完 → 交叉淡入下一首
        if (i === this.active && this.playing && this.loopMode !== 'single') this.next();
      });
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

  setLoopMode(m) { this.loopMode = m; if (this.channels[this.active]) this.channels[this.active].el.loop = m === 'single'; this.emit(); }
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

  startTrack(i, fadeSec) {
    this.ensureCtx();
    clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const n = 1 - this.active;
    const ch = this.channel(n);
    const now = this.ctx.currentTime;
    const fade = Math.max(0.05, fadeSec);

    ch.el.src = this.fileUrl(this.playlist[i]);
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
      setTimeout(() => { try { el.pause(); } catch { } }, fade * 1000 + 120);
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
  duck() {
    if (!this.playing) return;
    this.wasDucked = true;
    this.pause();
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
      loopMode: this.loopMode,
    });
  }
}

window.engine = new AudioEngine();
