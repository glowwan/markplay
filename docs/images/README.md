# 演示动图 / 截图

README 用的两张图都已经在这里：

| 文件 | 用途 | 规格 |
|---|---|---|
| `scrub.gif` | 「界面」段落的主演示，展示触摸板推拉刷片 | 720×451，15fps，3 秒，4.6 MB |
| `social-preview.png` | GitHub 分享封面（**需要手动上传**，见文末） | 1280×640，374 KB |

`scrub.gif` 的来源：从 48 秒录屏里按场景分挑出最活跃的 8–11s 段（视频区活动量 7.6，全程峰值），
再压到 720 宽 / 15fps / 160 色。侧栏几乎不动说明这段是纯刷片画面，正好对应最该展示的那件事。

想再补其他演示时按下面做 —— 这个工具的卖点大多"动起来才看得懂"。

## 先决定拍什么

不要贪多。**1–2 段、每段 3–8 秒**，只讲一件事：

| 文件名 | 拍什么 | 为什么值得拍 |
|---|---|---|
| `scrub.gif` ✅ 已有 | 触摸板左右推拉，画面连续跟手、时间码飞转 | 这是文字描述不出来的核心体验 |
| `markers.gif` ⬜ 待拍 | 按 A / B / C / D，右侧列表实时冒出新条目 | 展示"反馈即时" |
| `ranges.gif` ⬜ 可选 | `[` `]` 建区间 → 拖边界 → 合出一个文件 | 展示完整工作流 |

> 拍之前先确认侧栏真的在动。用下面这条命令能看出录屏里"哪块在变"——如果侧栏区域的分数接近 0，
> 说明只录到了视频播放，没录到打点：
>
> ```powershell
> .\resources\bin\ffmpeg.exe -hide_banner -nostdin -i rec.mp4 -an -sn -dn `
>   -filter:v "crop=300:600:960:60,select='gte(scene\,0)',metadata=print:file=-" -f null -
> ```

## 录制

推荐 **ScreenToGif**（免费）：https://www.screentogif.com/

1. 打开 MarkPlay，载入一段有动作的素材（不要纯色/静止画面）
2. ScreenToGif → **录制 → 屏幕**，框选视频区 + 侧栏
3. 帧率选 **15fps** 足够（GIF 体积小、看着也顺）
4. 录完在编辑器里裁掉多余首尾帧
5. **导出为视频而不是 GIF**（导出 `mp4` 或 `mkv`），后面统一用脚本压 —— ScreenToGif 自带的 GIF 导出体积偏大

> 没有 ScreenToGif 也可以直接用项目自带的 ffmpeg 录屏：
>
> ```powershell
> # 录整个屏幕 8 秒（先切到 MarkPlay 窗口）
> .\resources\bin\ffmpeg.exe -f gdigrab -framerate 15 -i desktop -t 8 -c:v libx264 -crf 20 rec.mp4
>
> # 只录屏幕的一块区域（先算出左上角坐标和宽高）
> .\resources\bin\ffmpeg.exe -f gdigrab -framerate 15 -offset_x 100 -offset_y 100 -video_size 1280x720 -i desktop -t 8 -c:v libx264 -crf 20 rec.mp4
> ```

## 转成优化过的 GIF

```powershell
.\tools\make-gif.ps1 -Video rec.mp4 -Name scrub
```

脚本用 ffmpeg 的 `palettegen` / `paletteuse` 两遍法（256 色 + bayer 抖动），
比默认转换小一半以上。默认 960 宽、15fps、≤5MB 会给出提示。

体积还是偏大时逐级退：

```powershell
.\tools\make-gif.ps1 -Video rec.mp4 -Name scrub -Width 800 -Fps 12
```

**实测参考**（`scrub.gif` 的真实源：1262×790、30fps、视频区每帧都在变，属于高熵素材）：

| 参数 | 时长 | 体积 |
|---|---|---|
| 960 宽 / 12fps / 256 色 | 6s | 14.7 MB ✗ |
| 800 宽 / 10fps / 192 色 | 5s | 7.7 MB ✗ |
| 720 宽 / 12fps / 160 色 | 4s | 5.3 MB ✗ |
| **720 宽 / 15fps / 160 色** | **3s** | **4.6 MB ✓** |

结论：**降帧率对体积的收益不如缩时长**，但 8fps 会让"顺滑刷片"看起来像卡顿，得不偿失。
优先保 12–15fps，用缩短时长换体积。改参数后务必确认还能看清在演示什么。

> 超过 10MB 的仓库图片会让访客等很久，反而扣分。宁可短一点、小一点。

## 挂到 README

在 `README.md` 的「界面」小节里加一行：

```markdown
![用触摸板顺滑刷片](docs/images/scrub.gif)
```

英文版 `README.en.md` 同理。

注意：

- **必须是仓库内的相对路径**。不要用本地绝对路径（`C:\...`），也不要用外部图床（国内可能加载不出来）；
- 文件名大小写要和实际一致（Linux 上构建的 CI 对大小写敏感）；
- 加完在 GitHub 页面上刷新看一下，确认不是破图再提交。

## 检查清单

- [ ] 文件放在 `docs/images/` 下，名字和 README 里引用的一致
- [ ] 体积 ≤ 5MB（理想 ≤ 3MB）
- [ ] 一张动图只讲一件事，不超过 8 秒
- [ ] 素材不是纯色/静止画面（否则动图看起来像卡住）
- [ ] 提交前在网页上确认能正常显示

## 封面图（Social preview）

`social-preview.png`（1280×640）已经生成好了，底图是真实录屏帧，左侧压暗后叠标题与标签。

**这张图必须手动上传**，GitHub 没有 API 能设置它：

1. 仓库 → **Settings** → 左侧 **General**
2. 拉到 **Social preview** → **Upload an image**
3. 选 `docs/images/social-preview.png`

分享到微博 / 推特 / 微信 / Discord 时显示的是它，**不是 README 里的图**。这是仓库门面的一部分，
值得花 30 秒传一下。

想改文案就编辑 `tools/make-social-preview.py` 里的文字，然后：

```powershell
$env:SP_TMP = "$env:TEMP\sp"
$env:SP_OUT = "docs\images\social-preview.png"
python tools\make-social-preview.py
```

（`SP_TMP` 是指向 `frame.png` 的目录，用
`ffmpeg -ss 10 -i rec.mp4 -frames:v 1 frame.png` 从那支录屏里抽一帧即可。）
