# Release 说明（v1.8.2）

发布时：仓库 → Releases → Create a new release

- **Tag**: `v1.8.2`
- **Target**: `main`
- **Title**: 用下面的标题
- **Describe this release**: 粘贴下面整段
- **Attach binaries**: 上传 `MarkPlay Setup 1.8.2.exe`

---

## 标题

```
v1.8.2 — 中英双语界面
```

## 说明正文

```markdown
自 v1.6.0 以来最主要的变化：**界面支持中英文，可即时切换**。

Windows 10/11 x64，下载后双击安装即可，运行不需要 Node.js 或其它依赖（mpv 与 ffmpeg 已打包在内）。

> ⚠️ 安装包**未做代码签名**，Windows 首次运行会提示"未知发布者"。
> 点 **更多信息 → 仍要运行** 即可，这是个人项目的常见情况，不影响功能。

### 本次新增：中英双语界面

菜单「语言 / Language」或控制条右下角的 `中/EN` 按钮，点一下就换。

- **不重启、不重载窗口**：正在播的视频、已打的标记、剪辑进度都不会丢；
- **首次启动跟随系统语言**，之后记住你的选择；
- 覆盖全部可见文案：菜单、对话框、快捷键说明、侧栏、状态栏、提示气泡、
  所有错误信息，以及自动生成的区间名（`区间 1` ↔ `Range 1`）。

实现上没引入任何 i18n 库（项目至今零运行时依赖），文案集中在两个纯数据字典里，
体积极小；缺词时回退中文，再缺则显示键名而非崩溃。

### 一并包含（v1.7.x 的功能，v1.6.0 之后）

- **转场提示浮标**：扫描画面变化，时间轴上方显示橙色气泡，**只是提示、不会自动打点**；
  一次扫描后拖动灵敏度滑块即时过滤，不用重新扫。
- **帧吸附**：打点、拖标记、拖区间两端时时间对齐到最近帧。
- **`Ctrl+S` 备份标记文件**：带时间戳的副本，每个视频保留最近 10 份。
- **拖动区间条本体**整段平移（宽度不变），拖两端小方块只改那一端。
- **批量重命名标记**：前缀 / 后缀 / 按时间重新编号，带实时预览，一个撤销点。
- **时间轴缩放 + 列表虚拟化**：Ctrl+滚轮缩放，几千条标记也不卡。

### 修复

- **区间默认名不跟随语言**：以前 `区间 1` 会写进标记文件，切到英文界面仍显示中文；
  现在显示时按当前语言重算，手动改过的名字不受影响。
- 补齐若干遗漏的翻译点：标记按钮文字、计数括号（`（3）`→` (3)`）、
  列表空状态（原先写死在 CSS 里，无法跟随语言）、窗口标题副标题、mpv 底层错误消息。
- 重新编码按源文件码率控制，输出体积不再被压大。
- 重复打开同一视频不再让标记和区间成倍增长。
- `[` / `]` 在中文输入法下也能建区间。
- 拖动窗口时视频画面不再错位。

完整改动见 [CHANGELOG.md](https://github.com/glowwan/markplay/blob/main/CHANGELOG.md)。

### 已知限制

- 未签名，SmartScreen 会提示；未在杀软白名单内
- 视频画面是原生子窗口，HTML 控件无法叠加在画面上（所以控制条在视频下方）
- `-c copy` 剪辑的切点会落在关键帧上；需要精确请勾选"重新编码"
- EDL 为非丢帧，29.97 素材按 30fps 名义帧率计帧
- 转场识别对**连续运动**素材（行车记录仪、长镜头）抓到的是"画面突变"而非"镜头切换"，数量会明显偏少
- 合并剪辑必然重新编码，不是无损拼接
- 英文界面下个别长文案在 300px 侧栏里可能折行

---

### English

The main change since v1.6.0: **the interface is now available in Chinese and English, switchable instantly.**

Windows 10/11 x64 — run the setup, no Node.js or extra runtime required.

Highlights:

- **Bilingual UI** — switch from the Language menu or the `中/EN` button. No restart, no reload: playback, markers and clip progress are preserved. Follows the system language on first run, then remembers your choice.
- **Scene-cut hint bubbles** — scan once, then drag a sensitivity slider to filter instantly. Hints only; nothing is marked automatically.
- **Frame snapping** — marker and range times snap to the nearest frame.
- **`Ctrl+S` marker-file backup** — timestamped copies, 10 most recent kept per video.
- **Drag the range bar body** to shift a whole range with its width preserved.
- **Batch rename markers** — prefix / suffix / renumber by time order, with live preview and a single undo step.
- **Timeline zoom + list virtualisation** — stays smooth with thousands of markers.

Fixes include range names now following the UI language, several previously untranslated strings, bitrate-accurate re-encoding, duplicate marker loading, and `[`/`]` under Chinese IMEs.

**Note:** the installer is unsigned, so SmartScreen will warn about an unknown publisher — click **More info → Run anyway**.

See [CHANGELOG.md](https://github.com/glowwan/markplay/blob/main/CHANGELOG.md) for details.
```

---

## 发布后追加校验和

```powershell
Get-FileHash "dist\MarkPlay Setup 1.8.2.exe" -Algorithm SHA256 |
  Select-Object -ExpandProperty Hash
```

在说明末尾追加：

```
SHA256: <粘贴哈希>
```
