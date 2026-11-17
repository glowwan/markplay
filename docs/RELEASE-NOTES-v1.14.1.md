# Release 说明（v1.14.1）

发布时：仓库 → Releases → Create a new release

- **Tag**: `v1.14.1`
- **Target**: `main`
- **Title**: 用下面的标题
- **Describe this release**: 粘贴下面整段
- **Attach binaries**: 上传 `MarkPlay Setup 1.14.1.exe`

---

## 标题

```
v1.14.1 — 文件列表、续播、全屏状态栏
```

## 说明正文

```markdown
自 v1.8.2 以来的一大批更新。Windows 10/11 x64，下载后双击安装即可，运行不需要 Node.js 或其它依赖（mpv 与 ffmpeg 已打包在内）。

> ⚠️ 安装包**未做代码签名**，Windows 首次运行会提示"未知发布者"。
> 点 **更多信息 → 仍要运行** 即可，这是个人项目的常见情况，不影响功能。

### 本次新增

**文件列表（批量打开 / 手动编辑）**

一次选多个视频、或整批拖进窗口，都会进列表。**默认不显示、不占空间**，用菜单「视图 → 文件列表」或控制条的 🗂 图标（`Ctrl+L`）唤出，右上角 ✕ 单独关闭。
**列表可手动编辑**：顶部 ＋ 添加文件，每条右侧 ✕ 从列表移除（**不删文件**）。
全屏时光标移到**屏幕最右侧**自动弹出，移开自动收起；选文件期间保持显示。

**续播记忆点**

每个视频记住上次看到的位置，再次打开自动跳回，并给一个「从头开始」按钮。
**只有真正播完（到达文件末尾）才从头**——中途停在片尾前几秒也会从那里继续。

**全屏播放状态栏**

全屏时把鼠标移到**屏幕下边缘**，底部浮出播放状态栏，内容与非全屏模式下的底部模块一致：播放/暂停、2x 正反、A–B 循环、转场、时间轴缩放、时间码、音量、状态，以及带标记刻度 / 区间条 / 转场浮标 / 播放头的时间轴（可点击或拖拽跳转）。移开自动收起。

**为无索引格式建立索引**

TS / M2TS / VOB / MPG 这类容器**没有 seek 索引**，往回 seek 只能落在关键帧上，所以倒放会退化成"约 2 秒一跳"。现在可以一键**流拷贝转封装成 MP4**（`-c copy`，不重编码、不改画质，几 GB 通常几十秒），索引建立后倒放恢复 0.2 秒一小步。
入口两处：菜单「文件 → 为当前视频建立索引」；倒放退化提示里的「建立索引」按钮。输出为同目录 `原名.indexed.mp4`（**绝不覆盖**已有文件），并会把标记文件复制一份给新文件。

**左键双击画面 = 播放 / 暂停**

再双击继续播放。左键单击仍是 2x 正放，中键 2x 正放，右键 2x 倒放。
单击动作会等 250ms 双击窗口——这是双击手势的固有代价。

### 修复

- **`.ts` 倒放完全不动**：TS 没有索引，固定 0.2 秒步长会被量化回同一个关键帧。改为**步长自适应**：退不动就翻倍（上限 4 秒），按实际位移折算间隔保持平均 2x；MP4 上行为与之前完全一致。
- **窗口模式下点列表条目 ✕ 后列表"消失"**：实为透明窗口被 mpv 原生子窗口压到下层（不是被隐藏）。现在每次推数据后都会把窗口抬回顶层。
- **全屏下右侧悬停不再弹出**（v1.11.1 引入的回归）：误把"铺满式全屏"当成状态过期，停了光标轮询。
- **左键双击没反应**（v1.14.0 引入的回归）：`handleSurfaceClick` 被重复定义，旧实现覆盖了新实现。
- 补齐 v1.8.0 遗漏的翻译：标记按钮、计数括号、列表空状态、窗口标题、mpv 底层错误等。
- 区间默认名不再固定中文：`区间 1` 在英文界面显示为 `Range 1`，手动改过的名字不受影响。

完整改动见 [CHANGELOG.md](https://github.com/glowwan/markplay/blob/main/CHANGELOG.md)。

### 已知限制

- 未签名，SmartScreen 会提示；未在杀软白名单内
- 视频画面是原生子窗口，HTML 控件无法叠加在画面上（列表与状态栏因此是独立覆盖窗口）
- `-c copy` 剪辑的切点会落在关键帧上；需要精确请勾选"重新编码"
- EDL 为非丢帧，29.97 素材按 30fps 名义帧率计帧
- 2x 倒放是"暂停 + 往回 seek"模拟的；对 **MPEG-TS** 这类无索引格式会退化成约 2 秒一跳（可一键建立索引解决）
- 合并剪辑必然重新编码，不是无损拼接
- 英文界面下个别长文案在 300px 侧栏里可能折行

---

### English

Cumulative update since v1.8.2. Windows 10/11 x64 — run the setup, no Node.js or extra runtime required.

Highlights:

- **File list** — bulk-open or drag in a batch. Hidden by default; open it from the View menu or the 🗂 button (`Ctrl+L`). Editable: **＋** adds files, **✕** removes a row without deleting anything. In fullscreen it slides in from the right screen edge.
- **Resume** — each video remembers where you stopped. Only reaching the actual end resets it.
- **Fullscreen playback bar** — move the pointer to the bottom screen edge; same content as the windowed control bar, timeline included.
- **Build seek index** — formats without a seek index (TS/M2TS/VOB/MPG) can't seek precisely backwards, so reverse degrades to ~2-second jumps. One click stream-copies the file to MP4 (`-c copy`, no re-encode) and restores smooth reverse. Never overwrites existing files; markers are carried over.
- **Double-click the video** to play/pause (single click is still 2x forward).

Fixes include reverse playback on `.ts` (adaptive step), the file list vanishing behind the video surface, the fullscreen right-edge hover regression, and the double-click regression.

**Note:** the installer is unsigned, so SmartScreen will warn about an unknown publisher — click **More info → Run anyway**.

See [CHANGELOG.md](https://github.com/glowwan/markplay/blob/main/CHANGELOG.md) for details.
```

---

## 发布后追加校验和

```powershell
Get-FileHash "dist\MarkPlay Setup 1.14.1.exe" -Algorithm SHA256 |
  Select-Object -ExpandProperty Hash
```

在说明末尾追加：

```
SHA256: <粘贴哈希>
```
