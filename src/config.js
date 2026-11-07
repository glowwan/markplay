'use strict';

/**
 * MarkPlay 全局共享配置（前后端共用）。
 * 前端通过 window.markplay.config 直接读取，修改后重新打包即生效。
 */

/**
 * 根据当前主进程 PID 生成唯一的 mpv 命名管道名。
 * @param {number} pid - 进程 ID
 * @returns {string} 管道名（不含 `\\.\pipe\` 前缀）
 */
const PIPE_NAME = (pid) => `markplay-${pid}`;

/** 触摸板横滑 scrub 灵敏度：每个像素对应多少秒（值越小越灵敏，越容易"飞"） */
const SCRUB_SENSITIVITY = 0.03;

/** 触摸板横滑 rAF 插值系数（0~1）：越小画面越顺滑但越迟滞 */
const SCRUB_SMOOTHING = 0.22;

/** 停止滚动后恢复播放的等待时间（毫秒）：避免"滚一停一"的闪烁 */
const SCRUB_IDLE_MS = 150;

/** 2x 倒放模拟：暂停 + 每隔这么多毫秒回退 REV2X_STEP 秒 */
const REV2X_INTERVAL_MS = 100;
/** 2x 倒放模拟：每次回退的秒数（INTERVAL_MS=100、STEP=0.2 即 2 倍速） */
const REV2X_STEP = 0.2;

/** 惯性衰减系数（0~1）：手指离开后每帧速度的保留比例，越小停得越快 */
const SCRUB_INERTIA_DECAY = 0.94;

/**
 * 横滑方向反转：true = 内容跟随手指（右推快退 / 左推快进，类似手机相册）；
 * false = 滚动条逻辑（右推快进 / 左推快退）。
 */
const SCRUB_INVERT_X = true;

/**
 * 拖动 seek 的精度切换阈值（视频秒/现实秒）：
 * 手指速度低于它 → absolute+exact（慢速微调要准）；
 * 高于它 → absolute+keyframes（快速拖动要快，松手时再补一次 exact）。
 * 学 mpv 官方 OSC（seekbarkeyframes）与 LosslessCut 的做法。
 */
const SCRUB_KEYFRAME_VELOCITY = 1.0;

/** 音量步进（左右括号/上下键），单位百分比 */
const VOLUME_STEP = 4;

/** 左右方向键单次跳转秒数 */
const SEEK_STEP = 5;

/** A/B/C/D/F/G 打点标记颜色（渲染进程画标记用；E 留给导出面板快捷键） */
const MARKER_COLORS = {
  A: '#ff5252',
  B: '#69f0ae',
  C: '#40c4ff',
  D: '#ffd740',
  F: '#ea80fc',
  G: '#8c9eff',
};

/**
 * 视频子窗口定位时是否额外乘 DPI 缩放系数。
 *
 * Electron 的 BrowserWindow.setBounds / getContentBounds 都使用 DIP（设备无关像素），
 * 与渲染进程的 CSS 像素一一对应，正常情况下**不需要**再乘 scaleFactor。
 * 在 125% / 150% 缩放的屏幕上，乘了会把画面整体放大并偏移（视频跑到右下角）。
 *
 * 只有遇到特殊 DPI 环境（例如进程 DPI 感知被外部改坏、画面明显偏小）才改为 true 排查。
 */
const SURFACE_APPLY_DPI_SCALE = false;

/** 标记撤销栈的最大深度 */
const HISTORY_LIMIT = 50;

/**
 * 素材帧率读不到时的兜底值（EDL/帧号换算用）。
 * 正常播放时会从 mpv 的 container-fps 读取真实帧率，这里只是没有视频时的默认。
 */
const DEFAULT_FPS = 25;

module.exports = {
  PIPE_NAME,
  SCRUB_SENSITIVITY,
  SCRUB_SMOOTHING,
  SCRUB_IDLE_MS,
  SCRUB_INERTIA_DECAY,
  SCRUB_INVERT_X,
  SCRUB_KEYFRAME_VELOCITY,
  VOLUME_STEP,
  SEEK_STEP,
  MARKER_COLORS,
  SURFACE_APPLY_DPI_SCALE,
  HISTORY_LIMIT,
  DEFAULT_FPS,
  REV2X_INTERVAL_MS,
  REV2X_STEP,
};
