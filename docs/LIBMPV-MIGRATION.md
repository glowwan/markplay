# libmpv 渲染重构方案（评估稿）

> 目标：评估"把 mpv 从原生子窗口（`--wid`）换成 libmpv 渲染"的可行路径、代价与分阶段落地方式。
> 结论先行：**Electron 没有把外部渲染表面合成进自己窗口的公开 API**，所以"真正的零拷贝内嵌"做不到；可行的替代是 **libmpv 软件渲染 + 共享内存/传输缓冲 + WebGL 上传**，能换来"控件可以盖在视频上"和"没有原生窗口的焦点/DPI/层级问题"，代价是分辨率和帧率上限。

## 1. 为什么值得改

现在的播放画面是一个 frameless、透明的 `BrowserWindow`（`surfaceWindow`），把它的 HWND 交给 `mpv --wid` 嵌入。这套方案能跑，但所有别扭的地方都来自它：

| # | 现象 | 根因 |
|---|------|------|
| 1 | 控制条只能放在视频下方，不能悬浮 | HTML 无法绘制在原生子窗口之上（z-order 由 OS 决定） |
| 2 | 全屏要单独给子窗口 `setFullScreen`/`setBounds` 打补丁 | 子窗口不在 Chromium 的布局体系里 |
| 3 | 点过画面后键盘焦点跑到 mpv，`Space/A/B` 失灵 | 原生窗口会抢焦点 |
| 4 | 125%/150% 缩放下需要 DPI 换算开关 | 子窗口坐标是 DIP，但原生窗口尺寸由 OS 管理，跨屏时容易错位 |
| 5 | 视频区与 UI 的 resize 不同步，需要 500ms 轮询 `set-video-rect` | 渲染进程收不到窗口 move 事件，只能轮询 |
| 6 | 截图/缩略图/画中画类功能无处下手 | 画面不在 Chromium 的合成树里 |
| 7 | 多显示器 + 不同缩放时行为依赖 Windows 版本 | 原生窗口的 DPI 感知由进程和 OS 共同决定 |

## 2. 目标与非目标

**目标**

- 视频画面进入 Chromium 的合成树（canvas/WebGL），UI 可以自由叠加；
- 去掉子窗口、焦点抢占、DPI 换算、矩形轮询；
- 保持 mpv 的解码覆盖面和 seek/scrub 手感；
- 保留 `--wid` 作为"高分辨率回退"。

**非目标**

- 不追求 4K60 HDR 的零拷贝；
- 不替换 mpv 的解码栈（不自己做 demux/decode）。

## 3. 路线对比

| 路线 | 原理 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. 现状 `--wid`** | mpv 原生窗口嵌进 Electron 窗口 | 全格式、硬解、性能最好 | 上述 7 条问题；UI 不能叠加 | 保留为回退 |
| **B. libmpv 软件渲染 + 共享内存** | 原生 addon 调 `mpv_render_context` 的 `MPV_RENDER_API_TYPE_SW`，把 BGRA 帧写进 SAB，渲染进程 `texImage2D` 上传 WebGL | 画面进合成树；UI 可叠加；无焦点/DPI 问题；全格式（仍由 mpv 解码） | 每帧一次 CPU 拷贝 + 一次 GPU 上传；4K60 带宽吃紧；需要 native addon 与 libmpv 分发 | **推荐** |
| **C. WebCodecs 网页播放器** | 用 WebCodecs 解码 + JS demuxer | 纯 Web、UI 最自由、打包简单 | 只支持 mp4/webm 容器；MKV/TS 要 JS demux；10bit/HDR/字幕支持弱；丢掉"万能解码"卖点 | 备选 |
| **D. libmpv OpenGL/D3D11 直接合成** | 用 D3D11/DComp 把 mpv 交换链合进 Electron 窗口 | 零拷贝、性能最好 | Electron 不暴露合成表面 API；需要 fork Electron 或写 DComp 宿主，工程上不可行 | 排除 |

## 4. 推荐路线 B：分阶段落地

### 阶段 0：抽象出 `VideoSurface` 接口（1–2 天）

先把"画面"从 `main.js`/`renderer.js` 里抽出来，形成可替换的接口，后续换实现不影响业务代码：

```js
// src/video-surface.js（主进程）
class VideoSurface {
  mount(rect) {}          // 传入 CSS 矩形
  setSource(file) {}      // 打开文件
  setPaused(p) {}
  seek(t, mode) {}        // mode: 'exact' | 'keyframes'
  setSpeed(v) {}
  setVolume(v) {}
  on(event, cb) {}        // time/duration/paused/fps/eof/error
  destroy() {}
}
```

- `WidSurface`：把现有 `surfaceWindow` + `MpvClient` 包进去，行为不变；
- 新增 `config.VIDEO_SURFACE = 'wid' | 'libmpv'`，默认 `wid`；
- 先只做重构、不改行为，用现测试兜底。

### 阶段 1：原生 addon（1–2 周）

- 用 `node-addon-api`（N-API）包 `libmpv`：
  - `init(width, height, format='bgra')` → 创建 `mpv_handle` + `mpv_render_context`；
  - `load(path)` / `command([...])` / `setProperty(name, value)`；
  - `renderFrame()` → 调 `mpv_render_context_render` 到 `MPV_RENDER_API_TYPE_SW` 的缓冲；
  - 事件回调（`mpv_event`）转成 JS 回调；
- 交付物：`prebuilds/win32-x64/*.node` + `libmpv-2.dll`（及依赖 dll）；
- 用 `prebuildify` 预编译，避免用户装 VS 工具链。

### 阶段 2：帧传输 + 渲染（1 周）

- 三缓冲 SharedArrayBuffer：addon 写第 `i` 帧，渲染进程读第 `i-1` 帧，避免撕裂；
- 渲染进程用 WebGL2：`gl.texImage2D(..., BGRA)` + 一个全屏 quad；只在 `frameSeq` 变化时上传；
- 尺寸策略：按**窗口显示尺寸**渲染（例如 1280×720），而不是源分辨率，直接砍掉 4K 带宽问题；
- 回退：`SharedArrayBuffer` 不可用或帧率不足时自动切回 `wid`。

### 阶段 3：切换与回归

- 设置项/环境变量 `MARKPLAY_SURFACE=libmpv` 灰度；
- 验收通过后默认 `libmpv`，`wid` 保留给"4K/高帧率/异常回退"。

## 5. 性能预算（BGRA，单帧 = 宽×高×4）

| 分辨率 | 单帧 | 30fps | 60fps |
|--------|------|-------|-------|
| 1280×720 | 3.7 MB | 110 MB/s | 221 MB/s |
| 1920×1080 | 8.3 MB | 249 MB/s | 498 MB/s |
| 2560×1440 | 14.7 MB | 443 MB/s | 885 MB/s |
| 3840×2160 | 33.2 MB | 996 MB/s | 1.99 GB/s |

经验判断：

- 1080p60 在桌面 CPU 上 memcpy + WebGL 上传约 0.5 GB/s，**可行但吃 CPU**，需要实测；
- 4K30 接近 1 GB/s，**边缘**；4K60 不建议；
- 按窗口尺寸渲染（阶段 2）后，实际带宽通常落在 720p–1080p 档，风险可控；
- 如果 `texImage2D` 成为瓶颈，可改用 `ImageBitmap` + `transferToImageBitmap` 或 `WebGL2` 的 `PIXEL_UNPACK_BUFFER`。

## 6. 许可与分发

- mpv 默认 **GPLv2+**；libmpv 可以用 `--enable-lgpl` 构建成 **LGPLv2.1+**。分发前必须确认构建开关，并随包提供：
  - libmpv 的版权与许可声明；
  - 对应源码/修改的获取方式（LGPL 要求）；
  - 自有代码与 libmpv 的链接方式说明。
- 若采用 GPL 构建，整个应用需要按 GPL 分发——对这个项目通常不可接受，**优先 LGPL 构建**。
- `libmpv-2.dll`、FFmpeg 相关 dll 不要塞进 asar；用 `extraResources` 放 `resources/bin`，并按需 `asarUnpack`。

## 7. 接口草案（主进程 ↔ addon）

```cpp
// 伪代码
mpv_handle* mpv = mpv_create();
mpv_set_option_string(mpv, "vo", "libmpv");
mpv_set_option_string(mpv, "hwdec", "auto");   // 仍可硬解，渲染走 SW
mpv_initialize(mpv);

mpv_opengl_init_params gl = {...};
mpv_render_param params[] = {
  {MPV_RENDER_PARAM_API_TYPE, (void*)MPV_RENDER_API_TYPE_SW},
  {MPV_RENDER_PARAM_SW_SIZE, &size},
  {MPV_RENDER_PARAM_SW_FORMAT, "bgra"},
  {MPV_RENDER_PARAM_SW_STRIDE, &stride},
  {MPV_RENDER_PARAM_SW_POINTER, buffer},
  {0}
};
mpv_render_context_create(&ctx, mpv, params);
mpv_render_context_render(ctx, params);
```

## 8. 验收标准

1. 控件可以绝对定位在视频上（进度条悬浮、字幕设置浮层）；
2. 1080p60 播放丢帧 < 1%，seek/scrub 手感不差于现状；
3. 4K30 可播放（允许自动降采样到窗口尺寸）；
4. 全屏/多显示器/125% 缩放无错位，不需要矩形轮询；
5. `MARKPLAY_SURFACE=wid` 可一键回退，回退路径回归测试通过；
6. 安装包体积增量 < 40MB，且许可文件齐全。

## 9. 风险与退出策略

| 风险 | 概率 | 应对 |
|------|------|------|
| SAB/三缓冲在 Electron 里表现不稳定 | 中 | 先做 720p 原型验证；失败则用 `ArrayBuffer` 转移（每帧新建） |
| 高分辨率下 CPU 占用过高 | 中 | 按窗口尺寸渲染 + 自动降级到 `wid` |
| 原生 addon 构建/分发复杂 | 高 | prebuildify + 固定 libmpv 版本；CI 出预编译产物 |
| libmpv 版本升级导致 ABI/行为变化 | 中 | 固定版本 + 冒烟测试脚本 |
| 许可合规 | 中 | 使用 LGPL 构建，随包附 NOTICE 与源码链接 |

## 10. 工作量估算

| 阶段 | 人日 | 产出 |
|------|------|------|
| 0 抽象接口 | 1–2 | `VideoSurface` + `WidSurface`，行为不变 |
| 1 addon 原型 | 5–8 | 能打开文件、渲染一帧到内存 |
| 2 帧传输 + WebGL | 5–7 | 720p/1080p 播放、seek、音量 |
| 3 打磨与回退 | 5–8 | 全屏/多屏/回退/打包/许可 |
| 合计 | **16–25 人日** | 可发布版本 |

## 11. 如果只做一件事

先做**阶段 0**。它不改行为、风险最低，却能把 `main.js` 里和 `--wid` 绑死的逻辑（矩形、全屏、焦点、DPI）收进一个实现类。等哪天真的要换渲染，业务代码不用再动。
