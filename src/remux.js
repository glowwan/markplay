'use strict';

/**
 * 为"无索引容器"建立索引（流拷贝转封装）——纯逻辑部分，便于单测。
 *
 * 背景：MPEG-TS 没有 seek 索引，mpv 往回 seek 只能按关键帧对齐，
 * 于是倒放退化成"每 2 秒跳一次"（详见 src/rev-step.js 的注释与实测数据）。
 * 把 TS 用 `-c copy` 转封装成 MP4 会顺带写出索引，之后精确 seek 恢复正常，
 * 倒放就能回到 0.2 秒一小步。
 *
 * 这里只负责：判断要不要做、算输出路径、拼 ffmpeg 参数。
 * 真正的执行在 main.js。
 */

/** 通常没有 seek 索引、转封装收益最大的容器 */
const UNINDEXED_EXTS = ['ts', 'm2ts', 'mts', 'm2t', 'tp', 'trp', 'vob', 'mpg', 'mpeg', 'flv', 'f4v'];

/** 取小写扩展名（不含点） */
function extOf(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 这个文件是否值得转封装（用于给菜单项置灰/提示）。
 * @param {string} filePath
 * @returns {boolean}
 */
function needsIndex(filePath) {
  return UNINDEXED_EXTS.indexOf(extOf(filePath)) >= 0;
}

/**
 * 算输出路径：同目录、同基名 + `.indexed.mp4`。
 *
 * 为什么不直接用基名 + .mp4：用户目录里可能已经有同名 mp4，
 * 覆盖别人的文件是不可接受的。带后缀既避免冲突，也一眼能看出是新生成的。
 *
 * @param {string} inputPath
 * @param {(p: string) => boolean} [exists] 判断文件是否已存在（测试注入）
 * @returns {string}
 */
function buildOutputPath(inputPath, exists) {
  const p = String(inputPath || '');
  if (!p) return '';
  const sep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  const dir = sep >= 0 ? p.slice(0, sep + 1) : '';
  let base = sep >= 0 ? p.slice(sep + 1) : p;
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);

  const has = typeof exists === 'function' ? exists : () => false;
  const first = `${dir}${base}.indexed.mp4`;
  if (!has(first)) return first;
  // 已存在就加序号，绝不覆盖
  for (let i = 2; i <= 99; i++) {
    const next = `${dir}${base}.indexed-${i}.mp4`;
    if (!has(next)) return next;
  }
  return `${dir}${base}.indexed-${Date.now()}.mp4`;
}

/**
 * 拼 ffmpeg 参数：流拷贝，不重编码、不改画质。
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {string[]}
 */
function remuxArgs(inputPath, outputPath) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-c', 'copy',
    // faststart：把索引挪到文件头，seek 更快
    '-movflags', '+faststart',
    outputPath,
  ];
}

/**
 * 从 ffmpeg 的 `-progress` 输出里取百分比。
 * @param {string} line 形如 "out_time_ms=12345678"
 * @param {number} durationSec
 * @returns {number|null} 0-100；无法解析返回 null
 */
function parseProgressPercent(line, durationSec) {
  const m = /^out_time_ms=(\d+)$/.exec(String(line || '').trim());
  if (!m) return null;
  if (!(durationSec > 0)) return null;
  const sec = Number(m[1]) / 1000000;
  if (!Number.isFinite(sec)) return null;
  return Math.max(0, Math.min(100, Math.round((sec / durationSec) * 100)));
}

module.exports = {
  UNINDEXED_EXTS,
  buildOutputPath,
  extOf,
  needsIndex,
  parseProgressPercent,
  remuxArgs,
};
