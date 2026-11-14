# Release 说明（可直接粘贴到 GitHub Releases）

下面两段分别对应 Release 标题与说明正文。发布时在仓库 → Releases → Create a new release：

- **Tag**: `v1.2.1`
- **Target**: `main`
- **Title**: 用下面的中文标题
- **Describe this release**: 粘贴下面整段（含英文部分）
- **Attach binaries**: 上传 `MarkPlay Setup 1.2.1.exe`

---

## 标题

```
v1.2.1 — 首个可安装版本
```

## 说明正文

```markdown
第一个提供安装包的版本。Windows 10/11 x64，下载后双击安装即可，运行不需要 Node.js 或其它依赖（mpv 与 ffmpeg 已打包在内）。

### 下载

- **MarkPlay Setup 1.2.1.exe**（约 140 MB，含播放与剪辑内核）

> ⚠️ 安装包**未做代码签名**，Windows 首次运行会提示"未知发布者"。
> 点 **更多信息 → 仍要运行** 即可，这是个人项目的常见情况，不影响功能。

### 它是什么

看片、找点、出门——给剪辑和素材整理用的打点播放器。

- 触摸板左右推拉 = 带惯性的顺滑刷片，画面连续跟手
- `A`–`G` 六种标记随按随记，右侧列表实时更新
- `[` `]` 划出入点生成区间，应用内直接剪片段、批量出片或合并成一条
- 导出 CSV / EDL / JSON，帧号与时间码跟随素材真实帧率

### 本版要点

- 显式区间模型（`[in, out]`），支持拖动两端改边界
- 时间轴缩放：`Ctrl+滚轮` / `Ctrl+±` / `Ctrl+0`，`Shift+滚轮` 平移
- 批量剪辑、批量合并（合并会重新编码以保证切点准确）
- A–B 循环，按钮显示当前区间序号
- 撤销 / 重做（`Ctrl+Z`），逐帧（`,` `.`）
- 重新编码按源文件码率控制，输出体积接近原文件
- 运行日志：`logs/markplay.log`，菜单"帮助 → 打开日志文件夹"

完整改动见 [CHANGELOG.md](CHANGELOG.md)。

### 已知限制

- 未签名，SmartScreen 会提示；未在杀软白名单内
- 视频画面是原生子窗口，控件无法叠加在画面上
- `-c copy` 剪辑的切点会落在关键帧上；需要精确请勾选"重新编码"
- EDL 为非丢帧，29.97 素材按 30fps 名义帧率计帧

### 反馈

遇到问题请附上 `%APPDATA%\MarkPlay\logs\markplay.log` 的最后一段，以及视频的编码信息（`ffprobe` 输出或格式名）。

---

## English

First build with an installer. Windows 10/11 x64 — just run the setup, no Node.js or extra runtime required (mpv and ffmpeg are bundled).

A video player for reviewing footage and logging markers:

- Inertial, frame-accurate trackpad scrubbing
- Six marker types via `A`–`G`
- Explicit `[in, out]` ranges; cut clips, batch-export, or merge them in-app
- CSV / EDL / JSON export with frame numbers matching the source frame rate

**Note:** the installer is unsigned, so SmartScreen will warn about an unknown publisher — click **More info → Run anyway**. That's normal for a personal project.

Known limitations: the video surface is a native child window (UI can't overlay it); `-c copy` cuts snap to keyframes; EDL is non-drop-frame.

See [CHANGELOG.md](CHANGELOG.md) for details.
```

---

## 发布后自动生成的校验和（可选）

如果想让下载者能验证完整性，本地算一下再写进 Release 说明：

```powershell
Get-FileHash "dist\MarkPlay Setup 1.2.1.exe" -Algorithm SHA256 |
  Select-Object -ExpandProperty Hash
```

然后在说明末尾追加：

```
SHA256: <粘贴哈希>
```
