# 参与贡献

感谢愿意花时间。这是个个人项目，但 issue 和 PR 都会被认真看。

## 报告问题

**先用 [Bug 报告模板](https://github.com/glowwan/markplay/issues/new?template=bug_report.yml) 开 issue**，里面会引导你提供必要信息。三样东西决定了我能不能复现：

### 1. 运行日志（最关键）

菜单 **帮助 → 打开日志文件夹**，或直接打开：

```
%APPDATA%\MarkPlay\logs\markplay.log
```

把这个文件**最后 100 行左右**贴进 issue。日志里已经有：主进程/渲染进程异常、mpv 的 stderr、ffmpeg 的完整命令与失败原因。

> 提交前请删掉日志里的个人路径（比如 `C:\Users\你的名字\...`）。

### 2. 视频信息

编码/容器相关的 bug 几乎都和具体素材有关。能提供的话贴一下：

```powershell
ffprobe -v error -show_format -show_streams "你的视频.mp4"
```

或者至少说明容器（mp4/mkv/ts）、编码（H.264/HEVC/AV1）、分辨率、帧率。

### 3. 复现步骤

「打开 XX 格式的视频 → 按 `[` → 再按 `]`」这种程度最好。如果只在特定操作顺序下出现，请写清楚。

## 提功能建议

用 [功能建议模板](https://github.com/glowwan/markplay/issues/new?template=feature_request.yml)。

请先看一眼 [README 的「已知限制」](README.md#已知限制) 和 [REVIEW.md](REVIEW.md)，有些限制是刻意的取舍（比如控制条不能悬浮在画面上，是 `--wid` 原生子窗口的固有限制，不是没想到）。

## 开发环境

```powershell
git clone https://github.com/glowwan/markplay.git
cd markplay
npm install
node tools/fetch-binaries.js   # 下载 mpv.exe / ffmpeg.exe 到 resources/bin
npm start                      # 开发模式跑起来
```

国内网络慢的话先设镜像：

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
```

## 提交前必须跑

```powershell
npm test               # 单元测试，目前 63 个
npm run check:dom      # index.html 与渲染进程引用的 DOM id 是否对得上
npm run check:templates # 改了 issue 模板才需要跑
```

前两个都过了再提 PR。CI 还没配，但我会在本地跑这两条。

**如果你的改动涉及渲染进程**（`src/renderer/*.js`），因为没法自动化测 UI，请在 PR 描述里写清楚手动验证过哪些操作。

## 代码约定

- **不引入新的运行时依赖**。现在 `dependencies` 是空的，只有 `electron` / `electron-builder` 两个开发依赖。加依赖需要充分理由。
- **纯逻辑要能脱离 Electron 单测**。参照 `src/media-utils.js`：文件类型判定、码率计算、参数拼装这类东西放进去，`tests/` 里覆盖；涉及窗口和子进程的留在 `main.js`。
- **注释写"为什么"，不写"是什么"**。比如"这里用 `e.code` 而不是 `e.key`，因为中文输入法下 `e.key` 会变成 `【`"——这种才值得写。
- **用户可见的文案用中文**，代码标识符用英文。
- 缩进 2 空格，字符串用单引号（渲染进程里的旧代码用 `var`，新代码请用 `const` / `let`，不要为了统一去改存量）。

## 目录导航

| 想改什么 | 去哪 |
|---|---|
| 播放、mpv 嵌入、窗口 | `src/main.js` |
| 触摸板刷片手感 | `src/renderer/scrub.js` + `src/config.js` |
| 标记 / 区间模型与渲染 | `src/renderer/markers.js` |
| 导出格式、剪辑参数 | `src/renderer/export.js` + `src/main.js` 的 `run-clip` |
| 时间轴缩放 | `src/renderer/timeline-view.js` |
| 快捷键 | `src/renderer/renderer.js` 的 `wireKeyboard` |
| 设置持久化 | `src/settings.js` |
| 日志 | `src/logger.js` |

## 路线图

大方向的取舍和后续计划写在 [REVIEW.md](REVIEW.md)，其中包括一个较大的架构改动（用 libmpv 替掉 `--wid` 子窗口，见 [docs/LIBMPV-MIGRATION.md](docs/LIBMPV-MIGRATION.md)）。如果你想做这块，**先开 issue 讨论**，不要直接提大 PR。

## 许可

提交 PR 即表示你同意你的贡献按 [MIT License](LICENSE) 授权。
