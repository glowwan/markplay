# Release 说明（v1.6.0）

发布时：仓库 → Releases → Create a new release

- **Tag**: `v1.6.0`
- **Target**: `main`
- **Title**: 用下面的标题
- **Describe this release**: 粘贴下面整段
- **Attach binaries**: 上传 `MarkPlay Setup 1.6.0.exe`

---

## 标题

```
v1.6.0 — 转场提示、帧吸附与批量操作
```

## 说明正文

```markdown
自 v1.2.1 以来的累积更新。Windows 10/11 x64，下载后双击安装即可，运行不需要 Node.js 或其它依赖（mpv 与 ffmpeg 已打包在内）。

> ⚠️ 安装包**未做代码签名**，Windows 首次运行会提示"未知发布者"。
> 点 **更多信息 → 仍要运行** 即可，这是个人项目的常见情况，不影响功能。

### 本次新增

**转场提示浮标**

点控制条的「转场」扫描画面变化，时间轴上方会出现一排橙色气泡。**只是提示，不会自动打点**；点气泡跳到该处，`Shift+←/→` 跳上/下一个。

关键是**灵敏度可调**：一次扫描把所有帧的场景分都收回来，之后拖动滑块即时过滤，**不需要重新扫描**（37 分钟的片子重扫要两三分钟）。扫描完若当前阈值零命中，会自动降到有结果的档位。

**帧吸附**

打点、拖标记刻度、拖区间两端时，时间自动对齐到最近的帧。帧率取自素材本身，未知时不吸附。可在 `src/config.js` 用 `SNAP_TO_FRAME = false` 关闭。

**`Ctrl+S` 备份标记文件**

把 `.markplay.json` 复制一份带时间戳的备份，每个视频自动保留最近 10 份。恢复方法：关掉应用 → 删掉当前 sidecar → 把某个 `.bak-时间戳` 改名回原文件名。

**整段拖动区间**

按住时间轴上的区间条**本体**左右拖，整段平移且宽度不变；拖两端的小方块仍只改那一端。

**批量重命名标记**

标记面板的「批量重命名…」支持前缀 / 后缀 / 按时间顺序重新编号（各类型内部独立），可限定只作用于某一种标记类型，带实时预览，一次操作一个撤销点。

### 修复

- 重新编码按源文件码率控制，输出体积不再被 CRF 压大
- 重复打开同一视频不再让标记和区间成倍增长
- `[` / `]` 在中文输入法下也能建区间
- 拖动窗口时视频画面不再错位
- 标记列表 F/G 显示不全
- 批量剪辑的进度与失败清理

完整改动见 [CHANGELOG.md](https://github.com/glowwan/markplay/blob/main/CHANGELOG.md)。

### 已知限制

- 未签名，SmartScreen 会提示；未在杀软白名单内
- 视频画面是原生子窗口，控件无法叠加在画面上
- `-c copy` 剪辑的切点会落在关键帧上；需要精确请勾选"重新编码"
- EDL 为非丢帧，29.97 素材按 30fps 名义帧率计帧
- 转场识别对**连续运动**素材（行车记录仪、长镜头）抓到的是"画面突变"而非"镜头切换"，数量会明显偏少
- 合并剪辑必然重新编码，不是无损拼接

---

### English

Cumulative update since v1.2.1. Windows 10/11 x64 — run the setup, no Node.js or extra runtime required.

Highlights:

- **Scene-cut hints** — scan once, then drag a sensitivity slider to filter instantly (no rescan). Hints only; nothing is marked automatically.
- **Frame snapping** — marker and range times snap to the nearest frame, using the source frame rate.
- **`Ctrl+S` marker-file backup** — timestamped copies, 10 most recent kept per video.
- **Drag the range bar body** to shift a whole range with its width preserved.
- **Batch rename markers** — prefix / suffix / renumber by time order, with live preview and a single undo step.

Fixes include bitrate-accurate re-encoding, duplicate marker loading, `[`/`]` under Chinese IMEs, video-surface misalignment when moving the window, and missing markers in long lists.

**Note:** the installer is unsigned, so SmartScreen will warn about an unknown publisher — click **More info → Run anyway**.

See [CHANGELOG.md](https://github.com/glowwan/markplay/blob/main/CHANGELOG.md) for details.
```

---

## 发布后追加校验和

```powershell
Get-FileHash "dist\MarkPlay Setup 1.6.0.exe" -Algorithm SHA256 |
  Select-Object -ExpandProperty Hash
```

在说明末尾追加：

```
SHA256: <粘贴哈希>
```
