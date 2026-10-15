# 小天AIGC · 播放冲突 / BUG / 阻塞 专项审查

> 审查日期：2026-10-11　范围：`I:\教务系统\app` 全量源码
> 方法：全量源码逐行审查（主进程 24 文件 + 6 个 preload 桥 + 渲染层），`npm test` 44 项基线，
> 全量 `node --check` 语法校验，Electron 33.4.11 实机探针取证。
> 说明：上一轮 `发布前审计报告.md`（09-20）的 P0/P1 已默认修复、不重复计列。
> 但 **09-21 新增的 `peer.js` / `peerClient.js` / `player.js` 及 `index.js`、`app.js` 的改动不在旧报告覆盖范围内**，是本轮重点。

---

## 一、总体结论

**没有崩溃级致命缺陷，也不需要重写。** 测试全绿、语法全通过、主进程无 `execSync/spawnSync` 热点、
无路径穿越与 IPC 越权新缺口。但有 **1 条真实可复现的播放冲突** 和 **4 条同屏（无线投屏）状态残留**，
外加 **4 条主进程阻塞路径**，建议发布前修完前三组。

| 等级 | 数量 | 摘要 |
|---|---|---|
| 🔴 阻塞 | 5 | 1 条双音频同时播放；4 条主进程同步 IO 冻结 |
| 🟠 高 | 7 | 同屏端口/信标残留 3 条；投屏未静音、撞音、跨歌定时器 |
| 🟡 中 | 8 | 状态不同步、失败无兜底、配置静默丢失、O(N²)、孤儿 ffmpeg |
| 🟢 低 | 2 | 纵深防御、局域网暴露面 |

---

## 二、播放冲突（本次重点）

### 🔴 BUG-A：视频 / PPT 投放中按「播放」，音乐与视频同时出声

**这是本次唯一确认的、可稳定复现的双音频冲突。**

仲裁是**单向**的：只有视频主动让位音乐，没有音乐让位视频。

- 视频起播时主动 duck：`main/index.js:559`、`main/index.js:569` → `broadcast('music:restore',{action:'duck'})` → `app.js:151` → `audioEngine.js:268 duck()`。
- **但音乐侧的所有播放入口都不检查 `state.video.playing` / `state.ppt.presenting`**：

| 入口 | 位置 | 代码 |
|---|---|---|
| 播放/暂停快捷键 | `app.js:1056` | `case 'playPause': engine.toggle(); break;` |
| 分类播放（面板点击 / F1·F2 / 遥控端） | `app.js:1073` | `engine.playCategory(cat.category);` |
| 遥控端下发 | `main/index.js:443` | `forwardHotkey(act)` → 同上 |

**反证（说明作者已知冲突、只是漏了播放入口）**：同一文件 `app.js:1078 nudgeVolume` 明确写了
`if (state.video.playing) { window.api.invoke('video:control', …); return; }` —— 音量键已经让位给视频了，
唯独播放入口没有。

**后果**：视频投放中按 F1（或点任一分类▶）→ `engine.toggle()` 发现 `playing=false`（刚被 duck 过）→
走 `resume()` 分支，`audioEngine.js:253` 把 `wasDucked` 复位 → 音乐恢复播放，**视频并未停止**。
教室里两个声源叠加，而且此时按音量键只会调视频音量（走上面那条 `nudgeVolume` 分支），用户越调越乱。

**修法**：把 `nudgeVolume:1078` 已有的判定复制到播放入口即可，改动最小且天然覆盖快捷键与遥控两条路径：

```js
function guardMusicStart() {
  if (state.video.playing) { toast('视频投放中，请先停止视频再播放音乐', 'warn'); return false; }
  if (state.ppt.presenting) { toast('PPT 放映中，请先退出放映再播放音乐', 'warn'); return false; }
  return true;
}
// engine.toggle() / engine.playCategory() / engine.playTrack() 调用前先过这道闸
```

---

### 🟠 BUG-B：LED 模式内联投屏未静音

- 发送端在 `castServer.js:394` 是 `getDisplayMedia({ video:{…}, audio: false })` —— **正常手机投屏本就不带音频**。
- 控制台模式的接收窗也确实静音：`caster.html:38` `muted autoplay`。
- **但 LED 模式走的是另一条内联接收**：`app.js:2196 startInlineReceiver` → `app.js:2203-2211`
  → `castReceiver.js:36-41` `pc.ontrack` 直接 `video.srcObject = …; video.play()`，**从未设 `muted`**，
  而它用的正是 `index.html:33` 的 `<video id="ledVideo">`。

两条接收路径的静音策略不一致。一旦发送端设备共享了系统声音（本机系统音、非 getDisplayMedia 采集但同设备播放），
本机音乐 + 投屏音频会在同一台机器上叠加。

**修法**：`castReceiver.js:36-41` 的 `ontrack` 里补 `video.muted = true;`，与 `caster.html:38` 对齐。

---

### 🟠 BUG-C：每次起播视频有约 0.5 秒「撞音」

`main/index.js:559/569` 先广播 duck，紧接着同一函数里广播 `video:load`。
而 `audioEngine.pause()`（`audioEngine.js:226-238`）只把增益在 `ppFade`（默认 0.5s）内降到底、
再加 60ms 才 `el.pause()`。于是每次点视频，音乐仍在淡出、视频已经出声 → 约半秒叠加。

**修法**：duck 时直接停（不淡出），或在 `video:load` 前等 `ppFade` 完成。

---

### 🟠 BUG-D：跨歌淡出的定时器没被跟踪，可造成「显示播放中但没声音」

`audioEngine.js:190`：

```js
setTimeout(() => { try { el.pause(); } catch { } }, fade * 1000 + 120);
```

这个 id **没有存下来**。而 `startTrack`（`:155`）与 `resume`（`:244`）只 `clearTimeout(this.pauseTimer)`，管不到它。
在 2 秒交叉淡化窗口内连点「下一首」（A→B→A），旧定时器到点后会把**已被复用为当前声道**的 A 元素 `pause()` 掉。

结果：`engine.playing` 仍为 `true`，面板显示播放中，实际无声，需手动暂停/下一首才恢复。

**修法**：把该 id 存进 `this.fadeTimer`，在 `startTrack`/`resume` 一并 `clearTimeout`；
或回调内加守卫 `if (this.channels[this.active]?.el !== el) return;`。

---

### ✅ 已排除：视频窗口「旧窗口误杀新窗口」竞态（我怀疑过，实测不成立）

我怀疑 `videoWindow.js:57-62` 的 `win.on('closed')` 回调读取模块级 `win`（`:58 const had = !!win`），
在 `stop()`→`play()` 连调时会把新窗口引用清空，导致僵尸窗口（画面还在播但 `stop()` 够不着、音乐被误恢复 → 双音频）。

**实测结论：不存在。** Electron 33.4.11 探针（`test-artifacts/` 临时脚本，已清理）结果：

```
closed#1: 此刻 win 非空(读到新窗口)? false
destroy() 返回时 closed 已同步触发? true
```

`closed` 在 `destroy()` **内部同步**触发，而 `stop()`（`videoWindow.js:103-109`）是先 `win = null` 再 `destroy()`，
所以回调读到的是 `null` → `had=false` → 不会误清新窗口。**代码是对的，不需改动。**

---

## 三、阻塞问题（主进程事件循环冻结）

| 等级 | 位置 | 问题 | 影响 |
|---|---|---|---|
| 🔴 | `library.js:117` `readdirSync` + `:124` `statSync`；调用点 `index.js:578-581`、`639-644`、`672-678`；`index.js:474`（遥控命令内） | 全量同步扫描。每个文件实际 **5 次 `statSync`**（safeStat 1 次 + `decorateThumbs→cached` 2 次 + `requestThumbs→cached` 再 2 次）；`deleteFile` 失败重试还会跑两遍 `freshLists` | 500 文件热缓存实测 ≈130ms；教室一体机冷缓存 + 杀软实时扫描按 5~8× 折算 ≈0.7~1s，库在网络盘/U 盘可达 10s+。**期间菜单、窗口拖动、全局快捷键、250ms 计时 tick 全部冻结** |
| 🔴 | `castServer.js:679` → `ensureCert()`（`:123,138,150-152`） | 开启无线同屏时**同步**跑 forge RSA-2048 keygen + 签名 + 指纹 | 本机实测 91ms；低端一体机 ×5~8 → **0.5~0.8s 主进程无响应**，点「无线同屏」像假死 |
| 🔴 | `index.js:281-282` → `pptExport.sweep()` / `transcode.sweepMediaCache()` | 模块顶层（app ready 之前）执行 `readdirSync` + 递归 `rmSync` + 每文件 `statSync` | 每次开机。随缓存线性放大；老机上开机黑屏 1~3s |
| 🔴 | `index.js:474` | HTTP handler 回调里调 `library.scanVideos()` 全量同步扫描 | 遥控端在视频空闲时按「播放/暂停」即触发；HTTP 服务跑在主进程，同步扫描直接卡住所有 IPC/HTTP |

**统一修法**：库扫描改 `fs.promises`，并让 `thumbs.cachePath` 复用调用方已拿到的 `stat`，把每文件 5 次 stat 降到 1 次；
`ensureCert()` 移入 `worker_threads`/子进程；两个 `sweep()` 挪到 `app.whenReady()` 之后的 `setImmediate` 异步执行。

---

## 四、同屏（无线投屏）状态残留 —— 建议发布前修完这一组

| 等级 | 位置 | 问题 | 后果 |
|---|---|---|---|
| 🟠 | `castServer.js:672-700`，调用点 `index.js:1173-1182` | `start()` **缺 `starting` 守卫**（对比 `pptServer.js:33` 有串行化，且 `index.js:1175` 无 in-flight 标志）。`start()` 内部有 `await`（`:682/688`），可被并发进入 | 双击「无线同屏」：A 拿到 18333、B 拿到 18334，B 覆盖模块变量，**srvA 永不被 `stop()` 关闭**。面板显示 A 的端口，点「停止同屏」后 A 仍在对外服务且持有效 token |
| 🟠 | `index.js:1249-1255` | 用户 ESC/✕ 关同屏窗（**最常用的退出方式**）走 `castWindow.init` 回调，只做 `bye()` + `stop()` + 广播，**漏了 `peer.stopBeacon()`**（对比 `stopCast()` 的 `index.js:116` 有） | UDP 信标每 2s 继续广播主机名+端口，本机永久出现在别人的设备列表里，点连接必然 `unreachable` |
| 🟠 | `index.js:768-780` | `display-removed`（拔投影线/HDMI）里 `castWindow.close()` **不触发 `onClosedCb`**，`castServer` 与信标都不撤 | 同屏 HTTP 服务 + 信标继续在线；发送端仍能上传，`queues.receiver`（`castServer.js:28`）无人消费持续堆积 |
| 🟠 | `index.js:1173-1182` vs `:548-552` | **方向不对称**：播视频会检查 `ppt.presenting` 并拦截（`:548`），但开同屏**既不检查 PPT 是否在放映，也不设置 `sm.mode`** | 放映中点「无线同屏」→ PPT 全屏窗与同屏窗**两个全屏窗口叠在同一块投影屏**；同屏期间本机再播视频同理 |

**统一修法**：抽一个 `teardownCast()`（`bye() → stop() → close() → peer.stopBeacon() → broadcast`），
让 `stopCast()`、`castWindow.init` 回调、`display-removed` 三处都调它，一个不少；
`castServer.start()` 照抄 `pptServer.js:33/98-100` 的 `starting` 串行化写法。

---

## 五、其他 BUG

| 等级 | 位置 | 问题 |
|---|---|---|
| 🟡 | `player.js:25`、`app.js:251` | 视频 `play().catch(()=>{})` 静默吞错且全 renderer 无 `error` 监听（音乐侧 `audioEngine.js:86` 有）。文件损坏/编码不支持/U 盘拔出 → 主进程 `state.video.playing` 永远 `true`，面板持续显示「投放中」，副屏全屏黑屏，只能按 Esc |
| 🟡 | `index.js:976-981` → `app.js:264-267` | LED 悬浮条停止键走 `video:control 'stop'`，主进程**只广播不更新状态**（不调 `videoWindow.stop()`、不广播 `video:state`），`inlineMode` 仍为 true。画面已停但面板仍显示「视频投放中」，需再点一次才复位 |
| 🟡 | `config.js:143` | `fs.writeFileSync` 无 try/catch（`:139-141` 的 try 只护了读）。磁盘满 / userData 只读 / 杀软锁文件 → 所有保存类 IPC 直接 reject，**窗口位置、音量、热键静默全丢**，用户无任何提示 |
| 🟡 | `index.js:846-870` | `pushPages` 每 400ms `readdirSync` 整个导出目录，且页数一变就**全量重发整个 pages 数组**。导出 300 页课件时 IPC 总量 O(N²) ≈ 4.5 万条对象，主线程持续抖动 |
| 🟡 | `index.js:237-258` vs `transcode.js:114`、`thumbs.js:61` | ffmpeg 子进程无登记，`quitApp` 未清理。导入/转码途中退出程序 → ffmpeg 变孤儿继续占 CPU 写盘（大文件可达 10 分钟） |
| 🟡 | `peer.js:79-85` | bind 回调引用的是**模块级** `beaconSock`/`beaconTimer` 而非本次 socket。开同屏后 <10ms 内再切一次开关 → `stopBeacon()` 之后旧回调仍执行 `beaconTimer = setInterval(...)`，产生永不被清理的孤儿广播定时器 |
| 🟡 | `app.js:2449` | `beep()` 每次调用 `new AudioContext()` 且从不 `close()`。一节课内反复用倒计时 → 每次到时泄漏一个硬件 AudioContext（Chromium 上限约 6），长期使用有触顶风险 |
| 🟡 | `app.js:294` | 进度 rAF 循环只要 `engine.idx >= 0` 就永久续帧，暂停/停止后仍 60fps 空转（DOM 写入已节流到 250ms，回调仍每帧执行） |
| 🟢 | `index.js:1164`、`index.js:966` | `welcome:toggle` 的 `logoPath`、`video:play` 的 `file` 由渲染层直传未过 `withinRoot`。仅本应用自身页面可达（已沙箱+白名单），属纵深防御缺失，非可利用 |
| 🟢 | `peer.js:66` + `castServer.js:577-580` | 信标每 2s 向全网段广播主机名+端口，而 `GET /remote` 无鉴权即下发 token。开着无线同屏时，教室大屏从「老师自己分享网址」变成「局域网内任何设备都能自动发现并取得遥控凭据」。token 模型是旧设计，但**暴露面是 09-21 新增的** |

---

## 六、已确认无问题（避免重复排查）

- **同步外部命令**：`execSync` / `spawnSync` 全项目 **0 处**，所有 PowerShell/ffmpeg/Office 都走异步 `spawn`/`execFile`。
- **内存泄漏**：全项目 `URL.createObjectURL` **0 处**；`AudioContext` 在 `audioEngine` 内单例复用；双声道元素 `channels[i]` 缓存复用不重建。
- **XSS**：分类名、曲目名、视频名、课件名、toast 文案全部走 `textContent` 或 `esc()`，无 `javascript:` 外链拼接。
- **Electron 安全基线**：`webSecurity` 未关闭；三窗口均 `contextIsolation:true / nodeIntegration:false / sandbox:true`；`setWindowOpenHandler` deny；6 个 preload 桥全是显式 channel 白名单。
- **路径穿越无新增缺口**：上传用随机 hex + 扩展名白名单 + root 校验；`library:deleteFile` 走 `withinRoot`；peer/player/welcome 新功能无用户可控路径。
- **快速连点音乐不产生双实例**：`AudioContext` 单例 + 双声道复用 + 转码竞态有 `_gen` 守卫（`audioEngine.js:158-169`）。
- **暂停/恢复语义正确**：`pause()` 不重置 `currentTime`，`wasDucked` + `restore()` 是有意设计，非半停止缺陷。
- **视频窗口最多一个出声**：`videoWindow.play()` 先 `stop(true)` 再建窗（`videoWindow.js:14`），且已实测无竞态（见 §二）。
- **句柄/定时器清理**：`pptServer` 有 `starting` 串行化 + exit 守卫 + `close()`；`thumbs` 队列串行去重；`timer`/`floatBar` 的 `setInterval` 均有 clear 路径；`castServer.stop()` 用了 `closeAllConnections`。
- **Promise**：`execSync` 无关；无未 await 的对外 Promise，且有 `process.on('unhandledRejection')` 兜底（`index.js:50`）。

---

## 七、修复优先级

| # | 事项 | 修掉的问题 | 改动量 |
|---|---|---|---|
| 1 | 给音乐播放入口加 `guardMusicStart()` | **BUG-A 双音频**（唯一确认的播放冲突） | 极小（3 处入口 + 1 个函数） |
| 2 | 抽 `teardownCast()` 三处统一调用 + `castServer.start()` 加 `starting` 守卫 | 端口泄漏、信标不撤、拔线残留、投屏与 PPT 抢屏 | 中（~40 行，纯重构为主） |
| 3 | `castReceiver.js:37` 补 `video.muted = true` | BUG-B 投屏叠加 | 1 行 |
| 4 | 库扫描异步化 + 每文件 5 次 stat 降到 1 次 | 4 条 🔴 阻塞中的 2 条 | 中（`library.js`/`thumbs.js`/`index.js` 三处） |
| 5 | `ensureCert()` 移出主线程；两个 `sweep()` 挪到 ready 之后异步 | 另 2 条 🔴 阻塞 | 小-中 |
| 6 | `audioEngine.js:190` 淡出定时器纳入管理 | BUG-D 显示播放中无声 | 3 行 |
| 7 | `config.js:143` 加 try/catch 并回传失败 | 静默丢配置 | 极小 |
| 8 | `player.js`/`ledVideo` 补 `error` 兜底 → `video:notifyEnded` + toast | 黑屏僵死 | 小 |

**一句话**：第 1、3、6、7 项加起来不到 20 行，能消掉本次全部播放冲突和静默丢配置；
第 2 项是一组纯重构，风险低但收益高（避免课堂上"点了停止却停不掉"的尴尬）。建议 1~3、6、7 先合，2 与 4/5 排下一版。