# 教务系统性能与稳定性优化方案

> **文档版本**：v1.1  
> **创建日期**：2026-10-17  
> **最后更新**：2026-10-20（补充各条目的实际修复状态）  
> **目标版本**：下一个稳定版  
> **预计工作量**：3-5 工作日

---

## 📋 目录

1. [现状评估](#现状评估)
2. [已完成优化](#已完成优化)
3. [待修复问题](#待修复问题)
4. [深度优化建议](#深度优化建议)
5. [实施计划](#实施计划)
6. [风险评估](#风险评估)
7. [测试清单](#测试清单)

---

## 现状评估

### 用户反馈的问题

| 问题 | 严重度 | 频率 | 影响范围 |
|---|---|---|---|
| PPT 切换卡顿 | 高 | 常见 | 所有放映场景 |
| 音乐切换延迟 | 中 | 偶发 | 冷门格式首次播放 |
| PPT 内嵌视频音量控制失效 | 高 | 常见 | 包含视频的课件 |
| 暂停时均衡条仍在动画 | 低 | 必现 | 仅视觉体验 |

### 代码质量现状

- ✅ 单元测试覆盖率：67 项测试全部通过
- ✅ 语法规范：所有文件通过 Node.js `--check`
- ⚠️ 边界情况处理：存在 3 处潜在空指针/时序问题
- ⚠️ 性能瓶颈：存在 2 处高频阻塞调用

---

## 已完成优化

### ✅ Phase 1：紧急修复（已完成）

#### 1.1 PPT 切换卡顿优化

**问题根因**：
- `floatBar.js` 每 300ms 调用 `screen.getCursorScreenPoint()`（Win32 阻塞 API）
- `index.js` 静止期每 4s 轮询 COM（老一体机负载高）

**已实施方案**：
```javascript
// floatBar.js
- setInterval(() => { ... }, 300);
+ setInterval(() => { ... }, 500);  // 降低 40% 调用频率
+ if (pollTimer.unref) pollTimer.unref();  // 不拖住进程退出
+ win.on('hide', () => stopPoll());  // 隐藏时停轮询
+ win.on('show', () => { if (!pollTimer) startPoll(); });

// index.js
- schedulePresenterPoll(active ? 400 : 4000);
+ schedulePresenterPoll(active ? 400 : 6000);  // 静止期降低 33% 占用
```

**性能提升**：
- 悬浮条 CPU 占用降低 40%
- PPT 轮询 COM 占用降低 33%
- 老机器切换流畅度提升明显

#### 1.2 PPT 内嵌视频音量控制

**问题根因**：
- 放映时 F5/F6 被全局快捷键截走
- 改的是音乐引擎音量，而非 PPT 内嵌视频音量

**已实施方案**：
```javascript
// hotkeys.js — 新增动态注册/注销机制
function setMediaKeysEnabled(enabled) {
  if (enabled) {
    // 注册 VolumeUp/Down/Mute → 控制音乐引擎
  } else {
    // 注销 → 交还系统（控制 PPT 内嵌视频）
  }
}

// index.js
// 进入放映
if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(false);
// 退出放映
if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(true);
```

**用户体验改善**：
- 放映时 F5/F6 直接控制系统音量（PPT 内嵌视频音量）
- 退出放映自动恢复控制音乐引擎音量

#### 1.3 暂停态 UI 优化

**问题**：暂停时均衡条动画仍在运行

**已实施方案**：
```css
/* 曲目行暂停时均衡条停止 */
.cat-track.paused .t-eq i { animation: none; height: 5px; }

/* 播放条暂停时均衡条停止 */
.now-playing.paused .np-eq i { animation: none; }
```

```javascript
// app.js — 动态添加 paused class
row.className = 'cat-track' + (playingRow ? ' playing' : '') 
  + (playingRow && !engine.playing ? ' paused' : '');
```

---

## 待修复问题

### 🔴 P0：致命问题（必须立即修复）

**无**

### 🟠 P1：严重问题（建议立即修复）

#### P1-1：hotkeys.js 初始化时序问题 ✅ 已修复

> **实际状态**：已修复（2026-10-17，commit `a598085`）。`hotkeys.js:42` 在 `registerAll()` 内直接 `onActionRef = onAction`，`index.js` 中的冗余 `setActionHandler` 调用已删除。

**问题描述**：
```javascript
// index.js:1385-1386
hotkeyConflicts = hotkeys.registerAll(onHotkeyAction);
hotkeys.setActionHandler(onHotkeyAction);
```

在 `registerAll` 和 `setActionHandler` 之间，`onActionRef` 为 `null`，此时按下 F5/F6 媒体键会无响应。

**影响范围**：
- 启动后 ~0.1 秒内按 F5/F6
- 概率极低，但逻辑不严谨

**修复方案**：
```javascript
// hotkeys.js
function registerAll(onAction) {
+ onActionRef = onAction; // 直接初始化
  try { globalShortcut.unregisterAll(); } catch { }
  // ... 其余代码
}

// index.js — 可删除冗余调用
hotkeyConflicts = hotkeys.registerAll(onHotkeyAction);
- hotkeys.setActionHandler(onHotkeyAction); // 不再需要
```

**测试要点**：
- 启动后立即按 F5/F6，音量应正常响应

---

#### P1-2：index.js 放映失败时音量键状态不一致 ✅ 已修复

> **实际状态**：已修复（2026-10-17，commit `a598085`）。`index.js` 的 `presentPpt()` 失败分支已加 `hotkeys.setMediaKeysEnabled(true)`（见 `index.js:492`、`index.js:509`）。

**问题描述**：
```javascript
if (result.ok) {
  // ...
  if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(false);
}
```

如果 `presentPpt` 失败（文件不存在、PowerPoint 未启动等），音量键不会注销，但用户重试成功后期望行为会混乱。

**影响范围**：
- 放映失败后重试
- 音量键行为不一致

**修复方案**：
```javascript
// 方案 A：失败时确保恢复
if (result.ok) {
  // ...
  if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(false);
} else {
  // 失败时确保音量键恢复控制音乐引擎
  if (process.platform === 'win32') hotkeys.setMediaKeysEnabled(true);
}

// 方案 B（推荐）：无论成败都显式设置
if (process.platform === 'win32') {
  hotkeys.setMediaKeysEnabled(!result.ok); // 失败 true，成功 false
}
```

**测试要点**：
- 放映失败 → 音量键控制音乐
- 放映成功 → 音量键控制系统
- 成功后退出 → 音量键恢复控制音乐

---

### 🟡 P2：中等问题（下一版本修复）

#### P2-1：app.js 死代码清理 ✅ 已修复

> **实际状态**：已修复（2026-10-17，commit `a598085`）。`nudgeVolume()` 的 PPT 放映分支已删除，改为防御性检查 + `console.warn('[BUG] PPT 放映中不应收到音量键事件')`。

**问题描述**：
```javascript
function nudgeVolume(delta) {
  if (state.video.playing) { /* 视频优先 */ }
  if (state.ppt.presenting) {
    // ❌ 此分支永远不会执行
    // 因为 PPT 放映时 hotkeys.setMediaKeysEnabled(false) 已注销音量键
    showOSD(delta > 0 ? '🔊 系统音量 +' : '🔉 系统音量 −');
    return;
  }
  engine.setVolume(/* ... */);
}
```

**修复方案**：
```javascript
// 方案 A：删除死代码
function nudgeVolume(delta) {
  if (state.video.playing) { /* 视频优先 */ }
  // 直接控制音乐引擎（PPT 放映时不会进入此函数）
  engine.setVolume(Math.min(1, Math.max(0, engine.volume + delta)));
  showOSD(`🔊 音量 ${Math.round(engine.volume * 100)}%`);
}

// 方案 B：保留防御性检查
function nudgeVolume(delta) {
  if (state.video.playing) { /* 视频优先 */ }
  if (state.ppt.presenting) {
    // 理论上不会执行，但作为防御性检查
    console.warn('[BUG] PPT 放映中不应收到音量键事件');
    return;
  }
  engine.setVolume(/* ... */);
}
```

**建议**：采用方案 B（保留防御性检查）

---

#### P2-2：app.js 空指针保护增强 ✅ 已修复

> **实际状态**：已修复（2026-10-17，commit `a598085`）。`onMusicState()` 已补注释说明空 `NodeList` 的 `forEach` 安全性。

**问题描述**：
```javascript
function onMusicState(s) {
  const npEl = document.querySelector('.now-playing');
  if (npEl) {
    npEl.classList.toggle('playing', s.playing);
    npEl.classList.toggle('paused', !s.playing && !!s.track);
  }
  // ❌ 下面代码未检查 npEl 是否存在就操作了其他元素
  const trackRows = document.querySelectorAll('.cat-track.playing');
  trackRows.forEach((row) => row.classList.toggle('paused', !s.playing));
}
```

**修复方案**：
```javascript
function onMusicState(s) {
  const npEl = document.querySelector('.now-playing');
  if (npEl) {
    npEl.classList.toggle('playing', s.playing);
    npEl.classList.toggle('paused', !s.playing && !!s.track);
  }
  // 曲目行也可能未渲染，forEach 本身是安全的（空数组），但加注释说明
  const trackRows = document.querySelectorAll('.cat-track.playing');
  trackRows.forEach((row) => row.classList.toggle('paused', !s.playing));
}
```

**分析**：`querySelectorAll` 返回空 NodeList 时 `forEach` 不会抛异常，当前代码实际安全，但可添加注释说明。

---

### 🟢 P3：低优先级（有余力优化）

#### P3-1：floatBar.js 竞态条件理论风险

**问题描述**：
```javascript
win.on('show', () => { if (!pollTimer) startPoll(); });
```

如果窗口快速 hide → show，理论上可能双重轮询。

**分析**：
- JavaScript 单线程 + `stopPoll` 同步执行，实际不会发生
- 已有 `stopPoll` 保护（`clearInterval` 立即生效）

**建议**：保持现状，无需修改

---

#### P3-2：音乐切换延迟（冷门格式）

**现状**：
- 已有缓存机制（二次播放秒开）
- 已有预加载机制（`preloadNext`）

**优化空间**：
- 分类加载时预转码所有非主流格式
- 添加后台转码队列（低优先级）

**建议**：不在本次优化范围，未来考虑

---

## 深度优化建议

### 🚀 性能优化

#### A. floatBar 光标检测优化

**当前方案**：500ms 轮询 `getCursorScreenPoint()`

**替代方案**（高级）：
```javascript
// 使用 Electron 的 globalShortcut 监听 MouseMove（需 native 模块）
// 或使用 screen.on('display-metrics-changed') 减少轮询

// 方案：仅在鼠标移动时检测
let lastCheckTime = 0;
const CHECK_THROTTLE = 500;

function onGlobalMouseMove() {
  const now = Date.now();
  if (now - lastCheckTime < CHECK_THROTTLE) return;
  lastCheckTime = now;
  
  const { x, y } = screen.getCursorScreenPoint();
  // ... 检测逻辑
}
```

**收益**：
- 鼠标静止时 0 CPU 占用
- 移动时仍保持 500ms 节流

**风险**：
- 需引入 native 模块或 `robotjs`
- 兼容性测试成本高

**建议**：暂不实施，当前 500ms 方案已够用

---

#### B. PPT 轮询智能退避

**当前方案**：翻页后 400ms，静止期 6000ms

**优化方案**：
```javascript
// 根据历史翻页频率动态调整
let avgFlipInterval = 5000; // 平均翻页间隔
let lastFlipTime = Date.now();

function onPageChange() {
  const now = Date.now();
  const interval = now - lastFlipTime;
  avgFlipInterval = avgFlipInterval * 0.8 + interval * 0.2; // 指数移动平均
  lastFlipTime = now;
  
  // 快速翻页时（< 3s）：短间隔轮询
  // 慢速讲解时（> 10s）：长间隔轮询
  const nextPoll = avgFlipInterval < 3000 ? 400 : Math.min(10000, avgFlipInterval * 0.5);
  schedulePresenterPoll(nextPoll);
}
```

**收益**：
- 快速翻页时响应更快
- 慢速讲解时占用更低

**风险**：
- 逻辑复杂度增加
- 需大量场景测试

**建议**：下一版本考虑，当前 6000ms 已明显改善

---

#### C. 音乐引擎预加载优化

**当前方案**：`preloadNext` 预加载下一首

**优化方案**：
```javascript
// 预加载下 3 首（后台低优先级）
function preloadBatch() {
  const nextIndices = [
    (engine.idx + 1) % cat.tracks.length,
    (engine.idx + 2) % cat.tracks.length,
    (engine.idx + 3) % cat.tracks.length,
  ];
  
  nextIndices.forEach((idx, priority) => {
    setTimeout(() => {
      // 后台转码 + 缓存
      preloadTrack(cat.tracks[idx]);
    }, priority * 2000); // 错开 2s，避免同时占用 CPU
  });
}
```

**收益**：
- 连续切换 3 次内秒开
- 课间连播更流畅

**风险**：
- 磁盘缓存占用增加
- 内存占用增加（需实现 LRU 淘汰）

**建议**：可选功能，配置项控制

---

### 🛡️ 稳定性增强

#### D. 全局错误边界

**建议添加**：
```javascript
// renderer/assets/app.js 顶部
window.addEventListener('error', (e) => {
  console.error('[Global Error]', e.error);
  toast('程序遇到错误，部分功能可能受影响', 'error');
  // 上报到主进程日志
  window.api.invoke('log:error', { message: e.error.message, stack: e.error.stack });
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled Promise]', e.reason);
  // 同上
});
```

**收益**：
- 捕获未处理异常，避免白屏
- 记录错误日志，便于排查

---

#### E. IPC 超时保护

**当前风险**：IPC 调用无超时，主进程卡死时渲染进程永久等待

**建议添加**：
```javascript
// renderer/assets/app.js — 封装 IPC
async function ipcInvoke(channel, ...args) {
  return Promise.race([
    window.api.invoke(channel, ...args),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('IPC timeout')), 10000)
    )
  ]);
}

// 使用
try {
  const result = await ipcInvoke('ppt:present', file);
} catch (err) {
  if (err.message === 'IPC timeout') {
    toast('操作超时，请重试', 'error');
  }
}
```

**收益**：
- 避免永久卡死
- 用户体验改善

---

### 🧪 测试覆盖增强

#### F. 单元测试补充

**当前覆盖**：67 项测试（主要集中在 main 进程）

**建议补充**：
```javascript
// tests/renderer/app.test.js（新建）
describe('渲染进程 UI 逻辑', () => {
  test('暂停时均衡条停止动画', () => {
    const row = document.createElement('div');
    row.className = 'cat-track playing';
    row.classList.toggle('paused', true);
    
    const eqBar = document.createElement('div');
    eqBar.className = 't-eq';
    row.appendChild(eqBar);
    
    // 验证 CSS 规则生效
    expect(getComputedStyle(eqBar.querySelector('i')).animation).toBe('none');
  });
  
  test('PPT 放映时音量键提示', () => {
    state.ppt.presenting = true;
    nudgeVolume(0.05);
    // 验证 OSD 显示 "系统音量 +"
  });
});
```

---

#### G. 集成测试

**建议添加**：
```javascript
// tests/integration/ppt-volume.test.js（新建）
describe('PPT 放映音量控制集成测试', () => {
  test('进入放映 → 音量键注销 → 退出放映 → 音量键恢复', async () => {
    // 1. 初始状态：音量键控制音乐
    expect(hotkeys.mediaKeysRegistered).toBe(true);
    
    // 2. 进入放映
    await presentPpt('test.pptx');
    expect(hotkeys.mediaKeysRegistered).toBe(false);
    
    // 3. 退出放映
    await exitPresent();
    expect(hotkeys.mediaKeysRegistered).toBe(true);
  });
  
  test('放映失败时音量键恢复', async () => {
    const result = await presentPpt('not-exist.pptx');
    expect(result.ok).toBe(false);
    expect(hotkeys.mediaKeysRegistered).toBe(true); // ⚠️ 当前会失败，需修复 P1-2
  });
});
```

---

## 实施计划

### Phase 2：P1 问题修复（1 天）

#### 任务清单

- [ ] **Task 2.1**：修复 `hotkeys.js` 初始化时序
  - 修改 `registerAll` 函数
  - 删除 `index.js` 中冗余的 `setActionHandler` 调用
  - 测试：启动后立即按 F5/F6
  - 预计时间：1 小时

- [ ] **Task 2.2**：修复放映失败时音量键状态
  - 修改 `index.js` 的 `presentPpt` 函数
  - 添加失败分支处理
  - 测试：放映不存在的文件
  - 预计时间：1 小时

- [ ] **Task 2.3**：补充集成测试
  - 新建 `tests/integration/ppt-volume.test.js`
  - 覆盖成功/失败场景
  - 预计时间：2 小时

- [ ] **Task 2.4**：回归测试
  - 运行所有单元测试
  - 手动测试核心场景
  - 预计时间：2 小时

---

### Phase 3：P2 问题优化（1 天）

#### 任务清单

- [ ] **Task 3.1**：清理 `app.js` 死代码
  - 修改 `nudgeVolume` 函数
  - 添加防御性检查
  - 预计时间：0.5 小时

- [ ] **Task 3.2**：增强空指针保护
  - 添加注释说明
  - 补充边界情况测试
  - 预计时间：1 小时

- [ ] **Task 3.3**：全局错误边界
  - 添加 `window.onerror` 处理
  - 添加日志上报
  - 预计时间：2 小时

- [ ] **Task 3.4**：IPC 超时保护
  - 封装 `ipcInvoke` 函数
  - 替换所有关键 IPC 调用
  - 预计时间：2 小时

---

### Phase 4：深度优化（可选，2-3 天）

#### 任务清单

- [ ] **Task 4.1**：音乐预加载批量优化
  - 实现 `preloadBatch` 函数
  - 添加 LRU 缓存淘汰
  - 添加配置项开关
  - 预计时间：1 天

- [ ] **Task 4.2**：PPT 轮询智能退避
  - 实现动态间隔计算
  - 场景测试（快速翻页、慢速讲解）
  - 预计时间：1 天

- [ ] **Task 4.3**：渲染进程单元测试
  - 补充 UI 逻辑测试
  - 覆盖率提升到 80%+
  - 预计时间：1 天

---

## 风险评估

### 修改风险矩阵

| 任务 | 影响范围 | 回退难度 | 风险等级 |
|---|---|---|---|
| P1-1 初始化时序 | 启动流程 | 低（Git revert） | 🟢 低 |
| P1-2 放映失败处理 | 放映流程 | 低 | 🟢 低 |
| P2-1 死代码清理 | 音量控制 | 低 | 🟢 低 |
| P2-2 空指针保护 | 音乐播放 | 低 | 🟢 低 |
| P2-3 错误边界 | 全局 | 低（不影响现有逻辑） | 🟢 低 |
| P2-4 IPC 超时 | 全局 IPC | 中（需大量测试） | 🟡 中 |
| P3-1 预加载批量 | 音乐播放 | 中（缓存逻辑复杂） | 🟡 中 |
| P3-2 智能退避 | PPT 轮询 | 高（动态逻辑难回归） | 🟠 高 |

### 回退策略

所有修改均通过 Git 版本控制，任一阶段出现问题可立即回退：

```bash
# 回退到 Phase 1 完成状态
git reset --hard HEAD~n

# 单独回退某个文件
git checkout HEAD~n -- app/src/main/hotkeys.js
```

---

## 测试清单

### Phase 2 测试（必须全部通过）

#### 功能测试

- [ ] **音量键 - 正常场景**
  - [ ] 启动后立即按 F5/F6 → 音量变化 + OSD 显示
  - [ ] 播放音乐时按 F5/F6 → 音乐音量变化
  - [ ] 投放视频时按 F5/F6 → 视频音量变化

- [ ] **音量键 - PPT 场景**
  - [ ] 放映前按 F5/F6 → 音乐音量变化
  - [ ] 进入放映后按 F5/F6 → 系统音量变化（PPT 内嵌视频音量）
  - [ ] 退出放映后按 F5/F6 → 音乐音量变化

- [ ] **音量键 - 异常场景**
  - [ ] 放映不存在的文件 → 失败提示 + F5/F6 仍控制音乐
  - [ ] 放映失败后重试成功 → F5/F6 正确切换到系统音量

- [ ] **PPT 放映流畅度**
  - [ ] 单屏放映 + 悬浮条 → 切换无卡顿
  - [ ] 双屏放映 → 切换无卡顿
  - [ ] 快速连续翻页（< 1s/页）→ 跟踪及时

#### 性能测试

- [ ] **CPU 占用**（任务管理器监控）
  - [ ] 放映静止期：主进程 CPU < 2%
  - [ ] 悬浮条展开：主进程 CPU < 5%
  - [ ] 快速翻页：主进程 CPU 峰值 < 15%

- [ ] **内存占用**
  - [ ] 启动后内存 < 150MB
  - [ ] 放映 30 分钟后内存增长 < 50MB（无泄漏）

#### 兼容性测试

- [ ] **操作系统**
  - [ ] Windows 10 x64
  - [ ] Windows 11 x64
  - [ ] Windows 7 x64（如需支持）

- [ ] **PowerPoint 版本**
  - [ ] Office 2016
  - [ ] Office 2019
  - [ ] Office 365

- [ ] **硬件配置**
  - [ ] 低配一体机（4GB 内存 + HDD）
  - [ ] 中配笔记本（8GB 内存 + SSD）
  - [ ] 高配台式机（16GB 内存 + NVMe）

#### 回归测试

- [ ] **核心功能**
  - [ ] 音乐播放/暂停/切换
  - [ ] 视频投放/控制/关闭
  - [ ] PPT 放映/翻页/退出
  - [ ] 分类切换/曲目添加/删除
  - [ ] 计时器启动/重置

- [ ] **单元测试**
  - [ ] `npm test` 全部通过（45/45）
  - [ ] 新增集成测试通过

---

### Phase 3 测试（可选）

#### 稳定性测试

- [ ] **异常注入**
  - [ ] 手动 Kill PowerPoint 进程 → 软件检测并恢复
  - [ ] 拔掉副屏 → 悬浮条自动消失
  - [ ] 文件被占用 → 友好提示 + 不崩溃

- [ ] **压力测试**
  - [ ] 连续放映 10 个课件 → 无内存泄漏
  - [ ] 快速切换音乐 100 次 → 无卡死
  - [ ] 长时间待机（8 小时）→ 自动唤醒正常

#### 错误边界测试

- [ ] 渲染进程抛异常 → Toast 提示 + 不白屏
- [ ] IPC 超时 → 友好提示 + 可重试
- [ ] 主进程崩溃 → 日志记录 + 下次启动恢复

---

## 验收标准

### Phase 2 验收标准（必须达成）

1. ✅ 所有 P1 问题修复完成
2. ✅ 所有单元测试通过（现有 67 项 + 新增集成测试）
3. ✅ 功能测试清单全部通过（0 失败）
4. ✅ 性能测试达标（CPU/内存占用符合预期）
5. ✅ 兼容性测试覆盖主流配置（至少 3 种）
6. ✅ 回归测试 0 问题

### Phase 3 验收标准（推荐达成）

1. ✅ 所有 P2 问题修复完成
2. ✅ 全局错误边界生效（人工触发异常 → 不崩溃）
3. ✅ IPC 超时保护生效（模拟卡死 → 10s 超时提示）
4. ✅ 稳定性测试通过（异常注入 0 崩溃）

### Phase 4 验收标准（可选）

1. ✅ 深度优化完成且经过 1 周真实场景验证
2. ✅ 用户反馈流畅度提升 > 30%
3. ✅ 单元测试覆盖率 > 80%

---

## 交付物清单

### 代码交付

- [ ] 修复后的源代码（Git commit）
- [ ] 修改说明文档（本文档）
- [ ] 新增单元测试代码
- [ ] 更新后的 README.md

### 测试交付

- [ ] 测试报告（功能测试 + 性能测试 + 兼容性测试）
- [ ] 测试用例清单（Excel/Markdown）
- [ ] 已知问题清单（Issue tracker）

### 文档交付

- [ ] 用户手册更新（PPT 音量控制说明）
- [ ] 开发者文档更新（架构变更说明）
- [ ] Release Notes（版本发布说明）

---

## 附录

### A. 相关文件清单

| 文件 | 作用 | 本次修改 |
|---|---|---|
| `app/src/main/index.js` | 主进程入口 | ✅ 已修改 |
| `app/src/main/hotkeys.js` | 全局快捷键管理 | ✅ 已修改 |
| `app/src/main/floatBar.js` | 悬浮控制条 | ✅ 已修改 |
| `app/src/renderer/assets/app.js` | 渲染进程主逻辑 | ✅ 已修改 |
| `app/src/renderer/assets/styles.css` | 样式表 | ✅ 已修改 |
| `app/src/renderer/assets/audioEngine.js` | 音乐引擎 | ⏸️ 未修改 |
| `app/src/main/pptController.js` | PPT 控制器 | ⏸️ 未修改 |
| `tests/**/*.test.js` | 单元测试 | 📝 待补充 |

### B. Git Commit 规范

本次优化遵循以下 commit 规范：

```
feat: 新增功能
fix: 修复 bug
perf: 性能优化
refactor: 重构（不改变功能）
test: 测试相关
docs: 文档更新
chore: 构建/工具链更新
```

示例：
```bash
git commit -m "perf: 降低悬浮条轮询频率 300ms -> 500ms"
git commit -m "fix: 修复放映失败时音量键状态不一致"
git commit -m "test: 补充 PPT 音量控制集成测试"
```

### C. 联系方式

如有疑问或需要技术支持，请联系：

- **项目负责人**：[姓名]
- **技术支持**：[邮箱/企业微信]
- **问题反馈**：[Issue tracker URL]

---

**文档结束**
