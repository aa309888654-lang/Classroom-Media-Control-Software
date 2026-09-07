# 小天AIGC · 课堂演示中控

课堂演示中控桌面软件（**Windows 11 / macOS**）：场景音乐一键播放、全局快捷键切歌、PPT 一键放映到投影屏、视频投第二显示器、无线同屏（手机扫码镜像 / 上传上屏）、课堂计时器。

- **Windows**：NSIS 安装版 + 免安装便携版单 EXE
- **macOS**：zip 包（Apple Silicon + Intel），由 GitHub Actions 在 macOS 环境构建
- 详细技术方案见 [`方案.md`](方案.md)

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `小天AIGC-Setup-0.1.0.exe` | 安装版，带桌面快捷方式 |
| Windows | `小天AIGC-Portable-0.1.0.exe` | 便携版，双击即用，可拷 U 盘 |
| macOS | `xiaotian-aigc-mac.zip` | 需在 macOS 解压后右键 App →「打开」首次放行 |

> 最新安装包见本仓库 [Releases](../../releases) 页。

## 功能与快捷键

| 功能 | 操作 | Windows 快捷键 | macOS 快捷键 |
|---|---|---|---|
| 分类一键播放 | 点分类卡片 | `Ctrl+F11` / `Ctrl+F12` | `Cmd+Alt+1` / `Cmd+Alt+2` |
| 播放 / 暂停 | ▶ 按钮 | `Ctrl+F6` | `Cmd+Alt+M` |
| 上一首 / 下一首 | ⏮ ⏭ | `Ctrl+F3` / `Ctrl+F7` | `Cmd+Alt+←` / `Cmd+Alt+→` |
| 音量 ± | 滑条 | `Ctrl+F9` / `Ctrl+F10` | `Cmd+Alt+↓` / `Cmd+Alt+↑` |
| 静音 | — | `Ctrl+F8` | `Cmd+Alt+0` |
| 一键放映 PPT | 大按钮 | `Ctrl+F1` | `Cmd+Alt+P` |
| 退出投屏 | 红色按钮 | `Ctrl+F2` | `Cmd+Alt+E` |
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