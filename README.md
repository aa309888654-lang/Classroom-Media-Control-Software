# 小天AIGC · 课堂演示中控

课堂演示中控桌面软件（**Windows 11 / macOS**）：场景音乐一键播放、全局快捷键切歌、PPT 一键放映到投影屏、视频投第二显示器、无线投屏 / 无线遥控（手机、电脑扫码镜像 / 上传上屏 / 遥控音乐 PPT 视频）、课堂计时器。

- **Windows**：NSIS 安装版 + 免安装便携版单 EXE
- **macOS**：zip 包（Apple Silicon + Intel），由 GitHub Actions 在 macOS 环境构建
- 详细技术方案见 [`方案.md`](方案.md)

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `小天AIGC-Setup-2026.10.15.exe` | 安装版，带桌面快捷方式（教室固定用机推荐，启动最快） |
| Windows | `小天AIGC-2026.10.15-win.zip` | 绿色解压版，解压一次后双击 `小天AIGC.exe` 秒开（低性能电脑/U盘推荐） |
| Windows | `小天AIGC-Portable-2026.10.15.exe` | 便携版，双击即用——但每次启动要自解压约 500MB，低性能电脑启动慢，仅建议临时演示用 |
| macOS | `xiaotian-aigc-mac.zip` | 需在 macOS 解压后右键 App →「打开」首次放行 |

> **低性能电脑启动慢？** 便携版每次启动都会把约 500MB 自解压到临时目录（老旧电脑约需 1 分钟）。教室固定用机请改用**安装版**，U盘随身携带请用**绿色解压版**（解压一次，之后 1-2 秒启动）。

> ⚠️ **双击没反应、弹「智能应用控制已阻止可能不安全的应用」？** 这是 Windows 11 的智能应用控制（SAC）在拦截**未签名**程序，该弹窗没有「仍要运行」可点，无法绕过。Windows 10 不受影响（SAC 只存在于 Win11）。分发前需给安装包做代码签名，详见 [《签名与发布指南.md》](签名与发布指南.md)。

## 功能与快捷键

| 功能 | 操作 | Windows 快捷键 | macOS 快捷键 |
|---|---|---|---|
| 分类一键播放 | 点分类行 ▶ 或双击分类行 | `Ctrl+F11` / `Ctrl+F12` | `Cmd+Alt+1` / `Cmd+Alt+2` |
| 播放 / 暂停 | ▶ 按钮 / 空格 | `Ctrl+F6`（空格仅面板内生效） | `Cmd+Alt+M`（空格仅面板内生效） |
| 上一首 / 下一首 | ⏮ ⏭ | `Ctrl+F3` / `Ctrl+F7` | `Cmd+Alt+←` / `Cmd+Alt+→` |
| 音量 ± | 滑条 | `F5` / `F6`（笔记本音量键） | `Cmd+Alt+↓` / `Cmd+Alt+↑` |
| 静音 | — | `F4`（笔记本静音键） | `Cmd+Alt+0` |
| 一键放映 PPT | 大按钮 | `Ctrl+F1` | `Cmd+Alt+P` |
| 退出投屏 | 红色按钮 | `Ctrl+F2` | `Cmd+Alt+E` |
| PPT 翻页（不抢焦点） | ⏮ ⏭ / 翻页笔 / ↑ ↓ 键 | `Ctrl+Alt+←` / `Ctrl+Alt+→` | `Cmd+Alt+,` / `Cmd+Alt+.` |
| PPT 跳任意页 | 点演讲者条 5 页缩略图 | — | — |
| 计时器启停 / 重置 | 课堂工具区 | `Alt+F7` / `Alt+F8` | `Cmd+Alt+T` / `Cmd+Alt+R` |

## 快速开始（开发）

```bash
cd app
npm install
npm start           # 启动应用
```

打包：

```bash
npm run dist          # Windows 安装版 + 便携版
npm run dist:mac      # macOS zip（需在 macOS 环境）
```

## 许可

[MIT](LICENSE)。内置音乐版权与署名见 [`app/resources/music/licenses.md`](app/resources/music/licenses.md)。