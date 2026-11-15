'use strict';

/**
 * 标记文件（sidecar）的时间戳备份：命名与清理逻辑。
 *
 * 纯函数，不碰文件系统，便于单测。实际复制/删除由 main.js 完成。
 *
 * 备份文件名格式：`<视频>.mp4.markplay.json.bak-20261115-120233`
 * 时间戳固定为 `YYYYMMDD-HHmmss`，因此按字符串排序即等于按时间排序。
 */

/** 备份名里的时间戳标记 */
const BAK_MARK = '.bak-';

/**
 * 把 Date 格式化成 `YYYYMMDD-HHmmss`（本地时间）。
 * @param {Date} date
 * @returns {string}
 */
function formatStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/**
 * 生成备份文件路径。
 * @param {string} sidecarPath 例如 `C:\v\a.mp4.markplay.json`
 * @param {Date} [date] 默认当前时间
 * @returns {string}
 */
function backupPathFor(sidecarPath, date) {
  return String(sidecarPath) + BAK_MARK + formatStamp(date || new Date());
}

/**
 * 判断某个文件名是否属于指定 sidecar 的备份。
 * @param {string} fileName 目录里的文件名（不含目录）
 * @param {string} sidecarPath sidecar 完整路径
 * @returns {boolean}
 */
function isBackupOf(fileName, sidecarPath) {
  const base = basename(sidecarPath) + BAK_MARK;
  return String(fileName).startsWith(base);
}

/**
 * 从同名备份列表里挑出该删除的（最旧的先删），保留最新的 keep 个。
 *
 * @param {string[]} fileNames 目录里属于该 sidecar 的备份文件名
 * @param {number} keep 需要保留的数量
 * @returns {string[]} 需要删除的文件名
 */
function pickBackupsToDelete(fileNames, keep) {
  const list = Array.isArray(fileNames) ? fileNames.slice() : [];
  const limit = Number.isFinite(Number(keep)) ? Math.max(0, Math.floor(Number(keep))) : 10;
  if (list.length <= limit) return [];
  // 时间戳固定宽度，字符串升序 = 时间升序
  list.sort();
  return list.slice(0, list.length - limit);
}

/**
 * 取路径最后一段（兼容 Windows / POSIX 分隔符）。
 * @param {string} p
 * @returns {string}
 */
function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

module.exports = {
  BAK_MARK,
  backupPathFor,
  basename,
  formatStamp,
  isBackupOf,
  pickBackupsToDelete,
};
