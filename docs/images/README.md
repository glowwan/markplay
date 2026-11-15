# 演示动图 / 截图

README 目前用一张静态界面截图（托管在 GitHub 的 user-attachments，不占仓库体积）。
想加**动图**时按下面做 —— 这个工具的卖点是"刷片手感"，动图的说服力远大于文字。

## 先决定拍什么

不要贪多。**1–2 段、每段 5–8 秒**，只讲一件事：

| 文件名 | 拍什么 | 为什么值得拍 |
|---|---|---|
| `scrub.gif` | 触摸板左右推拉，画面连续跟手、时间码飞转 | 这是文字描述不出来的核心体验 |
| `markers.gif` | 按 A / B / C / D，右侧列表实时冒出新条目 | 展示"反馈即时" |
| `ranges.gif`（可选） | `[` `]` 建区间 → 拖边界 → 合出一个文件 | 展示完整工作流 |

一张静态图 + 一段动图通常比两段动图更好：动图只用来强调最独特的那一点。

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

**实测参考**（6 秒、1280×720 源）：

| 参数 | 输出体积 |
|---|---|
| 960 宽 / 15fps | 3.7 MB（测试图案，高频噪声最坏情况） |
| 800 宽 / 12fps | 2.3 MB |

真实界面大部分区域是静态的，**同样的参数通常只有上表的一半左右**。

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

## 顺带：封面图

GitHub 仓库右上的 **Social preview**（Settings → General → Social preview）建议上传一张
1280×640 的图：左边放界面截图、右边大字写「刷片 · 打点 · 出片」。
分享到社交平台时显示的是它，不是 README 里的图。
