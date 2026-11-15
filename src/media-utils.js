'use strict';

/**
 * 主进程的纯函数工具（不含 Electron / DOM 依赖，可直接单测）。
 *
 * 从 main.js 抽出来的是"有逻辑、容易错、但不涉及窗口和子进程"的那部分：
 * 文件类型判定、命令行参数解析、ffmpeg 码率与参数拼装、concat 列表转义。
 * 窗口、mpv、IPC 依旧留在 main.js。
 */

const path = require('path');

/** 可打开的视频/音频扩展名 */
const MEDIA_EXTENSIONS = [
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm2ts', 'ts', 'm4v',
  'mpg', 'mpeg', 'vob', 'ogv', '3gp', 'asf', 'rmvb', 'divx',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mka', 'wma',
];

/** 可拖入的字幕扩展名（走 mpv sub-add，而不是当成视频打开） */
const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup'];

/** 重新编码时给音轨预留的码率（bps） */
const AUDIO_BPS = 96000;

/** 视频码率下限：低于这个值说明源文件码率过低，改用比例兜底 */
const MIN_VIDEO_BPS = 120000;

/** 视频码率上限，防止异常大的文件算出离谱参数 */
const MAX_VIDEO_BPS = 50000000;

/**
 * 取小写扩展名（不含点）。
 * @param {string} p
 * @returns {string}
 */
function extensionOf(p) {
  const ext = path.extname(String(p || ''));
  return ext ? ext.slice(1).toLowerCase() : '';
}

/**
 * 是否为字幕文件。
 * @param {string} p
 * @returns {boolean}
 */
function isSubtitlePath(p) {
  return SUBTITLE_EXTENSIONS.includes(extensionOf(p));
}

/**
 * 是否为可播放的媒体文件。
 * @param {string} p
 * @returns {boolean}
 */
function isMediaPath(p) {
  return MEDIA_EXTENSIONS.includes(extensionOf(p));
}

/**
 * 从进程参数里找第一个存在且扩展名可用的媒体文件。
 * 打包后 argv[1] 就是被双击的文件；开发环境（electron .）里会混入 "." 等参数，需要过滤。
 * 从后往前找，取最后一个可用的——后出现的更接近用户真实意图。
 *
 * @param {string[]} argv
 * @param {{resolve?: (p: string) => string, exists?: (p: string) => boolean}} [deps]
 *   可注入 path.resolve / fs.existsSync，便于单测；默认走真实文件系统。
 * @returns {string} 完整路径；找不到返回空串
 */
function findMediaArg(argv, deps) {
  if (!Array.isArray(argv)) return '';
  const resolve = (deps && deps.resolve) || ((p) => path.resolve(p));
  const exists = (deps && deps.exists) || (() => false);

  for (let i = argv.length - 1; i >= 1; i--) {
    const candidate = argv[i];
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    if (candidate.startsWith('-')) continue;
    let full;
    try {
      full = resolve(candidate);
    } catch {
      continue;
    }
    if (!exists(full)) continue;
    if (isMediaPath(full)) return full;
  }
  return '';
}

/**
 * 按"源文件大小 / 时长"估算视频码率，让重新编码后的体积尽量接近源文件。
 *
 * 纯函数：只吃字节数和时长，不碰文件系统，便于单测。
 *
 * @param {number} totalBytes 源文件字节数
 * @param {number} durationSec 源文件时长（秒）
 * @returns {number} 视频码率（bps）；无法估算时返回 0（调用方回退到 CRF）
 */
function estimateVideoBitrate(totalBytes, durationSec) {
  const bytes = Number(totalBytes);
  const d = Number(durationSec);
  if (!Number.isFinite(bytes) || bytes < 1024) return 0;
  if (!Number.isFinite(d) || d < 2) return 0;

  const totalBps = (bytes * 8) / d;
  if (!Number.isFinite(totalBps) || totalBps < 60000) return 0;

  let videoBps = Math.round(totalBps - AUDIO_BPS);
  // 源文件码率极低时，"总码率减音轨"会得到很小的数甚至负数，改用比例兜底
  if (videoBps < MIN_VIDEO_BPS) {
    videoBps = Math.max(80000, Math.round(totalBps * 0.7));
  }
  return Math.min(videoBps, MAX_VIDEO_BPS);
}

/**
 * 重新编码的 ffmpeg 参数。
 * 有目标码率就按 ABR 压（体积贴近源文件），没有就退回 CRF 23。
 *
 * @param {number} targetBps estimateVideoBitrate 的返回值
 * @returns {string[]}
 */
function reencodeArgs(targetBps) {
  if (Number.isFinite(targetBps) && targetBps > 0) {
    const maxrate = Math.round(targetBps * 1.2);
    return [
      '-c:v', 'libx264', '-preset', 'fast',
      '-b:v', String(targetBps),
      '-maxrate', String(maxrate),
      '-bufsize', String(targetBps * 2),
      '-c:a', 'aac', '-b:a', '96k',
    ];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac'];
}

/**
 * concat demuxer 列表里的一行。
 * Windows 反斜杠要转正斜杠，单引号要按 ffmpeg 的转义规则处理。
 *
 * @param {string} filePath
 * @returns {string}
 */
function toConcatLine(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
  return "file '" + normalized + "'";
}

module.exports = {
  AUDIO_BPS,
  MAX_VIDEO_BPS,
  MEDIA_EXTENSIONS,
  MIN_VIDEO_BPS,
  SUBTITLE_EXTENSIONS,
  estimateVideoBitrate,
  extensionOf,
  findMediaArg,
  isMediaPath,
  isSubtitlePath,
  reencodeArgs,
  toConcatLine,
};
