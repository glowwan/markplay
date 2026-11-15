# MarkPlay 打点播放器

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4.svg)](#环境要求)
[![Version](https://img.shields.io/badge/version-v1.2.1-green.svg)](#)

**中文** | [English](README.en.md)

> 看片、找点、出门——给剪辑和素材整理用的打点播放器。
>
> 用触摸板推拉就能顺滑刷片，按 `A`–`G` 随手打点，划出区间后一键剪成片段或合并成一条。
> 导出的 CSV / EDL 能直接进 Premiere、DaVinci Resolve。

<img width="1263" alt="MarkPlay 界面" src="https://github.com/user-attachments/assets/016a646d-f396-438e-a08b-6de96b482b48" />

<p align="center"><sub>侧栏从上到下依次是：标记 → 区间 → 剪辑 → 导出</sub></p>

## 它解决什么问题

整理素材时最常见的动作是：快速过一遍片子，把能用的地方记下来，再回头精确剪出来。用通用播放器做这件事会很别扭——

- 拖进度条**要么跳太远、要么找不准**，长片里来回找几秒的镜头很痛苦；
- 想标记"这里不错"，只能在纸上记时间码，或者来回切换窗口；
- 记完了还要**手动在剪辑软件里重新对一遍时间**。

MarkPlay 把这三步做成了一套连贯的手势和快捷键：

1. **刷片**：触摸板左右推拉 = 带惯性的快进快退，画面连续跟手不跳帧；慢速微调时自动切换到精确 seek。
2. **打点**：`A` / `B` / `C` / `D` / `F` / `G` 六种标记随按随记，右侧列表实时出现条目。
3. **出片**：`[` `]` 划出入点生成区间，在应用内直接剪出片段，或把多个区间合并成一条；也可以导出 CSV / EDL 交给剪辑软件。

## 下载安装

> **安装包目前未做代码签名**，Windows 首次运行会提示"未知发布者"。
> 点 **更多信息 → 仍要运行** 即可，这是个人项目的常见情况，不影响使用。

1. 打开 [Releases](https://github.com/glowwan/markplay/releases) 下载 `MarkPlay Setup x.y.z.exe`
2. 双击安装（默认装到 `%LOCALAPPDATA%\Programs\MarkPlay`，不需要管理员权限）
3. 启动后按 `O` 打开视频，或把视频文件直接拖进窗口

**系统要求**：Windows 10 / 11 x64。运行不需要装 Node.js 或任何依赖（mpv 与 ffmpeg 已打包在内）。

## 30 秒上手

| 步骤 | 操作 |
|---|---|
| 打开视频 | 按 `O`，或把文件拖进窗口 |
| 刷片 | 触摸板左右推拉；或 `←` `→` 跳 5 秒 |
| 打点 | 播到位置按 `A`（或 B/C/D/F/G） |
| 建区间 | 播到起点按 `[`，播到终点按 `]` |
| 出片 | 右侧"剪辑"面板选区间 → 开始剪辑 |

## 界面

侧栏从上到下依次是：**标记** → **区间** → **剪辑** → **导出**。

播放控制条在视频下方（因为视频画面是 mpv 的原生子窗口，HTML 控件无法叠加在画面上，详见[已知限制](#已知限制)）。

## 功能

**播放**

- **mpv 万能解码**：mpv 以原生子窗口嵌入，格式兼容性拉满（MKV / TS / 各种编码都能放）；
- **触摸板顺滑快进/快退**：推拉即 scrub，带惯性滤波，不跳帧；
- **触摸板调音量**：纵向推拉直接调；
- **逐帧**：`,` / `.` 精确前后一帧，适合找切点；
- **A–B 循环**：按 `L` 循环选中区间，按钮显示 `A–B 1` 这样的序号，换区间自动跟随；
- **2x 变速**：左键点画面 = 2x 正放/恢复，右键点画面 = 2x 倒放/恢复（倒放为"暂停+定时精确回退"模拟）；
- **视频全屏**：`F11` 或点 ⛶，`ESC` 退出；
- **字幕**：自动加载视频旁的同名字幕；把 `.srt/.ass/.vtt` 拖进窗口也能挂上。

**标记与区间**

- **多类型打点**：`A`–`G` 六类时间标记，各自独立编号；
- **标记编辑**：双击标签内联重命名；拖动时间轴刻度改时间；`Delete` 删除；`Ctrl+Z` / `Ctrl+Shift+Z` 撤销重做；**时间自动吸附到帧**（帧率取自素材，帧率未知时不吸附）；
- **批量重命名**：标记面板的「批量重命名…」可按前缀 / 后缀 / 按时间顺序重新编号（`A1`、`A2`…，各类型内部独立编号），可限定只作用于某一种类型，带实时预览，一次操作一个撤销点；
- **备份**：`Ctrl+S` 把标记文件复制一份带时间戳的备份，每个视频自动保留最近 10 份；
- **显式区间**：`[` 设入点、`]` 设出点建区间；双击改名、点击跳到入点、拖动区间条两端直接改 in/out；**按住条体左右拖可整段平移**（宽度不变，帧吸附照常）；
- **一键生成区间**：**A/B 配对**（A→后续最近的 B）或 **相邻配对**（按时间 1-2、3-4…，任意标记类型都能用）；
- **时间轴缩放**：`Ctrl+滚轮` / `Ctrl+=` `Ctrl+-` 缩放（在视频画面上滚动同样生效），`Shift+滚轮` 平移，`Ctrl+0` 适配全片；播放头跑出窗口自动跟随；
- **转场提示浮标**：点控制条的「转场」用 ffmpeg 识别画面转场，在时间轴上方画成一排橙色气泡。**只是提示，不会自动打点**；点气泡跳到该处，`Shift+←/→` 跳上/下一个。识别中可再点一次取消，结果按视频缓存；
- **大列表不卡**：标记/区间列表虚拟滚动，上千条也不整表重建。

**导出与剪辑**

- **标记导出**：标记 CSV / 区间 CSV / EDL（CMX3600）/ JSON；帧号与时间码跟随素材真实帧率（23.976 / 29.97 不再按 25fps 硬算）；
- **片段剪辑**：选中区间调用 ffmpeg 剪出片段，可选 `-c copy`（快、无损）或重编码（精确，按源文件码率控制体积）；
- **批量剪辑**：每个区间各出一段，一次导出整批；
- **批量合并**：勾选"合并为一个文件"后，所有区间按顺序拼成一条视频。

**其它**

- **拖拽打开**：视频文件拖到窗口任意处即打开；
- **记忆**：窗口大小/位置、音量、最近打开列表、上次打开目录；
- **单实例**：重复双击文件只会交给已开窗口，不会两个进程抢标记文件；
- **运行日志**：异常、mpv stderr、ffmpeg 失败原因统一写进 `logs/markplay.log`，菜单"帮助 → 打开日志文件夹"直达。

## 快捷键

| 按键 | 功能 |
|------|------|
| `Space` | 播放 / 暂停 |
| `←` / `→` | 快退 / 快进（默认 5 秒，步长可在 `config.js` 改） |
| `,` / `.` | 上一帧 / 下一帧（自动暂停） |
| `A` / `B` / `C` / `D` / `F` / `G` | 打六类时间标记（`E` 留给导出面板） |
| `[` / `]` | 设区间入点 / 设出点并创建区间（按物理键位识别，中文输入法下也可用） |
| `X` | 2x 正放 / 恢复（同鼠标左键点画面） |
| `Z` | 2x 倒放 / 恢复（同鼠标右键点画面） |
| `L` | A–B 循环开关（用剪辑面板选中的区间） |
| `Ctrl+滚轮` / `Ctrl+=` / `Ctrl+-` | 时间轴缩放（以鼠标/播放头为锚点） |
| `Ctrl+0` | 时间轴适配全片 |
| `Shift+滚轮` | 时间轴左右平移 |
| `Shift+←` / `Shift+→` | 跳到上 / 下一个转场提示（需先识别转场并显示浮标） |
| `Delete` | 删除选中标记 |
| `Ctrl+S` | 备份标记文件（带时间戳，自动保留最近 10 份） |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `F11` | 视频全屏 / 退出（全屏后按 `ESC` 也可退出） |
| `O` | 打开视频文件 |
| `E` | 滚动到导出面板 |

输入框聚焦时所有单键快捷键都会让位给文字输入（包括空格）。

触摸板：双指轻点触控板 = 系统右键，在视频画面上触发 2x 倒放/恢复；三指轻点若在 Windows"触控板设置"里设为"中键点击"，则触发 2x 正放/恢复。注意：手指"放上去不动"这种静态多指触摸，Windows 不会给应用发任何事件，要实现需要原生钩子模块，暂未做。

## 触摸板参数调节

手感都在 `src/config.js` 里调，改完重启应用生效（不用重新构建）：

| 参数 | 含义 | 怎么调 |
|------|------|--------|
| `SCRUB_SENSITIVITY` | 灵敏度：同样滑动距离对应快进多少秒 | 手感太"肉"就调大，太"窜"就调小 |
| `SCRUB_SMOOTHING` | 顺滑度：惯性滤波强度 | 越大越平滑但跟手性越差；觉得延迟高就调小 |
| `SCRUB_IDLE_MS` | 松手回播延迟：手指离开触摸板后，等多少毫秒才结束 scrub、恢复正常播放 | 误触多就调大，觉得拖沓就调小 |
| `SCRUB_INERTIA_DECAY` | 惯性衰减：手指离开后滑行速度每帧的保留比例（0~1） | 越小停得越快；想要更长的滑行就调大（如 0.96） |
| `SCRUB_INVERT_X` | 横滑方向：`true` = 内容跟随手指（右推快退/左推快进）；`false` = 滚动条逻辑（右推快进/左推快退） | 觉得方向反直觉就改这个 |
| `SCRUB_KEYFRAME_VELOCITY` | 快/慢拖动的分界（视频秒/现实秒）：低于它用 exact，高于它用 keyframes | 慢速微调嫌不准就调小，快速拖动嫌跳就调大 |
| `SURFACE_APPLY_DPI_SCALE` | 仅特殊 DPI 环境的排查开关，正常保持 `false` | 视频画面错位时先看这一项 |
| `SNAP_TO_FRAME` | 打点/拖动是否吸附到帧，默认 `true` | 想要半帧级微调（少见）就改 `false` |
| `SIDECAR_BACKUP_KEEP` | 每个视频保留多少份 `Ctrl+S` 备份，默认 10 | 磁盘紧张就调小 |

建议一次只改一个参数，改 20%–30% 试手感。不同触摸板驱动手感差异大，以真机实测为准。

**跟手原理（抄 mpv 官方 OSC + LosslessCut 的作业）**：拖动中发 `absolute+keyframes`（只跳到关键帧，5~50ms，画面连续跟手），慢速微调（<1 视频秒/现实秒）才用 `absolute+exact`，松手时补一次 exact 落到精确位置。exact seek 要从前一个关键帧逐帧解码（长 GOP 下可达 1200ms），拖动中发 exact 必然积压跳帧——之前卡顿的根子就是这个。另加 `--hr-seek-framedrop=yes` 给 exact seek 加速。

## 时间轴缩放

- `Ctrl+滚轮`：以鼠标位置为锚点缩放（1.5 倍步进），在视频画面上滚动同样生效；
- `Ctrl+=` / `Ctrl+-`：以播放头为锚点缩放；`Ctrl+0` 或"适配"按钮回到全片；
- `Shift+滚轮`：左右平移窗口；
- 缩放只影响时间轴显示，不影响 seek 精度；播放头跑出窗口时视图会自动居中跟随；
- 缩放窗口是纯计算模块（`timeline-view.js`），有独立单元测试。

## 标记、区间与导出说明

- **sidecar 文件**：每个视频的标记/区间存在同目录、**在原文件名后追加** `.markplay.json`（例如 `旅行.mp4` → `旅行.mp4.markplay.json`）。追加而不是替换扩展名，是为了让 `a.mp4` 和 `a.mkv` 不互相覆盖；删视频时记得一起删。如果文件里残留了历史重复项，打开时会按 id 去重并自动写回一份干净的；
- **sidecar 格式 v2**：`{version:2, video, markers:[...], ranges:[...]}`；v1 老文件（只有 markers）可正常读取，区间为空；
- **备份与恢复**：`Ctrl+S` 会在同目录生成 `旅行.mp4.markplay.json.bak-20261115-120233`。要恢复就删掉当前 `.markplay.json`，把某个备份改回原文件名（注意先关掉应用，否则会被覆盖）；
- **区间模型**：区间是显式的 `{in, out}`，批量剪辑、EDL 都以它为准，不再从 A/B 标记里猜配对。老数据可以用区间面板的 **A/B 配对**（A→B）或 **相邻配对**（1-2、3-4…，任意标记类型）一次性生成；
- **标记 CSV 列**：`index,label,kind,time_seconds,timecode,frame,end_seconds,end_tc`——序号、标记名、类型、开始秒数、开始时间码、**帧号**、结束秒数、结束时间码（结束点取下一个标记；最后一个 +10 秒且不超过视频时长）；
- **区间 CSV 列**：`index,name,in_seconds,in_tc,in_frame,out_seconds,out_tc,out_frame,duration_seconds`；
- **EDL**：标准 CMX3600 文本，`FCM: NON-DROP FRAME`，record 时间轴从 `01:00:00:00` 开始累积；**有区间时按区间生成，没有区间时回退到按标记分段**；帧号按素材帧率换算（播放时从 mpv 的 `container-fps` 读取，23.976 按 24、29.97 按 30、59.94 按 60 的名义帧率计非丢帧时间码），文件里会有一行 `* MARKPLAY FPS: 24 (source 23.976)` 注释；导出面板会显示当前工程帧率；
- **JSON**：`{version:2, video, duration, edlFps, sourceFps, exportedAt, markers:[...], ranges:[...]}`，供二次开发用；
- **批量剪辑**：输出到选定文件夹，命名 `<视频名>_clip_01.mp4`、`_clip_02.mp4`……按区间顺序编号；
- **合并剪辑**：勾选剪辑面板的 **合并为一个文件** 后再点批量剪辑，会弹出"另存为"，把所有区间按时间顺序拼成 `<视频名>_merged.mp4`。为了让每段切点准确，合并模式会自动重新编码（不受"重新编码"勾选框影响），区间总时长越长耗时越久。

## 从源码构建

**环境要求**：Windows 10 / 11 x64，Node.js 18 或更高版本（LTS 即可）。

1. 安装 Node.js：https://nodejs.org/
2. 解压源码到任意目录（路径不要带中文和空格最稳妥）
3. 双击 `build.bat`：脚本会自动检查 Node → `npm install` → 下载 `mpv.exe` / `ffmpeg.exe` → 打包
4. 安装包在 `dist\` 目录下

> 首次构建约 5–15 分钟（主要是下载 Electron 和 mpv/ffmpeg 二进制），请保持网络畅通。

国内网络建议先设镜像，否则 `npm install` 可能非常慢：

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

开发调试可以不用打包：

```powershell
npm install
npm run fetch-bin   # 下载 mpv.exe / ffmpeg.exe 到 resources/bin
npm start           # 直接跑 Electron
npm test            # 跑单元测试（47 个，无需 Electron）
npm run check:dom   # DOM id / 脚本引用自检
```

## 文档

- [CHANGELOG.md](CHANGELOG.md)：版本更新记录
- [CONTRIBUTING.md](CONTRIBUTING.md)：**报 bug 请先看这里**（怎么提供日志和素材信息）
- [REVIEW.md](REVIEW.md)：实现细节、设计取舍、后续路线
- [docs/RELEASE.md](docs/RELEASE.md)：代码签名、构建/发布清单、二进制固定与校验
- [docs/LIBMPV-MIGRATION.md](docs/LIBMPV-MIGRATION.md)：用 libmpv 替掉 `--wid` 子窗口的可行性与分阶段方案

## 设置与用户数据

- 设置存在 Electron 的 userData 目录下（菜单 **帮助 → 打开数据文件夹** 可直接打开），文件名 `settings.json`；
- 内容：音量、最近打开（最多 12 条）、上次打开目录、主窗口位置/大小；
- 删除这个文件即可恢复默认（不会影响标记 sidecar）；
- 运行日志在 userData 下的 `logs\markplay.log`（超过 2MB 轮转，最多保留 5 个）。菜单 **帮助 → 打开日志文件夹** 直达；反馈问题时把最新的 `markplay.log` 一并提供即可。

## 目录结构

```
video-marker-player/
├── build.bat              # 一键构建脚本（双击运行）
├── package.json           # 项目配置 + electron-builder 打包配置
├── README.md              # 中文说明（本文档）
├── README.en.md           # English README
├── CHANGELOG.md           # 版本更新记录
├── CONTRIBUTING.md        # 贡献指南（报 bug 需附什么）
├── CODE_OF_CONDUCT.md     # 行为准则
├── REVIEW.md              # 实现细节 + 后续建议
├── LICENSE                # MIT
├── .github/               # issue 模板 + PR 模板
├── docs/
│   ├── RELEASE.md         # 代码签名 + 发布清单
│   ├── LIBMPV-MIGRATION.md# libmpv 渲染重构方案
│   ├── RELEASE-NOTES-v1.2.1.md # Release 说明草稿
│   ├── PROMO.md           # 推广草稿（V2EX / 少数派 / B站）
│   └── images/            # 可选：放演示动图（见该目录 README）
├── src/
│   ├── main.js            # 主进程：窗口、mpv/ffmpeg 子进程、IPC、菜单、单实例
│   ├── config.js          # 前后端共享配置
│   ├── media-utils.js     # 纯函数：文件类型、码率估算、ffmpeg 参数、concat 转义
│   ├── settings.js        # 设置持久化（音量 / 最近文件 / 窗口几何）
│   ├── logger.js          # 文件日志（轮转、异常汇总）
│   ├── mpv.js             # mpv JSON IPC 客户端
│   ├── preload.js         # contextBridge API
│   ├── surface-preload.js # 视频子窗口的滚轮/点击/拖放转发
│   └── renderer/
│       ├── index.html
│       ├── styles.css
│       ├── timeline-view.js # 时间轴缩放窗口（纯计算）
│       ├── scrub.js       # 触摸板 scrub / 音量
│       ├── markers.js     # 标记 + 区间模型、渲染、撤销、拖拽改时间
│       ├── ui.js          # toast
│       ├── export.js      # 标记/区间 CSV、EDL、JSON + 单段/批量剪辑
│       └── renderer.js    # 主接线
├── tests/                 # node:test 单元测试（无需 Electron）
└── tools/
    ├── fetch-binaries.js  # 下载 mpv.exe / ffmpeg.exe 到 resources/bin/
    └── check-dom.js       # DOM id / 脚本引用自检
```

## 已知限制

1. **安装包未做代码签名**：首次安装时 Windows SmartScreen 会提示"未知发布者"，点"更多信息"→"仍要运行"即可继续；
2. **mpv 画面是原生子窗口**：HTML 控件无法浮于视频画面之上，所以播放控制条放在视频下方，而不是悬浮在画面上；
3. **触摸板手感需在真机上微调**：不同品牌触摸板驱动差异大，`src/config.js` 的参数请按上面的方法实测调整；
4. **ffmpeg 剪辑为 `-c copy` 模式**：速度快、无损，但剪切点只会落在关键帧上，切点可能与区间入/出点有零点几秒偏差。勾选"重新编码"可精确到帧，并且会按**源文件码率**（文件大小 ÷ 时长 − 96kbps 音轨）做 ABR 编码，体积会接近原文件而不是被 CRF 压大；代价是二次压缩的画质损失与编码时间；
5. **2x 倒放是模拟的**：mpv 官方不支持负速度倒放（wontfix），这里用"暂停 + 精确回退"实现，流畅度不如正放，属预期内；
6. **撤销只覆盖标记/区间操作**：新增/删除/重命名/拖动改时间、建/删区间、拖区间边界可撤销，剪辑和导出不可撤销；
7. **EDL 是非丢帧（NON-DROP）**：29.97 素材按 30fps 名义帧率计帧，长素材会有约 0.1% 的时间漂移；
8. **合并剪辑必然重新编码**：不是无损拼接；如果要求无损，请用普通批量剪辑出多个文件，再到剪辑软件里拼。

## 下载二进制失败怎么办

`build.bat` 第 3 步如果报 **`GitHub API 请求失败，HTTP 403`**：这是 GitHub 对未登录 API 的限流（或网络对 `api.github.com` 的拦截），不是你的操作问题。
v1.0.1 起脚本会自动改从 releases 网页解析资源链接，不需要你做任何事；如果仍然失败，按下面手动放文件。

**手动下载：**

1. **mpv.exe**
   - 打开 https://github.com/shinchiro/mpv-winbuild-cmake/releases/latest
   - 在 **Assets** 里下载 `mpv-x86_64-*.7z`
   - 用 7-Zip 解压，把 `mpv.exe` **以及同目录的** `d3dcompiler_*.dll`、`libshaderc*.dll` 等 dll 一起复制到 `resources\bin\`；
2. **ffmpeg.exe**
   - 打开 https://www.gyan.dev/ffmpeg/builds/#release-builds
   - 在 **release builds** 区域下载 `ffmpeg-release-essentials.7z`（约 34 MB，**不是** git master builds 里的 `ffmpeg-git-essentials.7z`）
   - 解压后把 `bin\ffmpeg.exe` 复制到 `resources\bin\`。

**其它可选开关**（排查用）：

- `MARKPLAY_RESOLVE_ONLY=1 node tools/fetch-binaries.js`：只解析 mpv 下载链接、不下载；
- `MARKPLAY_FORCE_HTML=1`：强制跳过 GitHub API，直接走网页解析；
- `MARKPLAY_MPV_URL=<直链>`：完全绕过 GitHub，用你提供的 mpv 包地址。

## License

[MIT](LICENSE) © 2026 glowwan

## 致谢

- [mpv](https://mpv.io/)：播放内核
- [FFmpeg](https://ffmpeg.org/)：剪辑与编码
- [Electron](https://www.electronjs.org/)：应用框架
- 交互与 seek 策略参考了 [mpv 的 OSC](https://github.com/mpv-player/mpv) 与 [LosslessCut](https://github.com/mifi/lossless-cut)
