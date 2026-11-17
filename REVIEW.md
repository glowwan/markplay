# MarkPlay 完善报告（v7 → v1.0.0）

这份文档记录本次对 `markplay-source-v7` 的审计、修复、新增能力，以及我认为接下来最值得做的方向。

## 结论

原项目不是"差一点就能用"，而是**主体已经能跑，但有一批会让功能直接失效的确定性 bug**，加上几个体验缺口（不能撤销、不能改标记时间、没有最近文件）。这次先把"用起来会踩坑"的部分修掉，再补了 6 个高频功能，并把可自动验证的部分（导出格式、标记模型、设置存储）补上了单元测试。

**验证状态**：44 个单元测试全过、全部 JS 文件语法检查通过、HTML/JS 的 DOM id 交叉检查无缺失。GUI 端到端（真实播放/剪辑）没有在这台机器上跑通——本机没有 mpv.exe，Electron 依赖安装也被环境的文件沙箱/网络挡住了一次，需要你在自己机器上 `npm install && npm start` 做一次真机验收。

---

## 一、修掉的 Bug

| # | 问题 | 实际影响 | 修法 |
|---|------|----------|------|
| 1 | `window.prompt()` 用于重命名标记 | **Electron 渲染进程不支持 `prompt`，双击重命名完全不工作**（原生对话框被禁用） | 改成列表项内联 `<input>`，Enter 提交 / Esc 取消 / 失焦提交 |
| 2 | 剪辑面板默认出点失效 | 给 `<select>` 填完 option 后浏览器会自动选中第一项，代码里"`value` 为空才选第二项"永远不成立 → 入点=出点，点"开始剪辑"必报"入点必须早于出点" | 显式计算默认值：入点第一个、出点第二个（不足两个时回落），并保留上次选择 |
| 3 | 视频子窗口 DPI 双重换算 | `BrowserWindow.setBounds` / `getContentBounds` 本来就是 DIP，代码又乘了一次 `scaleFactor`；在 125%/150% 缩放的屏幕上画面整体放大并向右下偏移 | 默认 `SURFACE_APPLY_DPI_SCALE=false`，只在特殊环境手动打开；注释写清原因 |
| 4 | 2x 倒放用 `setInterval` 发 exact seek | exact seek 在长 GOP 上要几百毫秒，定时器继续堆命令 → 越倒越卡，最终触发 5 秒 IPC 超时 | 改成"await 一次 seek 再排下一次"的链式 `setTimeout`，并用代号防止旧链复活 |
| 5 | 点过视频画面后快捷键失灵 | 键盘焦点落在 mpv 的原生子窗口上，`Space`/`A`/`B` 全被吃掉 | 点击后把焦点抢回主窗口 |
| 6 | HWND 只读低 32 位 | 句柄值理论上可能被截断，`--wid` 指向错误窗口 | 按 8 字节读取（`readBigUInt64LE`），短句柄回退 32 位 |
| 7 | mpv.exe 缺失时只有一行状态文字 | 用户不知道发生了什么、也不知道怎么修 | 明确错误文案 + 一次性弹窗 + 下载地址；`ensureMpv` 失败路径保留可重试 |
| 8 | 剪辑失败留下半截文件 | 用户以为剪成功了，播放才发现是坏的 | 非 0 退出码时删除输出；mp4/mov 加 `-movflags +faststart`，`-c copy` 加 `-avoid_negative_ts make_zero` |
| 9 | `end-file` 只处理 `eof`，`file-loaded` 不刷新时长 | 解码失败没有任何提示；首帧时长偶尔读不到 | 补 `end-file` 的 `error` 分支、`file-loaded` 后主动拉一次 duration |
| 10 | 每次换片 mpv 音量回到 100 | 用户调好的音量丢失 | 记住音量，换片后重新下发；滑块变更防抖落盘 |
| 11 | 没有单实例 | 双击两次文件会开两个进程，两个 mpv 抢同一个 sidecar，标记互相覆盖 | `requestSingleInstanceLock` + 第二实例把文件转交给已开窗口；支持命令行/文件关联打开 |
| 12 | 拖入字幕文件报"不支持的文件类型" | `.srt` 只能靠自动加载，手动挂字幕不可用 | 字幕单独识别，走 mpv `sub-add`；并加 `--sub-auto=fuzzy` 自动加载同名/近似字幕 |
| 13 | 500ms 轮询每次都 `setBounds` | 无谓的窗口重排，可能引起画面闪烁/卡顿 | 渲染进程先去重再发 IPC，主进程再按矩形键去重 |
| 14 | 文档与实现不一致 | README 写的 CSV 列、EDL 格式、sidecar 命名、版本号、快捷键都和代码对不上 | README 按实际实现重写；版本号统一到 0.8.0，关于框用 `app.getVersion()` |

## 二、新增能力

| 能力 | 说明 | 位置 |
|------|------|------|
| 撤销 / 重做 | 新增、删除、重命名、拖动改时间都可回退，栈深 50；`Ctrl+Z` / `Ctrl+Shift+Z` | `markers.js` |
| 拖动刻度改时间 | 时间轴上的标记刻度可左右拖，<4px 视为单击跳转；拖动中只改数据不重绘，松手才落盘 | `markers.js` |
| 内联重命名 | 双击标签就地编辑，不再依赖不可用的 `prompt` | `markers.js` |
| 逐帧 | `,` / `.` 调用 `frame-step` / `frame-back-step`，自动暂停 | `renderer.js` |
| A–B 循环 | `L` 或控制条 `A–B` 按钮，用剪辑面板的入点/出点设置 `ab-loop-a/b` | `main`/`renderer` |
| 批量剪辑 | 优先 A→后续最近的 B 配对；没有 B 时相邻两个成组；逐段导出到选定目录，进度按整体换算 | `export.js` |
| 最近打开 | 菜单"文件 → 最近打开"最多 12 条，含"清除最近记录"；失效文件会提示并自动移除 | `main.js` + `settings.js` |
| 设置持久化 | 音量、最近文件、上次目录、窗口位置/大小；窗口位置会校验是否还在可见屏幕内 | `settings.js` |
| 字幕 | 拖入 srt/ass/vtt/ssa/sub/idx/sup 即 `sub-add`；视频旁同名字幕自动加载 | `main.js` |
| Toast 反馈 | 导出/剪辑/字幕成功失败都有右下角提示，成功项带"在文件夹中显示" | `ui.js` |
| 加载遮罩 | 大文件打开时显示 spinner，不再像卡死 | `index.html` + `styles.css` |
| 状态栏分级 | 错误标红并在 6 秒后自动恢复，成功标绿 | `renderer.js` |
| 键盘安全 | 输入框聚焦时所有单键快捷键让位；`Ctrl/Cmd` 组合键单独处理 | `renderer.js` |

## 三、测试

```powershell
npm test        # 等价于 node tests/run.js，25 个用例
```

- `tests/export.test.js`：时间码（25fps 帧码）、CSV 转义与列定义、EDL CMX3600 结构、JSON 结构、区间计算、A/B 配对与回退规则；
- `tests/markers.test.js`：打点编号、时间钳制、撤销/重做、sidecar 路径与内容、从标签续号、坏数据容错、拖动改时间的边界；
- `tests/settings.test.js`：默认值、音量钳制、未知键拒绝、最近文件去重与上限、窗口几何校验、损坏 JSON 回退。

为什么用 `node tests/run.js` 而不是 `node --test tests/`：Windows 沙箱环境下 `--test` 会为每个文件 spawn 子进程，受限环境会直接 `EPERM`；普通进程 require `node:test` 同样执行并输出结果，且不需要 spawn。

---

## 四、接下来我建议做什么（按性价比排序）

### P0：影响"能不能交付"

1. **代码签名 + 安装器体验**：现在 SmartScreen 会拦，发给别人第一关就卡住。至少买一张 OV 证书；或者退一步在 README 顶部写清"更多信息 → 仍要运行"，并附 SHA256。
2. **崩溃/错误日志**：主进程 `uncaughtException`、渲染进程 `window.onerror`、mpv stderr 写进 `userData/logs/`，菜单加"打开日志文件夹"。现在排障全靠猜。
3. **二进制版本固定 + 校验**：`fetch-binaries.js` 拉的是 `latest`，mpv/ffmpeg 升级可能改变行为。建议固定 tag + 记录 SHA256，打包时校验；安装后启动时检测 `mpv --version` 给出版本信息。
4. **真机验收清单**：换片、拖放、全屏（重点看全屏后 `ESC` 和快捷键是否仍响应，此时键盘焦点可能落在 mpv 子窗口）、双屏不同缩放、4K 长 GOP、无音轨、纯音频、字幕、剪辑 copy/重编码、批量剪辑、双开。这些我只能静态检查，必须真机过一遍。

### P1：决定"好不好用"

5. **帧率感知的时间码**：从 mpv 读 `container-fps`，让 EDL/CSV 按素材帧率输出（现在固定 25fps，23.976 素材导入会偏）。这是剪辑工作流里最容易被挑刺的点。
6. **区间标记模型**：现在 A/B 是"两个单点 + 配对规则"，隐含约定太强。更自然的模型是显式的 `[in, out]` 区间，支持命名、备注、颜色，导出和批量剪辑都直接吃区间。
7. **时间轴缩放/滚动**：长视频 + 几百个标记时，刻度会挤成一团。加滚轮缩放（`Ctrl+滚轮`）+ 横向滚动 + 视口裁剪。
8. **标记列表虚拟化**：现在每次变更全量重建 DOM，1000+ 标记会明显卡。简单方案是只渲染视口内的项。
9. **可取消的批量剪辑 + 队列**：现在中途失败会中断整批；建议加"取消"和"失败继续"选项，并在列表里显示每段状态。
10. **最近/会话恢复**：启动时恢复上次视频和播放位置（mpv 的 `watch-later` 也能用），减少"每次重新找片"。

### P2：拉开差距

11. **用 libmpv 替换 `--wid` 子窗口**：这是架构级建议。`--wid` 的本质问题是"原生窗口盖在网页上"，导致控件不能覆盖视频、全屏/DPI/焦点都要打补丁。改用 libmpv 的 render API（`vo=libmpv`）把画面渲染到 canvas，UI 就能自由叠加，全屏和缩放也回到浏览器体系。代价是要引入 native addon（或 `mpv` 的 node 绑定），构建复杂度上升。
12. **缩略图/波形**：ffmpeg 抽帧生成时间轴缩略图，找片效率翻倍；音频素材加波形。
13. **导出更多格式**：Premiere XML / FCPXML / DaVinci 的 markers CSV 变体；现在只有 CMX3600 EDL。
14. **多选与批量操作**：Shift 选区间、批量删除/改类型/改颜色。
15. **快捷键可配置**：把 keymap 抽成配置，允许用户改 `A/B/C` 之外的键，避免和输入法冲突。
16. **代理/转码预处理**：对 4K HEVC 长片，先转 1080p 代理再打点，scrub 会顺滑很多。

### 工程层面

- **把 main 的纯逻辑抽出来测**：ffmpeg 参数拼装、路径校验、最近文件、`findMediaArg` 都可以脱离 Electron 单测；现在只有渲染进程的三个模块有测试。
- **preload 打包后可开 `sandbox: true`**：现在为了 `require('./config')` 关了沙箱。把 preload 用 esbuild 打成单文件、config 通过 `ipcRenderer` 取，就能把安全默认值打开。
- **IPC 白名单**：`write-text-file` / `write-json-file` 接受任意路径，本地应用风险低，但建议限制在"视频同目录 + 用户选的导出路径"。
- **CI**：GitHub Actions 跑 `npm test` + `node --check`，Windows runner 上再跑一次打包，避免"我这儿能跑"。

---

## 五、本次改动的文件

| 文件 | 变化 |
|------|------|
| `src/main.js` | 单实例、最近文件菜单、设置持久化、窗口几何、字幕、mpv 缺失提示、倒放链式重试、DPI 修正、ffmpeg 参数与失败清理、新 IPC |
| `src/settings.js` | 新增：设置存储（可单测） |
| `src/config.js` | DPI 默认值修正、撤销栈深 |
| `src/preload.js` | 新增字幕/目录/设置/应用信息 API |
| `src/renderer/markers.js` | 重写：撤销重做、内联重命名、拖动改时间、sidecar 容错 |
| `src/renderer/export.js` | 重写：CSV/EDL 修正、批量剪辑、Promise 化的单段剪辑、默认入出点修复 |
| `src/renderer/renderer.js` | 重写部分：逐帧、循环、撤销、字幕拖放、设置、加载态、键盘安全、矩形去重 |
| `src/renderer/ui.js` | 新增：toast |
| `src/renderer/index.html` / `styles.css` | 新按钮、加载遮罩、toast、重命名输入框样式 |
| `tests/*` | 新增 25 个用例 + 运行器 |
| `package.json` | 版本 0.8.0 → 0.9.0、`npm test` |
| `README.md` | 按实际实现重写 |

---

## 六、第二轮进度（v0.9.0 → v0.11.0）

### ① 帧率感知时间码 —— 完成

- 主进程订阅 mpv 的 `container-fps`，并在 `file-loaded` 后主动补拉一次（有些容器要等解码器初始化才报帧率）；
- 帧号统一走 `nominalFps()`：23.976→24、29.97→30、59.94→60，其他四舍五入，读不到时回退 25；
- CSV 新增 `frame` 列；EDL 每行帧号按素材帧率换算，并写一行 `* MARKPLAY FPS: 24 (source 23.976)` 注释；JSON 增加 `edlFps` / `sourceFps`；
- 导出面板实时显示"工程帧率：23.976 fps · EDL/帧号按 24 fps 换算"；
- 新增 3 个测试（名义帧率换算、24fps 帧码、24fps 下的 CSV 帧号），总计 30 个。

已知取舍：EDL 仍是 NON-DROP，29.97 长素材会有约 0.1% 漂移；要严格 drop-frame 得再加开关（已记在 TODO）。

### ③ 崩溃与运行日志 —— 完成

- 新增 `src/logger.js`：`userData/logs/markplay.log`，超过 2MB 自动轮转，保留 5 个历史文件；写失败只丢日志、不影响主流程；
- 接入点：`uncaughtException`、`unhandledRejection`、`render-process-gone`、渲染进程 `console-message`（warning/error）、渲染进程 `window.onerror` / `unhandledrejection`、mpv 的 stderr、ffmpeg 的启动命令/失败原因、视频打开/字幕加载；
- 菜单新增"帮助 → 打开日志文件夹"，关于框里也显示日志路径；
- 顺手修了一个潜在问题：mpv 的 stderr 之前只 `pipe` 不读取，日志写多后可能把管道缓冲区写满导致播放卡住，现在持续消费并写入日志；
- 新增 3 个日志测试。

### ② 显式区间标记模型 —— 完成

- 数据模型新增 `ranges: [{id, name, in, out, color}]`，与单点标记并存；sidecar 升级到 **v2**（`{version:2, markers, ranges}`），v1 老文件照常读取；
- 交互：`[` 设入点、`]` 设出点并创建区间；区间列表支持双击改名、点击跳到入点、删除；时间轴上用彩色条显示区间；撤销/重做覆盖区间的增删改；
- 兼容老数据：区间面板的 **A/B → 区间** 按钮把现有 A/B 标记两两配对，一次性迁移（可整体撤销）；
- 剪辑面板从"选两个标记"改为"选一个区间"；单段剪辑、批量剪辑、A–B 循环全部改用区间；
- 导出：新增"区间 CSV"；EDL 有区间时按区间生成、没有区间时回退到标记分段；JSON 同时包含 markers 与 ranges；
- 新增 6 个测试（区间增删/钳制/撤销、v2 读回、v1 兼容、A/B 迁移、区间 CSV、区间 EDL、JSON 双模型），总计 36 个。

已知取舍：区间建好后暂不支持拖拽边界（只能改名/删除重建），已写进 README 的 TODO。

### ④ 时间轴缩放 + 列表虚拟化 —— 完成

- 新增纯计算模块 `timeline-view.js`：维护 `[start, end]` 可视窗口，提供 `zoomAt / panBy / centerOn / keepVisible / toRatio / toTime`；时长不变时保留缩放，换片才重置；
- 时间轴刻度、区间条、播放头全部按可视窗口换算，窗口外的元素直接不渲染；
- 交互：`Ctrl+滚轮` 以鼠标为锚点缩放、`Ctrl+=/-` 以播放头缩放、`Ctrl+0` 适配全片、`Shift+滚轮` 平移；控制条新增缩放按钮和倍率显示；播放头跑出窗口时自动居中跟随；
- 区间条两端加了拖拽手柄，可直接改 in/out（拖动中只更新几何，松手才整体重绘 + 落盘 + 压撤销点）；
- 标记列表和区间列表改为虚拟滚动：容器限高、spacer 撑出总高度、行绝对定位，只渲染可视行（±2 行缓冲），滚动按帧节流；1000+ 标记不再整表重建；
- 新增 7 个 `timeline-view` 测试（默认全片、锚点缩放、最小跨度、平移夹取、跟随、时长重置、空视频）+ 1 个区间边界拖拽测试，总计 44 个。

### ⑤ libmpv 方案 + 发布/签名文档 —— 完成（文档级）

这两项在本环境无法"做成代码"，产出的是可直接执行的方案文档：

- **`docs/LIBMPV-MIGRATION.md`**：先列清 `--wid` 子窗口带来的 7 个具体问题；对比四条路线（现状 / libmpv 软件渲染 + 共享内存 / WebCodecs / D3D11 直接合成），结论是 Electron 不暴露合成表面 API，**零拷贝内嵌不可行**，可行路线是 libmpv 软件渲染 + 三缓冲 + WebGL 上传，并给出 1080p60 约 0.5 GB/s 的带宽预算、分阶段落地（先抽象 `VideoSurface` 接口）、许可（LGPL 构建）、16–25 人日估算与回退策略；
- **`docs/RELEASE.md`**：代码签名方案对比（OV/EV/Azure Trusted Signing/SignPath）、electron-builder 配置与时间戳、`signtool` 验证、构建前检查、二进制固定 + SHA256 校验改造建议、发布流程、真机冒烟矩阵、回滚与日志隐私。

为什么没直接做：libmpv 需要 native addon 与 libmpv 构建产物，本环境没有编译/验证条件；代码签名需要证书与实名材料，只能在你的账号下完成。

## 七、目标收口（v1.0.0）

| 项目 | 状态 | 证据 |
|------|------|------|
| ① 帧率感知时间码 | 完成 | `nominalFps` + CSV frame 列 + EDL 帧率注释；测试覆盖 23.976/29.97/59.94 |
| ② 显式区间模型 | 完成 | sidecar v2 + 区间 UI/拖边界/批量剪辑/EDL；v1 兼容与迁移测试 |
| ③ 崩溃与运行日志 | 完成 | `logger.js` + 全链路接入 + 日志菜单；轮转/失败容错测试 |
| ④ 缩放 + 列表虚拟化 | 完成 | `timeline-view.js` + 虚拟滚动 + 区间手柄；8 个相关测试 |
| ⑤ libmpv / 签名方案 | 完成（文档） | `docs/LIBMPV-MIGRATION.md`、`docs/RELEASE.md` |
| 自动化验证 | 44 个测试全过 | `npm test`；语法检查 0 失败；DOM id 无缺失 |
| GUI 端到端 | **未验证** | 本机无 mpv.exe 且 Electron 依赖未能装完，需真机 `npm install && npm start` |

> 结论：代码层面的四项改造已完成并可交付；libmpv 重构与代码签名按计划停在"可执行方案"层面。上线前唯一剩下的是真机验收（清单见 `docs/RELEASE.md` 第 8 节）。

## 八、v1.0.1 修复（安装阶段）

真机首次构建时 `tools/fetch-binaries.js` 报 `GitHub API 请求失败，HTTP 403`（本机复现一致），导致 mpv/ffmpeg 都下不下来。修复：

- mpv：API 失败（403/限流/网络拦截）时自动改抓 `releases/latest` 网页，若资产在 `expanded_assets` 片段里再跟一次请求；已用真实页面验证能解析出 `mpv-x86_64-20261107-git-9028187538.7z`；
- ffmpeg：gyan.dev 为第一来源，失败自动回退 BtbN 的 `ffmpeg-master-latest-win64-gpl.zip`（用 Windows 自带 `tar` 解压）；
- 新增 `MARKPLAY_RESOLVE_ONLY=1`（只解析不下载）、`MARKPLAY_FORCE_HTML=1`（强制跳过 API）、`MARKPLAY_MPV_URL=<直链>`（完全绕开 GitHub）三个排障开关；
- 下载完成后打印 SHA256 前 16 位，便于核对；
- README 补充了"下载失败怎么办"的直链与手动步骤（ffmpeg 要点名 **release builds** 区的 `ffmpeg-release-essentials.7z`，不是 git master 区的 `ffmpeg-git-essentials.7z`）。

## 九、v1.0.2 修复（真机反馈）

真机跑起来后反馈的三个问题：

1. **Ctrl+滚轮 / Ctrl+0 / Shift+滚轮 缩放无效**
   - 原因一：缩放只监听在 30px 高的 `#timeline` 上，在视频画面上滚动时事件走的是 surface 窗口，scrub 把带修饰键的滚轮也当成 scrub 吃掉了；
   - 原因二：点过视频后焦点可能落在 mpv 原生窗口，键盘事件到不了主窗口；之前为了规避未知选项把 `--input-vo-keyboard=no` 去掉了，实际 mpv 0.42 支持它。
   - 修复：surface 的 wheel 事件带上 `ctrlKey/shiftKey`；scrub 遇到修饰键直接让行；renderer 处理视频画面上的 Ctrl/Shift+滚轮；`Ctrl+0/±` 改由主进程 `before-input-event` 截获并转发（即使焦点在 `<select>` 也有效）；恢复 `--input-vo-keyboard=no`，点击画面后同时 `mainWindow.focus()` + `webContents.focus()`。

2. **拖动窗口时画面错位**
   - 原因：渲染进程的 `getBoundingClientRect()` 是相对视口的，窗口移动时它不变，500ms 轮询的去重逻辑因此不再发 `set-video-rect`；主进程只在收到 IPC 时重算屏幕坐标，于是视频子窗口停在旧位置。
   - 修复：主进程监听 `mainWindow` 的 `move` / `resize`，用缓存的 `lastVideoRect` 重新计算并 `setBounds`，拖动过程中实时跟随。

3. **只能对 A/B 操作，C/D 用不上**
   - 原因：区间本身不限制类型，但界面只有 "A/B → 区间" 一个生成入口，批量按钮还标着"(A-B 配对)"，看起来像只支持 A/B。
   - 修复：新增 **相邻配对**（按时间 1-2、3-4…，任意标记类型，自动跳过重复区间）；批量按钮改名 **批量剪辑（按区间）**；区间面板明确提示"标记类型只是参考点，任意时间 `[`/`]` 都可建区间，批量剪辑使用所有区间"。

测试增至 **45 个**（新增相邻配对用例），语法检查 0 失败，DOM id 无缺失。

## 十、版本收口（v1.0.2）

| 项 | 状态 |
|----|------|
| 四项改造 + ③ 日志 | 完成 |
| 安装阶段 403 修复 | 完成并实测下载/解压 |
| 真机反馈三项修复 | 完成，待你重新构建验收 |
| 代码签名 / libmpv | 停在方案文档（需证书 / native 构建） |
| 自动化验证 | 45 个测试全过；语法 0 失败；DOM id 无缺失 |

## 十一、v1.1.0：批量合并剪辑

需求：批量剪辑现在每个区间出一个文件，希望可以勾选后合并成一个。

实现：

- 剪辑面板新增 **合并为一个文件（批量剪辑时，会自动重新编码）** 勾选框；勾选后批量按钮文案变为"批量剪辑并合并"；
- 合并模式不再选目录，而是弹"另存为"，默认 `<视频名>_merged.mp4`；
- 主进程新增 `run-merge-clip`：按区间顺序逐段裁剪到临时目录 → 写 concat 列表 → `ffmpeg -f concat -c copy` 拼接 → 删除临时目录；
- 进度：分段占 0–90%，拼接 90–100%；整条链路用 `mergeInProgress` 锁住，期间 `run-clip` 会拒绝，避免两个 ffmpeg 抢资源；
- 失败时删除半成品与临时目录，错误写日志并 toast。

为什么合并强制重编码：实测 stream copy 的 `-ss 2 -t 3` 会从关键帧开始（2–5 秒的区间实际得到 5 秒内容），而 `-i` 之后 seek + copy 会得到一个开头没有关键帧、解不出画面的文件。合并模式用 `-ss` + libx264/aac 逐段精确裁剪，再用 concat 无损拼接，代价是耗时与一次转码损失。

验证：

- 用 30 秒合成片测了 3 段（2–5、10–12、20–22），合并输出时长 7.04 秒（期望 7 秒），可正常解码；
- 45 个单元测试仍全过；语法检查 0 失败；DOM id 无缺失。

## 十二、v1.1.1：A–B 循环跟随区间切换

反馈：控制条的 A–B 按钮看起来"一直是高亮/固定状态"，没法切到别的区间。

实际是两件事叠在一起：

- 按钮高亮本身表示循环开着；之前只看 `state.looping`，不显示在循环哪个区间，也**不会**因为你换剪辑面板的区间而更新，所以像"锁死"；
- 按钮获得焦点时还会叠一圈 Chromium 默认蓝色 focus ring，视觉上更像"固定状态"。

修复：

- 循环开启时按钮文字变成 `A–B 1` / `A–B 2`（当前区间序号），tooltip 显示区间名与时间范围；
- 剪辑面板换区间时，如果循环开着，自动把 `ab-loop-a/b` 切到新区间，状态栏提示切换结果（不会退出循环）；
- 区间被删除或列表为空时，循环会自动关闭；
- 去掉 `.icon-btn` 的默认 focus outline，改用 `:focus-visible` 的细描边，避免和"循环开启"的高亮混淆。

45 个测试仍全过；语法 0 失败；DOM id 无缺失。

## 十四、v1.2.0：标记列表、面板顺序、重编码体积

### 1. F/G 标记显示不全

根因是列表虚拟化：`renderVirtual` 按"渲染那一刻的 `clientHeight`"决定画多少行；如果窗口/侧栏尺寸之后变大，列表不会自动重绘，就会出现"只画了 4 行、下面还有空间但后两条不显示"。滚动条本身是有的，但 Windows 的 overlay 滚动条在鼠标移上去之前几乎看不见。

修复：

- 行数 ≤200 时**全量渲染**（不再走虚拟化），F/G 一定在；只有超过 200 条才启用虚拟滚动；
- 窗口 `resize` 时重绘两个列表，虚拟列表不会停留在旧的"可视行数"；
- 标记列表 `max-height` 从 260 提到 340，行数多时正常出现滚动条；`scrollbar-gutter: stable` 避免出现滚动条时内容横向跳动。

### 2. 导出 / 剪辑面板上下互换

侧栏顺序改为：标记 → 区间 → **剪辑** → **导出**，符合"先剪、后导"的操作习惯。

### 3. 重新编码后文件反而变大

原来固定 `-crf 23 -preset veryfast`：CRF 是"按质量"给码率，源文件如果是低码率（例如 165MB / 37 分钟 ≈ 594kbps），CRF 23 会产生 365MB。

改为按源文件码率做 ABR：

- 目标总码率 = 文件大小 × 8 ÷ 时长；
- 音轨按 96kbps 预留，视频码率 = 总码率 − 96kbps（低于 120kbps 时按总量的 70% 兜底）；
- 编码参数：`libx264 -preset fast -b:v <目标> -maxrate 1.2× -bufsize 2×`，音轨 `aac 96k`；
- 时长未知或文件读不到时，仍然回退到原来的 CRF 23；
- 合并剪辑的每一段也用同一目标码率，合并后体积随选中总时长线性变化。

用 30 秒合成片验证：源 1.17MB（311kbps）→ 目标视频 215kbps → 输出 0.90MB，比例 0.775，不再出现"越压越大"。真实素材纹理复杂，ABR 会更接近目标码率。

47 个测试全过；语法 0 失败；DOM id 无缺失。

## 十五、v1.2.1：修复 [ / ] 建区间失效

原因有三层：

- 快捷键用 `e.key` 判断 `[` / `]`；中文输入法/中文标点下，这两个键的 `e.key` 会变成 `【` / `】` 或 `Process`，条件永远不成立；
- 焦点在 `<select>`（比如点过"区间"下拉）时，`isTypingTarget` 直接吞掉了所有快捷键；
- 如果焦点落在 mpv 原生画面，键盘事件根本到不了主窗口。

修复：

- 改用物理键位 **`e.code === 'BracketLeft' / 'BracketRight'`** 判断，不受输入法/键盘布局影响；
- 括号处理提前到"输入框守卫"之前，只在 `INPUT` / `TEXTAREA` 里让行；焦点在 `<select>` 上也能建区间；
- 保留 `【` / `】` 作为兜底；
- 输入框里仍然可以正常输入 `[` `]`，不会误触发。

47 个测试全过；语法 0 失败；DOM id 无缺失。

## 十三、v1.1.2：修复重复打开导致标记/区间翻倍

现象：同一个视频反复打开，标记列表和区间列表会成批重复（24 个标记、多个同名同时间的区间），每打开一次翻一倍。

根因：

- 主进程 `doLoadVideo` 对**每一次**加载都发 `video-loaded` 事件；
- 渲染进程 `loadVideo` 在 IPC 返回后也会调 `afterVideoOpened`；
- 两条路径几乎同时进入 `Markers.loadSidecar`：它先把 `items=[]`，然后 `await` 读 sidecar，两个 Promise 都回来后各自把同一批标记 push 进去 → 内存里翻倍；
- 之后任何一次保存都会把翻倍的数据写回 sidecar，下一次打开再翻倍。

修复：

- `doLoadVideo(filePath, notifyRenderer)`：只有视频子窗口拖放（主进程唯一入口）才发 `video-loaded`；渲染进程自己调的 `load-video` 不再发，避免双重触发；
- `loadSidecar` 增加加载令牌：并发加载时只有最后一次能写入结果，旧结果直接丢弃；
- 读取时按 `id` 去重（历史重复是同一份 sidecar 反复追加，id 相同），并在发现重复时自动把清理后的内容写回文件；
- `Markers.clear()` 也会作废还在路上的加载，避免换片时旧文件的数据串进来。

新增 2 个测试（重复 id 去重并回写、并发加载只落一份），总计 **47 个**全过；语法 0 失败；DOM id 无缺失。

> 你现有的 `*.markplay.json` 不需要手动改：用 1.1.2 打开一次，会自动去重并写回。

## 十六、v1.3.0 准备：主进程纯逻辑抽出 + 社区文件

这一轮没改用户可见行为，做的是"让后面的改动更安全"。

### 为什么先做这个

[libmpv 方案](docs/LIBMPV-MIGRATION.md) 的第一阶段是"抽象出 VideoSurface 接口"。但 `main.js` 有 1600 行、**零测试覆盖**，直接在里面做接口改造风险太高——一旦改坏，表现是"播放黑屏"或"窗口不跟随"，而这类问题只能靠真机跑才能发现。

所以先把**有逻辑、容易错、但不碰窗口和子进程**的部分抽出来：

| 抽出的函数 | 为什么值得测 |
|---|---|
| `estimateVideoBitrate` | 码率算错 = 剪辑后体积翻几倍（v1.2.0 就是这个 bug） |
| `reencodeArgs` | 参数拼错 = ffmpeg 静默产出坏文件 |
| `toConcatLine` | 转义错 = 合并剪辑时路径带空格/单引号就失败 |
| `findMediaArg` | 命令行解析错 = 双击文件打不开 |
| `extensionOf` / `isMediaPath` / `isSubtitlePath` | 分错类 = 字幕被当视频打开 |

落到 `src/media-utils.js`，纯函数、无 Electron 依赖，`node tests/run.js` 直接跑。

### 设计取舍

- `estimateVideoBitrate(bytes, seconds)` 只吃字节数和时长，**不碰文件系统**——这样测试不需要造真实视频文件；文件读取的包装 `targetVideoBitrate(input, duration)` 留在 `main.js`。
- `findMediaArg(argv, deps)` 允许注入 `resolve` / `exists`，测试里不用真的建文件。
- 新增 `isMediaPath()` 替代原来散在 `doLoadVideo` 里的 `MEDIA_EXTENSIONS.includes(ext)` 手写判断。

### 刻意没做的

**没有**改动 `createMainWindow` / `createSurfaceWindow` / `applyVideoRect` / `startMpv` —— 这些必须真机验证，在没法跑 GUI 的环境里改它们是不负责任的。VideoSurface 接口抽象留到能实机调试的时候做。

### 社区文件

- `CONTRIBUTING.md`：明确"报 bug 必须附 `markplay.log` 的最后 100 行 + ffprobe 输出"，并给出开发环境搭建与提交前检查；
- `.github/ISSUE_TEMPLATE/bug_report.yml`：结构化表单（版本 / Windows 版本 / 复现步骤 / 日志 / 素材信息 / 相关环节）；
- `.github/ISSUE_TEMPLATE/feature_request.yml`：要求先描述场景而不是直接提方案；
- `.github/ISSUE_TEMPLATE/config.yml`：关闭空白 issue，使用问题引导到 Discussions；
- `.github/PULL_REQUEST_TEMPLATE.md`：带 `npm test` / `check:dom` 勾选项。

测试总数 **47 → 63**，语法 0 失败，DOM id 无缺失。

## 十七、v1.3.0：帧吸附与 Ctrl+S 备份

两个小改动，都带测试。

### 1. 帧吸附

**为什么**：帧是视频的最小时间单位。原来拖动刻度/区间边界得到的是连续浮点时间，会落在两帧之间——
导出的帧号要四舍五入，`-c copy` 剪辑的切点也对不上，用户看到的"00:00:10.017"其实不是一个真实存在的帧。

**怎么做**：`markers.js` 里加 `snapToFrame(t)`：

```js
var fps = frameRate();                     // 从 renderer 注入的 state.fps
if (!(fps > 0)) return v;                  // 帧率未知 → 不吸附
return Math.round(v * fps) / fps;
```

应用于三处：`add()`（打点）、`setTime()`（拖标记刻度）、`setRangeBoundary()`（拖区间两端）。

**边界取整的坑**：区间有最小宽度（原先固定 0.05s）。如果先夹紧再吸附，吸附可能把入点又推到出点之外。
所以 `setRangeBoundary` 改成：先吸附 → 夹最小间隔 → **再向安全方向取整**（入点 `floor`、出点 `ceil`），
并保证取整后仍不越界、不反向。最小间隔也改成 `max(0.05, 一帧)`，24fps 下一帧 0.0417s，比 0.05 还短。

**开关**：`config.SNAP_TO_FRAME = false` 可关闭；帧率未知（还没开始播放）时自动不吸附。

### 2. Ctrl+S 备份标记文件

**为什么**：sidecar 只有一份，误删标记、写坏文件、或者"想回到十分钟前的状态"都没有退路。

**怎么做**：
- 菜单「文件 → 备份标记文件」带 `CmdOrCtrl+S` 加速键——**放在菜单而不是渲染进程 keydown**，因为菜单加速键在输入框聚焦时也生效（输入框里按 Ctrl+S 同样能备份）。
- 菜单点击发 `player-event {type:'backup-sidecar'}`，渲染进程收到后**先 `saveSidecar()` 写盘，再调 IPC 复制**——顺序反了会备份到旧状态。
- 主进程 `backup-sidecar`：`copyFile` 到 `<sidecar>.bak-YYYYMMDD-HHmmss`，然后清理超出 `SIDECAR_BACKUP_KEEP`（默认 10）的旧备份。
- 清理只处理**同一 sidecar 的**备份（`isBackupOf` 前缀匹配 + basename 精确），不会误删同目录其它视频的备份或其它文件。
- 时间戳固定 `YYYYMMDD-HHmmss` 宽度，因此字符串排序 = 时间排序，不用解析日期。

### 测试

| 文件 | 覆盖 |
|---|---|
| `tests/sidecar-backup.test.js`（10 个） | 时间戳格式与固定宽度、路径生成、前缀匹配不误伤（`a.mp4` vs `aa.mp4`）、保留策略、不修改入参 |
| `tests/frame-snap.test.js`（11 个） | 30fps/23.976fps 吸附、帧率未知不吸附、关闭开关、边界夹紧后仍对齐帧、顶到末尾退帧网格、区间入点越界 |

总数 **63 → 84**，全过；语法 0 失败；DOM id 无缺失。

## 十八、v1.4.0：整段拖动区间 + 批量重命名

### 1. 整段拖动区间

之前区间条只能拖两端（改 in/out）。这次加的是**按住条体平移整段**——宽度守恒。

`markers.js` 新增 `moveRangeTo(id, newIn)`：

```js
var width = r.out - r.in;
var maxIn = Math.max(0, limit - width);
var inT = snapToFrame(clamp(newIn, 0, maxIn));
r.in = inT;
r.out = inT + width;      // 宽度直接加上去，不重新夹
```

**为什么不用 setRangeBoundary 连调两次**：那个函数每次都会重新夹最小间隔（`max(0.05, 一帧)`）。
平移时两端同向移动、间隔本来就守恒，走一遍夹紧逻辑反而可能把区间压窄一帧。

**和手柄的冲突**：手柄在 `pointerdown` 里已经 `stopPropagation`，条体的拖动处理还额外判断了
`e.target.classList.contains('range-handle')` 做双保险——否则拖手柄会同时触发整段平移。

**单击 vs 拖动**：位移 <4px 仍按单击处理（跳到入点），和标记刻度的行为保持一致，避免手抖误移。

### 2. 批量重命名

Electron 没有 `prompt`，所以这里又是一个内联表单（和标记重命名、区间改名同一个套路）：

| 字段 | 作用 |
|---|---|
| 范围 | 全部 / 仅 A…G |
| 前缀 / 后缀 | 可空 |
| 重新编号 | 勾选后名称 = 前缀 + 类型字母 + 序号 + 后缀 |

**编号规则上的一个决定**：一开始我用两位补零（`A01`），但 `add()` 生成的是不补零的 `A1`。
同一份文件里出现两套命名会很别扭，而且重编号后新打的点会变成 `A4`，视觉上像 bug。
所以改成**不补零**，与 `add()` 统一。代价是按名称排序时 `A10` 会排在 `A2` 前面——但列表按时间排序，
导出的 CSV 也有独立的 `index` 列，实际不受影响。

**序号按类型内部编**：如果全局按时间编号会得到 `A1 B2 C3` 这种混排，因此改成每类型内部各自 1..n。
重编号后会把 `counters` 推到最大序号，后续打点接着编，不会重号。

**撤销语义**：整批算一个撤销点（和"相邻配对生成区间"一致）。如果一条都没实际变化（例如范围内没有标记、
或名称本来就一样），会 `undoStack.pop()` 撤掉刚压的撤销点，不留下"撤销了但什么都没变"的空操作。

### 测试

`tests/batch-and-move.test.js` 共 21 个用例：

- 平移：宽度守恒、前后夹取到边界、帧吸附、`render:false`、非法输入、可撤销
- 名称拼装：前后缀、重新编号、序号非法兜底、40 字符截断、空选项
- 批量改名：全部/限定类型、按类型内时间顺序编号、计数器推进、空操作不留撤销点、可撤销、非法 scope、无视频

总数 **84 → 105**，全过；DOM id 61 个引用无缺失；语法 0 失败。

## 十九、v1.5.0：转场提示浮标

需求是"智能识别画面转场的时间点，在时间轴上用气泡标识，**只提示、不打点**"。所以这条功能刻意不碰 `items`——它不产生标记、不写 sidecar。

### 识别怎么做

用 ffmpeg 内置的 scene 分数，一行 filter 就够：

```
-filter:v "select='gt(scene\,0.4)',showinfo" -f null -
```

`select` 只放行"与上一帧差异超过阈值"的帧，`showinfo` 把它们的 `pts_time` 打到 stderr。
`parseShowinfoTimes()` 从 stderr 里抠出时间。

**转义坑**：逗号是 filtergraph 的参数分隔符，`gt(scene,0.4)` 里的逗号必须写成 `\,`，
否则 ffmpeg 会把 `0.4)` 当成新的一层滤镜名。JS 字符串里要写 `\\,`。

**实测**（用合成素材，三段不同图案硬切在 3s / 6s）：

```
detected: 3, 6
解析出的转场: [3,6]
```

顺带发现一个坑：三段**纯色**拼接时只识别出 1 处——纯色的 scene 分数不敏感，
所以真实素材（有纹理、有运动）才可靠。提醒用户"没识别到"是正常结果，不是 bug，状态栏也这么写。

### 流式解析

ffmpeg 的 stderr 是按块来的，一次 `data` 可能只到半行。主进程的做法：

```js
buffer += chunk;
const lines = buffer.split('\n');
buffer = lines.pop() || '';   // 最后一段可能是半行，留到下次
```

测试里专门覆盖了这个契约：**半行不产生数据**（`parseShowinfoTimes` 只认完整的 showinfo 行），
按 `\n` 边界切开的流式喂入能拼出完整结果。

### 抽稀

一部长片可能识别出上千处转场，全画出来会糊成一条。`scenes.js` 的 `thin()` 按**屏幕像素间距**抽稀：

```js
var px = ((t - s) / span) * width;      // 该点在时间轴上的像素位置
if (px - lastPx < gap) continue;        // 离上一个保留点太近就跳过
```

注意这里是"离上一个**保留**点"而不是"上一个点"——所以 `[10, 10.5, 11]` 在 8px 阈值下
会保留 `10` 和 `11`（10.5 被跳过后，11 距 10 够远了）。这是刻意的：宁可保留稀疏的边缘点，
也不要出现"前面全砍光"的观感。测试里把这条行为固定下来了。

因为抽稀依赖像素宽度，**缩放和窗口 resize 都要重算**——`renderScenes()` 挂在
`refreshTimelineView()` 和 `window.resize` 上。

### 交互与状态

| 状态 | 按钮 | 行为 |
|---|---|---|
| 未识别 | 转场 | 点击开始识别 |
| 识别中 | 识别中（脉冲动画） | 点击取消（杀进程，发 `scene-cancelled`） |
| 已识别·显示 | 转场 N | 点击隐藏 |
| 已识别·隐藏 | 转场 | 点击显示（不重扫） |

- 浮标：11×9px 圆角块 + 下方小尾巴指向时间点，hover 放大并显示 `转场 @ 00:01:23.400`
- 点击浮标 = 跳转（`seekTo`），**不选中、不创建标记**
- `Shift+←/→` 跳到上/下一个转场（仅在显示浮标时生效）；没有更远的点时状态栏提示而不是死循环
- 换视频：清空 `state.scenes`、杀正在跑的识别、作废主进程缓存

### 主进程侧的防护

- 同一时间只允许一个识别进程（`sceneProcess` 非空时返回"正在识别中"）；
- 结果按 `currentVideoPath` 缓存，重复点击不重扫；
- 换片 / 退出时 `killChild(sceneProcess)`，避免孤儿 ffmpeg 一直读盘；
- `parseShowinfoTimes` 有 `SCENE_MAX = 5000` 上限，防止极端素材（每个镜头 1 帧）把内存撑爆。

### 测试

- `tests/scene-parse.test.js`（9 个）：真实 showinfo 行格式、乱序小数、去重、忽略非 showinfo 行与负值、
  空输入、max 上限、按行流式合并、半行不解析、毫秒精度
- `tests/scenes.test.js`（10 个）：全保留、过密跳过、窗口过滤、缩放后结果不同、自定义间距、
  非法输入、前后跳转、边界返回 null、原地不跳

总数 **105 → 124**，全过；DOM id 63 个引用无缺失；语法 0 失败。

## 二十、v1.6.0：转场识别改为"扫一次、阈值随时调"

### 真机反馈暴露的问题

用户用 37 分钟、1080p 的行车记录仪街拍测试：

- 扫描耗时 **2–3 分钟**
- 结果 **"没有识别到转场"**

两个问题叠在一起，把一个"能用的功能"变成"没法用的功能"：
阈值固定 0.4，而连续运动的素材帧间差异普遍很小；更要命的是**调阈值 = 重扫 = 再等两三分钟**，
用户根本没有尝试的成本空间。

### 改法：把阈值从 ffmpeg 搬到渲染进程

旧实现让 ffmpeg 用 `select='gt(scene,0.4)'` 只放行超阈值的帧，所以阈值一变就得重扫。

新实现让 ffmpeg **全放行**，把每帧的分数都打出来：

```
-filter:v "select='gte(scene\,0)',metadata=print:file=-"
```

输出走 stdout，两行一组：

```
frame:75    pts:38400    pts_time:3
lavfi.scene_score=0.718990
```

`parseSceneScores()` 收成 `[{t, score}]`，之后阈值过滤在渲染进程做：

```js
function visibleSceneTimes() {
  return Scenes.filterByThreshold(state.scenes, state.threshold);
}
```

拖滑块就是一次数组过滤 + 重画浮标，**毫秒级**。ffmpeg 只跑一次。

### 流式解析的配对坑

一个分数由两行组成，而 stdout 按块到达，可能正好断在两行之间。
如果只按行缓冲，会出现"时间行已解析、分数行还没到"的状况，那一条就丢了。

处理方式是：**若最后一条完整行是 `pts_time` 行，把它留到下一块**：

```js
let carry = '';
if (lines.length && lines[lines.length - 1].indexOf('pts_time:') !== -1) {
  carry = lines.pop();
}
// ...解析剩余行...
if (carry) buffer = carry + '\n' + buffer;
```

### 收集下限与内存

`select='gte(scene,0)'` 会放行全部帧，但 `parseSceneScores` 有 `SCENE_SCORE_FLOOR = 0.01`：
低于它的帧不占内存。代价是滑块最低只能调到 0.02 —— 再低就需要重新扫描，面板上的
"重新扫描"按钮就是为这个场景准备的。

上限 `SCENE_MAX = 100000` 帧，防止极端素材撑爆内存。

### 零命中自动降档

扫描完如果当前阈值一处都没命中，`afterSceneDetected()` 会：

```js
var suggested = Scenes.suggestThreshold(state.scenes, 8);  // 第 8 高的分数
state.threshold = clamp(suggested, 0.02, 0.9);
```

`suggestThreshold` 取"分数降序第 N 个"，正好等于"让 N 个点通过的最低阈值"。
状态栏会说明"阈值 0.40 一处都没命中，已自动降到 0.18（命中 12 处）"，
用户不需要理解 scene 分数是什么，也能立刻看到结果。

### UI

灵敏度面板浮在控制条上方（`position:absolute` + `#controlbar { position: relative }`），
不挤压原有布局。内容：滑块 + 当前数值 + "收集 N 帧，命中 M 处" + 重新扫描 / 关闭。

零命中时那行提示会变青色（`.hint.set`）并写"往左拖降低灵敏度门槛"。

### 实测

用合成素材（3 段不同图案硬切在 3s / 6s）跑真实命令：

```
收集帧数: 4
阈值 0.90 -> 命中 0 处
阈值 0.70 -> 命中 2 处 [3,6]
阈值 0.40 -> 命中 2 处 [3,6]
建议阈值(要8个): null      // 样本只有 4 帧，不够 8 个
```

0.90 的零命中复现了用户遇到的场景，降到 0.70 立刻出结果 —— 正是这次改动要达到的效果。

### 测试

总数 **125 → 132**：

- `scene-parse.test.js` 重写为 `parseSceneScores` 的 10 个用例（块解析、floor 丢弃、max 上限、
  缺时间行忽略、负时间忽略、空输入、毫秒精度、分段合并、顺序颠倒不配对）
- `scenes.test.js` 增补 `filterByThreshold`（4 个）与 `suggestThreshold`（3 个），
  含一条自洽性断言：建议阈值下必须真的能命中足够数量


## 二十一、代码签名工具链（v1.6.0 后）

### 现实前提

代码签名需要**花钱 + 实名认证**的证书，这一步代办不了。所以这一轮的目标不是"签出一个免警告的包"，
而是**把除证书之外的一切都验证到位**，让拿到证书后只需要换一个路径。

### 先解决"没有 Windows SDK 也能签"

本机 `signtool.exe` 不在 PATH，也没有 Windows Kits。但 electron-builder 下载的
`winCodeSign` 缓存里就带着：

```
%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\windows-10\x64\signtool.exe
```

`tools\sign.ps1` 的查找顺序正是：这个缓存 → Windows Kits → PATH。
所以**只要跑过一次 `npm run dist`，签名工具就绪**，不用额外装 SDK。

### 用自签名证书把链路跑通

```powershell
.\tools\make-test-cert.ps1        # New-SelfSignedCertificate，Code Signing EKU，RSA 3072
.\tools\sign.ps1 -File <某个 exe> -Thumbprint <指纹>
```

实测结果：

| 环节 | 结果 |
|---|---|
| signtool 定位 | ✅ 走缓存，未装 SDK |
| `/f pfx /p pass` 签名 | ✅ 退出码 0 |
| `/sha1 thumbprint` 签名 | ✅ 退出码 0 |
| RFC3161 时间戳 | ✅ `CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1` |
| `Get-AuthenticodeSignature` | `Status=UnknownError`，`SignerCertificate.Subject` 正确，`TimeStamperCertificate` 非空 |
| `signtool verify /pa` | 唯一的错是 `root certificate which is not trusted` |

最后那条**正是自签名应该有的结果**——它证明签名结构与证书链都正确，只是根不在信任列表里。
换成 CA 签发的证书后，这一条就会变成 `Status = Valid`。

### 脚本的一个设计点

`sign.ps1` 不是"签完就完事"，它会立刻读 `Get-AuthenticodeSignature` 并**按状态给不同结论**：

- `Valid` → 打勾，顺带打印 SHA256
- `UnknownError` + "不受信任" → 分两种情况说话：自签名属预期；买了证书还这样就列三条排查方向
  （EKU 不是 Code Signing / 中间证书缺失 / 买成了 SSL 证书）
- `NotSigned` → 直接 `exit 1`，不谎报成功

排障提示写进脚本而不是文档，是因为出问题的人那一刻不会去翻 docs。

### 时间戳为什么必须开

`package.json` 里加了：

```json
"signingHashAlgorithms": ["sha256"],
"rfc3161TimeStampServer": "http://timestamp.digicert.com"
```

没有时间戳的签名在证书过期那一刻全部失效——已经发出去的安装包会突然变成"签名无效"。
这是很多人第一次签名时会漏掉的一项。

### 证书选型（写进 docs/RELEASE.md 第 2 节）

| 方案 | 成本 | 适合 |
|---|---|---|
| OV | $200–400/年 | 个人项目，性价比最高 |
| EV | $300–600/年 + 硬件令牌 | 想第一次下载就少警告 |
| Azure Trusted Signing | 按次计费 | 没有令牌、走 CI |
| 自签名 | 免费 | **仅本机验证**，对外发布无意义 |

同时写清了一件容易被误解的事：**签名不等于立刻没有 SmartScreen 警告**，
OV 要积累下载量，EV 才历史性地更快。这不是配置问题。

### 测试证书的处理

`tools\make-test-cert.ps1 -Remove` 可以一键清掉。
本轮验证完已经把证书删了，仓库里不留任何密钥材料，`%TEMP%` 下的 PFX 也一并删除。

### 剩下真的只有一件事

买证书 → 设两个环境变量 → `npm run dist`。命令一行都不用改。

## 二十三、中英双语界面（v1.8.0）

### 为什么不用 i18n 库

需求是"两种语言、即时切换"。i18next 之类会带来：运行时依赖（项目至今零依赖）、
打包体积、以及一套没人看得懂的插件链。而这里真正需要的只有三件事：点号路径取词、
`{name}` 插值、缺词回退。`src/i18n.js` 一共 70 行就够。

### 结构

```
src/i18n.js                  # 语言归一 + lookup + interpolate + createTranslator（主/渲染共用）
src/locales/zh-CN.js         # 纯数据字典
src/locales/en-US.js
src/renderer/i18n-apply.js   # 把字典刷进 DOM
```

字典键用点号路径分组（`menu.*` / `status.*` / `ui.*` / `errors.*`），
两个文件的结构必须完全一致——`tests/i18n.test.js` 就是断言这件事。

### 首帧不闪的关键

常见做法是页面加载后再 `fetch` 语言、再替换文案，会看到"中文闪一下变英文"。
这里用 **preload 同步 IPC** 解决：

```js
const injected = ipcRenderer.sendSync('get-language');  // 主进程直接 returnValue
```

preload 在页面脚本之前执行，所以 `index.html` 里 `data-i18n` 的兜底文本
在第一次 `applyI18n()` 时就已经是正确语言，用户看不到切换过程。

### 不重载窗口

`language-changed` 事件到达渲染进程后：

1. `I18n.setLanguage()` 换掉 preload 里的翻译函数；
2. `applyI18n()` 重刷所有带 `data-i18n` 标注的节点；
3. `onLanguageChange` 回调里重绘 JS 生成的内容（标记列表、区间列表、fps 标签、
   转场浮标、按钮状态）。

正在播的视频、已打的标记、剪辑进度全部保留——重载页面会丢掉 mpv 连接，代价太大。

### 三个容易漏的地方

1. **`<html lang>`** 要跟着变，否则系统字体回退和屏幕阅读器都会用错语言；
2. **`document.title`** 也要变（`<title data-i18n="app.name">`）；
3. **测试沙盒**：markers.js / export.js 现在调用 `I18n.t()`，`node:vm` 里没有这个全局
   就会崩。`tests/helpers.js` 改为先加载 `i18n-apply.js` 并注入真实的 `window.markplay.t`，
   所以单元测试里跑的是真字典，而不是 mock。

### 覆盖范围

不是"只翻界面标签"，而是**全部用户可见文案**：

- 菜单、对话框标题与正文、快捷键说明表
- 侧栏、状态栏、toast（含按钮里的"在文件夹中显示"）
- 主进程抛给渲染进程的每一条错误（`errors.*`）
- 默认区间命名（`区间 3` / `Range 3`）——这条最容易漏，因为它是代码里拼出来的
- 转场识别的所有状态文案

用脚本扫过一遍：`src/main.js` 与所有渲染模块里，引号内含中文的字符串已清零
（只剩 mpv 配置文件注释和语言菜单自身的"中文"标签，那是刻意保留的）。

### 校验脚本

写代码时用三个一次性脚本（`.patch/` 下，已删）做批量替换与校验，
最终沉淀为常驻的两个：

- `npm test` 里的 `i18n.test.js`：键集合一致、占位符一致、无空值、语言归一、缺词回退
- `check-dom` 顺带校验 `index.html` 的 `data-i18n` 引用都能取到词

255 个引用键、0 缺失。

## 二十四、文件列表（v1.9.0）

### 需求拆解与一个硬约束

需求本身不复杂：批量打开、列表默认隐藏、菜单/图标唤出、可单独关闭、全屏时右缘悬停自动弹出。
真正决定实现方式的是这条约束：

**全屏播放时，视频是 mpv 的原生子窗口，会盖住主窗口的 HTML。**

这和我们之前回滚掉的悬浮控制条是同一堵墙：主窗口里的任何绝对定位元素，在全屏下都看不见。
所以文件列表**必须是一个独立窗口**，没有第二种做法（除非改整个全屏实现，风险太大）。

好在这条需求本身不像悬浮控制条那样"永远贴在画面上"——它默认隐藏、只在被召唤时出现，
所以独立窗口带来的观感问题（层叠、焦点、错位）在这里可以接受。

### 位置策略

| 模式 | 位置 | 理由 |
|---|---|---|
| 全屏 | 贴屏幕右缘、整屏高 | 需求明确要求右缘悬停 |
| 窗口模式 | 贴**视频区**右缘 | 不遮住标记侧栏；侧栏是干活的区域，列表是挑片的 |
| 没加载视频 | 贴主窗口客户区右缘 | 兜底 |

侧栏起点正好等于列表右缘，实测 x=758 + 322 = 1080，不重叠。

### 全屏悬停的两个判定

需求里"鼠标靠近最右侧"和"鼠标离开右侧"是两个方向不同的判定，分开写：

- **弹出**：光标进入右缘 26px 的竖条（`screen.getCursorScreenPoint()`）→ `hitRightEdge()`
- **收起**：光标离开列表窗口矩形 + 16px 外扩 → `insideList()`

为什么不用同一个阈值：只看"是否还在右缘 26px"的话，用户一往里走想去点列表，
列表立刻收起，根本点不到。用"是否还在列表矩形内"作为停留判定才符合直觉。

热区宽度取 26px：太小（<10）用户很难对准，尤其触控板；太大（>60）会误触。

### 轮询而不是事件

全屏时鼠标事件都落在 mpv 的原生窗口上，主窗口渲染进程收不到 `mousemove`。
所以只能在主进程用 120ms 轮询光标位置。开销可以忽略（一次系统调用）。

### 一个容易被忽略的细节：选文件期间不能收

打开系统文件对话框时，光标自然不在右缘。如果不停掉自动隐藏，用户一打开对话框列表就没了。
所以用 `playlistDialogOpen` 标志在对话框期间挂起整个判定逻辑。

### 可测性

窗口显隐写错了，表现出来就是"列表死活不出来"或"出来了收不回去"，靠肉眼非常难查。
所以把纯逻辑抽进了 `src/playlist-model.js`：

- `dedupePaths` / `buildItems` / `indexOfPath` / `noteCurrent` —— 列表数据
- `hitRightEdge` / `insideList` —— 两个悬停判定
- `computeBounds` —— 三种模式下的窗口定位

`tests/playlist-model.test.js` 25 个用例，包括多显示器负坐标、热区边界、外扩容差、
视频区比列表还窄的退化情况。main.js 里不再有第二份实现。

### 顺手补的一个真 bug

写完之后做静态审计（`PlaylistModel.*` 的用法、IPC 通道双向核对、preload 暴露 vs 调用），
发现 `isMediaPath` 在 main.js 里被调用了三次但**没有导入**——多选打开时会直接
`ReferenceError`。这类错误 `node --check` 抓不到，只能靠交叉核对标识符。

## 二十五、续播记忆点（v1.10.0）

### 存哪儿：settings.json 而不是 sidecar

最直觉的做法是把播放进度写进视频旁边的 `.markplay.json`（sidecar）。
但那条路有三个问题：

1. sidecar 是**用户数据**（标记 + 区间），写进"看到第几秒"会污染它；
2. sidecar 每次改动都触发落盘，播放时每 5 秒写一次太吵；
3. 用户可能只想分享标记文件，不该带上播放进度。

所以放 `settings.json`，独立字段 `resumePoints`，按**小写绝对路径**为键。
代价是文件改名/移动后记忆点失联——但播放进度本来就是易失信息，可以接受。

### 三条写入时机

| 时机 | 为什么 |
|---|---|
| 每 5 秒（time-pos 节流） | 崩溃/断电也不会丢太多 |
| 按暂停 | "我就看到这里"是最真实的意图，立刻记 |
| 切视频 / 退出应用前 | 换片和退出是最常见的收尾动作 |

### 什么时候**不**续播

两条规则，缺一不可：

- 位置 < 8 秒：刚打开就关掉，没必要跳；
- 位置 ≥ 总长 − 5 秒：已经看完了，下次应该从头看。

第二条尤其重要。没有它，凡是看到片尾关掉的视频，下次打开会停在最后一秒，
用户会以为播放器坏了。写入时也会把这种"已看完"的记录删掉。

### 一个真实的时序坑

`loadfile` 之后立刻 `set time-pos` 有时会被 mpv 忽略——它还没解析出时长。
所以渲染进程不是拿到 `resumeAt` 就跳，而是：

1. 如果 `state.duration` 已知，直接跳；
2. 否则订阅 `mpv-duration` 事件，等到时长就跳；
3. 再兜一个 1.3 秒超时（有些流没有 duration）。

### 退出全屏按钮

放在文件列表窗口的标题栏，只在全屏时显示。技术上有两个小坑：

1. **`display:flex` 会盖掉 `hidden`**。`.head-btn` 是 flex 布局，`hidden` 属性
   被 CSS 的 display 覆盖，按钮会一直显示。必须显式写 `.head-btn[hidden] { display: none; }`。
2. **全屏状态要主动推**。列表窗口只在收到 `playlist-data` 时更新，所以
   `toggleFullscreen` / `exitFullscreen` 里各加了一次 `emitPlaylist()`，
   把 payload 里的 `fullscreen` 标志同步过去。

### 可测性

记忆点逻辑全在 `src/resume.js`，纯函数、无 Electron 依赖：

- `putEntry` / `getEntry` / `resumeAt` / `clearEntry`
- `normalizeMap`（读取时清洗 + 按时间淘汰）
- `normalizeEntry` / `pathKey`

`tests/resume.test.js` 21 个用例覆盖：大小写、边界值（正好 8 秒、正好结尾）、
上限淘汰顺序、坏数据（`t: 'bad'`、`null`、空键）、以及三个完整流程
（看到一半 / 看完 / 选择从头开始）。

端到端还额外用**真实的 `SettingsStore`** 走了一遍落盘 → 重新加载 → 读回，
确认不是只在内存里对。

### 续播的一个真实 bug（v1.10.1）

上线后被指出："播到结尾 → 再开 → 无法从头播"。

根因是**语句顺序**，不是判定逻辑：

```js
// doLoadVideo（错误顺序）
currentDuration = 0;      // ← 先把时长清了
...
flushResumePoint();       // ← 再存档，于是存的是 (旧位置, 时长=0)
```

而 `putEntry` 的"已到结尾就不记"依赖时长：

```js
if (total > 0 && pos >= total - 3) { delete map[key]; return false; }
```

时长是 0 → 整条判定跳过 → 片尾位置（599/600）被原样存下。
`resumeAt` 同理：`if (e.dur > 0 && ...)` 也跳过 → 返回 599 →
下次打开直接停在最后一秒。

三层修法，故意做了冗余：

1. **顺序**：`flushResumePoint()` 移到 `loadfile` 之前，用真实时长存档；
2. **模块不依赖调用方**：时长未知时改用该视频**已有记录**的时长做判定
   （播放中每 5 秒都存过带时长的记录，所以一定有）；
3. **语义兜底**：EOF 时（`end-file` + reason=eof）直接清掉记忆点，
   并置 `videoFinished`，之后不再写入直到载入新视频——
   这条把"看完了"从"位置推断"变成"事件确认"，不再依赖秒数比较。

另外把两个容差分开：写入容差 3 秒、续播容差 15 秒。
理由是"最后记到的位置"可能比真实结尾早几秒（节流 + 事件粒度），
续播判定留更宽的余量才不会误跳。

教训：这类 bug 单测抓不到，因为每个函数单独看都是对的——
错的是**调用顺序**。所以给 `resume.js` 加了不依赖入参的防御，
用 4 个回归用例钉住（含"时长未知 + 有历史记录"这一组合）。

### 续播语义的二次修正（v1.10.2）

v1.10.1 里我用"距结尾 3 秒 / 15 秒"的容差来推断"看完了"。用户实测后指出：
**停在片尾前 10 秒关掉，也应该从那里继续**，而不是从头播。

这条意见是对的。用秒数猜"看完"本质上是启发式，而"看完"其实有明确的事件——
mpv 播到文件末尾会发 `end-file`（reason=eof），而项目用的是 `--keep-open=no`，
播完就卸载文件，这个事件一定会到。

所以把启发式整个删掉：

| | v1.10.1 | v1.10.2 |
|---|---|---|
| 写入 | 距结尾 3 秒内删除记录 | 一律记录 |
| 续播 | 距结尾 15 秒内不续播 | 只检查下限 8 秒 |
| 清除 | 位置推断 + EOF 双保险 | **只有 EOF 与"从头开始"** |

现在"看完"由事件确认，不再靠猜。附带一个自愈性质：停在 598/600 关掉后，
下次会续播到 598，播完立刻触发 EOF 清记录，再下次就是从 0 ——
即便用户在极接近结尾处退出，最多多播两秒，不会一直卡在片尾。

教训：能用事件表达的状态，就不要用数值推断。启发式只应该在拿不到事件时兜底，
而这里事件是可靠的，启发式反而制造了错误行为。

## 二十六、列表手动编辑（v1.11.0）

### 两个按钮，一条原则

需求只有一句话：每条后面加 ✕ 让它从列表消失（不删文件），顶部加 ＋ 让用户自己加条目。

关键在于主进程和列表窗口的职责划分——**列表数据归主进程所有**，
列表窗口只负责画和上报意图，所以两个操作都是 IPC 之后由主进程改数据、再推回全量列表。
这样两个窗口的视图永远不会分叉（主窗口的文件列表状态、列表窗口的渲染、当前高亮，
都来自同一份 `playlistItems` + `playlistIndex`）。

### 移除当前正在播放的那一条

这是唯一需要想清楚的边界。三种做法：

1. 停掉播放 —— 过度反应，用户只是不想在列表里看到它；
2. 拒绝移除 —— 别扭；
3. **保留播放，只把下标置 -1** —— 选的这个。

下标 -1 表示"当前播放的不在列表里"，界面就没有高亮项。
播放本身完全不受影响，因为 mpv 播放的是文件路径，跟列表没关系。

顺带处理了"删掉前面的项"：后面的下标要整体前移，否则高亮会跳到相邻的错项上。
这段逻辑放进 `playlist-model.removeAt()` 并用单测钉住。

### 一个顺手修的体验问题

原来的三个"打开视频"入口（Ctrl+O、菜单、拖入多个）都是**替换**列表。
在只有"批量打开"的年代这是合理的；但有了 ＋ 之后就很怪：
用 ＋ 攒好十来个视频，再按 Ctrl+O 打开一个，列表直接被清空。

所以统一改成**追加**：打开=加入列表并播放，＋=只加入不播放。
两者的差别只剩"要不要立刻播"，语义就清楚了。
（顺带删掉了因此变成死代码的 `setPlaylistPaths`。）

### 细节

- ✕ 上挂了 `stopPropagation`，避免点击冒泡到条目触发"打开视频"；
  也拦了 `dblclick`，否则双击 ✕ 会命中条目的"双击打开并关闭列表"。
- ✕ 平时 `opacity: 0`，悬停到该条目才显现 —— 否则列表看起来会很吵。
- 空列表时仍渲染 ＋（不然没有入口），但不渲染任何 ✕。
- `playlist-add` 也设置 `playlistDialogOpen`，全屏时选文件期间列表不会被自动收起。

## 二十七、列表"消失"的排查（v1.11.1）

### 现象

窗口模式下点列表条目里的 ✕，整个列表窗口不见了；全屏模式正常。

### 排查：先做最小复现，而不是猜

第一反应是"某处调了 hide"。读代码只有三个 hide 入口（按钮/快捷键、全屏悬浮检测、
列表自己请求关闭），都不该在这条路径上触发。继续读下去不会更有结论，于是搭了个
最小 Electron 工程：

- 用**真实的** `src/playlist/index.html` / `playlist.js` / `preload.js`；
- 在 main 里伪造 `playlist-data` / `playlist-remove` 等 IPC；
- `win.webContents.executeJavaScript(...)` 模拟点击第 2 条的 ✕；
- 打印 `isVisible()`、窗口事件、DOM 行数、面板 `opacity`、`document.scrollTop`。

结果：

```
初始 isVisible = true
IPC: playlist-remove 1
  -> 剩余 2 项，当前下标 -1
点击后 isVisible = true      ← 没有被隐藏
DOM 行数 = 2                 ← 内容正常
panel 类名 = panel in
panel 计算透明度 = 1
事件序列里出现过 hide 吗: false
```

**窗口没被隐藏、内容也正常。** 那用户看到的"消失"只能是**被盖住**。

### 结论：透明窗口被 mpv 的原生子窗口压到下面

列表是一个 `transparent: true` 的独立窗口，DOM 重绘之后，
z-order 会被 mpv 渲染所在的**原生子窗口**（视频画面）盖住。

这解释了为什么只有点 ✕ 会触发：点条目那条路径里有 `mainWindow.focus()`，
而 Windows 在聚焦主窗口时会连带把它拥有的子窗口一起抬起来；
点 ✕ 只是重绘，没有任何"抬高"动作。

### 修法

- `emitPlaylist()` 每次推数据后调 `raisePlaylist()`（`moveTop()` 不抢焦点），
  并在 60ms 后再抬一次——重绘是异步的，第二次能覆盖重绘窗口期；
- 移除条目这条路径原本完全没有任何抬高动作，额外再抬一次；
- 兜底自愈：如果窗口真的被 `hide` 了（而不是被盖住），自动重新显示并写告警；
- 诊断：`hidePlaylist(reason)` 记录原因 + 调用栈，`playlistWindow` 的
  `hide/show/blur/focus` 全部写日志。

### 顺手加固的三处

1. 全屏悬浮检测加了"真·全屏"校验（`surfaceWindow.isFullScreen()`）：
   状态过期时立刻停表并复位标志，避免窗口模式下按全屏规则误收列表。
2. `.panel` 由 `absolute` 改 `fixed`：`absolute` 相对初始包含块，文档一旦被滚动，
   面板会被整体顶出视野——那也是"消失"的一种。
3. 当前项滚动改为手算 `listEl.scrollTop`，不用 `scrollIntoView`：
   后者会一路找"最近的可滚动祖先"，可能连带滚动文档。

### 教训

这次差点凭直觉改 hide 逻辑，而真正的成因根本不在 hide 上。
**先把"窗口是否真的不可见"测出来**，一步就把排查范围砍掉一半。
最小复现工程只花了十几分钟，却省掉了后面所有猜测。

### 一次自己造的回归（v1.11.1 → v1.11.2）

v1.11.1 修"点 ✕ 后列表消失"时，我顺手加了个"真·全屏"校验，
想在标志过期时把光标轮询表停掉：

```js
if (!surfaceWindow.isFullScreen()) {
  isSurfaceFullscreen = false;
  stopPlaylistWatch();
  return;
}
```

结果全屏下的右侧悬停弹出彻底失效。

**坑在哪**：这个项目的全屏有降级路径——

```js
try { surfaceWindow.setFullScreen(true); }
catch { /* ... */ }
// 150ms 后如果仍不是全屏，就直接铺满显示器
setTimeout(() => {
  if (isSurfaceFullscreen && !surfaceWindow.isFullScreen()) {
    surfaceWindow.setBounds(display.bounds);
  }
}, 150);
```

也就是说"铺满式全屏"是**设计内的正常状态**，而它恰恰会让 `isFullScreen()` 返回 `false`。
我把一个合法的实现细节当成了异常。

更糟的是它还会改写 `isSurfaceFullscreen = false`，
那样之后按 F11/ESC 的判定也会错乱——一个防御动作同时破坏了两处状态。

**修法**：全屏状态只认自己的标志，`isFullScreen()` 降级为纯诊断日志。
另外把这条规则写成了 `tests/playlist-watch.test.js` 里的源码断言：

- 进入/退出全屏要起停轮询表；
- watch 体内**不得**给 `isSurfaceFullscreen` 赋值；
- **不得**依据 `isFullScreen()` 停表；
- 必须走 `PlaylistModel.hitRightEdge` / `insideList`；
- `hidePlaylist` 必须带 reason，`emitPlaylist` 必须抬高窗口。

### 教训

1. **防御性代码要有失败证据再写。** 我加那个校验时并没有观察到"标志过期"的实际故障，
   纯粹是想象出来的风险——结果用真实的故障换了想象中的风险。
2. **改写共享状态前想清楚谁在消费它。** `isSurfaceFullscreen` 不只给 watch 用，
   F11/ESC/布局都读它。
3. **无法单测的逻辑，用源码契约测试兜住。** 这段代码依赖 Electron 窗口状态，
   node:vm 测不了；但"不许这么写"是可以断言的，8 条断言成本很低。

## 二十八、全屏播放状态栏（v1.12.0）

### 为什么又是独立窗口

全屏时视频是 mpv 的原生子窗口，主窗口的 HTML 被完全盖住——和文件列表同一个约束。
所以状态栏只能是第四个窗口（主窗口 + 视频子窗口 + 列表 + 状态栏）。

### 怎么做到"内容与非全屏底部模块一致"

**样式直接复用**：状态栏页面 `<link rel="stylesheet" href="../renderer/styles.css">`，
`#controlbar` / `#timeline` / `.icon-btn` 等规则原样生效，我另加一个小 `controls.css`
只处理"这是覆盖在视频上的透明窗口"带来的差异（透明背景、圆角、从下滑入）。
复现里量到 `border-radius: 10px`、`height: 118px`，说明主样式确实吃上了。

**数据从主窗口来**：状态栏没有 `Markers`、`TimelineView`、`Exporter`，
标记刻度、区间条、转场浮标、视图范围、时间码格式这些东西它都算不出来。
所以由主窗口渲染进程打包快照推送：

```js
{ currentTime, duration, paused, volume, speedMode, looping, showScenes,
  scenes, markers, ranges, view: {start,end}, status }
```

显示期间每 400ms 推一次，隐藏就 `clearInterval` —— 平时零 IPC 开销。

**命令回主窗口执行**：状态栏的点击只发命令名，
主窗口落到已有的 `togglePlay` / `seekTo` / `toggleSpeed` / `toggleLoop` /
`toggleScenes` / `zoomStep` / `zoomFit` 上。没有第二套播放控制实现。

### 两个热区互不干扰

右侧（文件列表）和下边缘（状态栏）共用同一个轮询表，但各自独立判定：
`hitRightEdge` 决定列表，`hitBottomEdge` 决定状态栏，收起判定都用 `insideList`（矩形 + 外扩容差）。

v1.11.2 的教训还热着，所以这次没有在轮询表里加任何"聪明"的状态校验，
只在既有结构上追加一个独立分支。

### 复现抓到的一个真缺陷

用最小 Electron 工程加载真实的状态栏页面，推一份假快照，然后用
`executeJavaScript` 点按钮、派发 pointerdown 到时间轴，检查命令有没有发出来。

按钮命令全部正常，但 **`seek` 一条都没有**。原因是：

```js
timeline.setPointerCapture && timeline.setPointerCapture(e.pointerId);  // ← 这里抛
seekFromEvent(e);                                                       // ← 永远执行不到
```

合成事件没有真实 `pointerId`，`setPointerCapture` 抛 `InvalidPointerId`，
后面的 seek 被一起吞掉。真实鼠标点击时不会抛，所以肉眼测很可能发现不了。

改成先 seek 再抓指针，并给抓指针包 `try`：

```js
seekFromEvent(e);
try { if (timeline.setPointerCapture) timeline.setPointerCapture(e.pointerId); } catch {}
```

复现重跑后 `seek 150`（600 秒的 25%）正常发出。

### 测试

- `playlist-model.test.js` 增加 `hitBottomEdge` 的 6 个用例
  （含多显示器、与右侧热区交叉、边界值）
- 新增 `tests/controls-bar.test.js`：14 条源码契约断言，钉住
  "下边缘走模型函数""只在全屏出现""退出全屏必须收起""推快照后要抬高窗口"
  "创建在 registerIpc 之后""生命周期要销毁""preload 与主进程通道对齐"
  "快照字段齐全""先 seek 再抓指针""样式复用 styles.css""内容元素齐全"
- `check-dom` 扩到四页面（主窗口 / 列表 / 状态栏），翻译覆盖率纳入 `controls.js`


## 二十九、`.ts` 倒放不动（v1.12.1）

### 现象

MP4 一切正常，`.ts`（MPEG-TS）按 Z 或点右键"倒放"没反应。

### 先复现，再动手

倒放是"暂停 + 反复往回 seek"模拟的，步长固定 0.2 秒。第一版测试脚本没加
`--pause`，而 `--vo=null` 会全速解码，读数被污染（看到位置一路往前跑）。
改成**加载即暂停**再测，才拿到干净数据：

| 素材 | seek 到 10 落在 | 连续 6 次 -0.2s |
|---|---|---|
| MP4（start=0） | 10 | 9.8 → 9.6 → … → 8.8 ✅ |
| TS（start≈1.47） | **12** | **12 不动** ❌ |

又试了 `--hr-seek=yes`（启动参数与运行时 `set_property` 各一次）、`--hr-seek=always`、
绝对定位 `set time-pos`、`frame-back-step`——**全部无效**。

### 根因：TS 没有 seek 索引，只能按关键帧对齐

接着扫步长，答案很干脆（2 秒 GOP 的 TS）：

```
步长 0.2 / 1 / 2 秒  ->  12 -> 12 -> 12 -> 12 -> 12   （不动）
步长 3 / 4 秒        ->  10 -> 8 -> 6 -> 4 -> 2        （一次跳 2 秒）
```

**请求后退量小于关键帧间距时，mpv 把目标量化回同一个关键帧，等于没动。**
MP4 有索引，0.2 秒就是 0.2 秒，所以从来没暴露这个问题。

### 修法：让步长自适应

不去猜格式，而是**看结果**：每轮读一次位置，用"上一轮位置 − 本轮位置"衡量上一步
到底退动了没有。

- 没退动（< 步长的 40%）：步长翻倍，上限 4 秒；
- 退动了：保持步长，并按**实际位移**折算定时器间隔（`moved / 2 * 1000`），
  这样平均速度仍接近 2x；
- 连续失败到上限：明确告知"该文件不支持倒放"，而不是假装在工作。

MP4 上 `moved` 恒等于 0.2，所以永远停在 0.2 秒 / 100ms —— **行为与改动前逐位一致**，
并用单测钉住（"MP4：每步都恰好退回 0.2 秒 → 步长与间隔保持 0.2 / 100ms"）。

### 实测对照（真实 mpv + 真实模块）

```
MP4 + 旧逻辑   0.2s/100ms  退 60 步  正常
MP4 + 新逻辑   0.2s/100ms  退 60 步  与旧逻辑完全相同 ✅
TS  + 旧逻辑   0.2s/100ms  退 60 步  位移 0            ❌ 复现了用户报的 bug
TS  + 新逻辑   3.2s/1000ms         退到 0             ✅ 不再卡住
```

### 顺带修的提示

一开始按"步长"报粗粒度（"约 0.4 秒一跳"），但实测一跳其实是 2 秒——数字误导。
改成**等某一步真的跳了 ≥0.5 秒再报一次**，数字取实测位移。

### 教训

- 上一版测试脚本自己引入了污染（`--vo=null` 不暂停 = 全速解码），差点得出错误结论。
  测播放行为时，"是否暂停"必须显式控制。
- 通用逻辑一旦假设了"seek 是精确的"，遇到无索引容器就会静默失效。
  与其猜格式，不如**用实测反馈**来调整——这次的自适应就是这么来的，而且它在
  好格式上退化为原行为，风险很低。

## 三十、TS 倒放的不平滑，与"建立索引"（v1.13.0）

### 为什么自适应只能"能动"，不能"平滑"

v1.12.1 让步长自适应，解决了"完全不动"，但代价是 TS 上每步要跳一个 GOP（实测 2 秒）。
**这件事没法在播放器层面绕过**：视频帧就在那里，关键帧之间没有独立可解码的帧，
不重新解码就取不到中间画面。

我试过的那几条路都堵死（见上一节）：`--hr-seek=yes/always`、绝对定位、`frame-back-step`。
所以能"更平滑"的唯一办法，是让文件本身可精确 seek —— 也就是**给它建索引**。

### 转封装为什么能解决

MP4/MKV 的索引（`stss` / Cues）是容器层的元数据，把关键帧位置列出来。
TS 本身没有这个结构，但 `ffmpeg -c copy` 转封装时会**读一遍码流、写出 MP4 索引**，
画面数据原样搬运、不重新编码。

实测（2 秒 GOP 的 TS，真实 ffmpeg + 真实 mpv）：

```
源 TS      2191 KB   start=1.4667   倒放 0/6 步精确（全卡住）
转封装后    2007 KB   start=0.0000   倒放 6/6 步精确 0.2 秒
耗时 83 ms
```

注意 `start` 从 1.4667 变成 0：ffmpeg 顺带做了时间戳归零，这对 marker/时间码也更准。

### 实现上的几个决定

1. **输出名带 `.indexed`**：`trip.ts` → `trip.indexed.mp4`。
   不直接用 `trip.mp4` 是因为用户目录里可能已经有同名文件，覆盖是不可接受的；
   已存在时自动加序号（`-2`、`-3`…）。这条有单测。
2. **标记文件跟着走**：把 `trip.ts.markplay.json` 复制一份给 `trip.indexed.mp4.markplay.json`，
   否则切到新文件后标记全空。
3. **进度用 `-progress pipe:1`**：ffmpeg 的 stderr 是给人看的，`pipe:1` 才是机器可读的
   `out_time_ms=...`，换算成百分比显示。
4. **失败清理半成品**：转封装失败（磁盘满、权限、坏流）时删掉写了一半的 mp4，
   不留下"看起来能用但其实是半截"的文件。
5. **两处入口**：菜单「文件 → 为当前视频建立索引」，以及倒放退化提示里的「建立索引」按钮。
   后者是关键——用户是在"觉得卡"的那一刻才需要它，不该让他去翻菜单。

### 边界

- 只对已知无索引的扩展名（`ts/m2ts/mts/vob/mpg/flv…`）提供，对 mp4/mkv 会提示"已带索引"。
- ffmpeg 是独立进程，转封装期间可以继续播放，不阻塞界面。
- 会占用额外磁盘空间（约等于源文件大小），这一步没有自动清理，因为输出是用户可能会长期使用的文件。

### 测试

- `tests/remux.test.js` 14 个：扩展名判断、输出路径（含"不覆盖已有文件"）、
  `-c copy` 参数（断言不许出现编码器/`-crf`）、进度解析。
- `tests/remux-wiring.test.js` 11 条源码契约：IPC 注册、走纯逻辑模块、
  并发保护、sidecar 复制、失败清理、菜单禁用条件、preload 通道、四类事件处理、
  完成后自动切文件、退化提示带按钮。
- 端到端用真实 ffmpeg + 真实 mpv 跑了一遍完整链路（见上面的实测数据）。

