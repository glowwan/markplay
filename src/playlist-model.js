'use strict';

/**
 * 文件列表（播放列表）的纯逻辑。
 *
 * 抽出来是为了可单测：窗口显隐、全屏悬浮判定这些一旦写错，
 * 表现出来就是"列表死活不出来"或"出来了收不回去"，靠肉眼很难查。
 * 这里只做纯计算，不碰 Electron。
 */
const path = require('path');

/** Windows 路径比较统一小写，避免大小写差异导致同一文件被加两次 */
function pathKey(p) {
  return String(p || '').toLowerCase();
}

/**
 * 造一条列表项。
 * @param {string} filePath
 * @returns {{path: string, name: string, dir: string}}
 */
function makeItem(filePath) {
  return {
    path: filePath,
    name: path.basename(filePath),
    dir: path.dirname(filePath),
  };
}

/**
 * 去掉重复路径（保持首次出现的顺序），空值忽略。
 * @param {string[]} paths
 * @returns {string[]}
 */
function dedupePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p) continue;
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * 由路径数组建列表项数组。
 * @param {string[]} paths
 * @returns {Array<{path: string, name: string, dir: string}>}
 */
function buildItems(paths) {
  return dedupePaths(paths).map(makeItem);
}

/**
 * 在列表里找某个路径的下标（大小写不敏感）。
 * @param {Array<{path: string}>} items
 * @param {string} filePath
 * @returns {number} 找不到返回 -1
 */
function indexOfPath(items, filePath) {
  if (!Array.isArray(items) || typeof filePath !== 'string' || !filePath) return -1;
  const key = pathKey(filePath);
  return items.findIndex((it) => it && pathKey(it.path) === key);
}

/**
 * 记录"现在正在播这个文件"：在列表里就移动高亮，不在就追加到末尾。
 * 不修改传入的数组，返回新对象，方便测试与撤销。
 * @param {Array<{path: string, name: string, dir: string}>} items
 * @param {string} filePath
 * @returns {{items: Array, index: number}}
 */
function noteCurrent(items, filePath) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (typeof filePath !== 'string' || !filePath) {
    return { items: list, index: list.length ? 0 : -1 };
  }
  let idx = indexOfPath(list, filePath);
  if (idx < 0) {
    list.push(makeItem(filePath));
    idx = list.length - 1;
  }
  return { items: list, index: idx };
}

/**
 * 光标是否进入了"右侧热区"（全屏时用来决定要不要弹出列表）。
 *
 * 判定用屏幕坐标，且只在右缘那一小条算命中——太宽会误触，
 * 太窄用户又很难对准。
 *
 * @param {{x: number, y: number}} cursor screen.getCursorScreenPoint()
 * @param {{x: number, y: number, width: number, height: number}} display 显示器 bounds
 * @param {number} edgePx 热区宽度（像素）
 * @returns {boolean}
 */
function hitRightEdge(cursor, display, edgePx) {
  if (!cursor || !display) return false;
  const right = display.x + display.width;
  const left = right - Math.max(1, edgePx);
  const top = display.y;
  const bottom = display.y + display.height;
  return cursor.x >= left && cursor.x <= right + 1
    && cursor.y >= top && cursor.y <= bottom;
}

/**
 * 光标是否还"落在列表上"（含外扩边距）。
 * 离开这个范围就自动收起。
 *
 * @param {{x: number, y: number}} cursor
 * @param {{x: number, y: number, width: number, height: number}} listBounds 列表窗口 bounds
 * @param {number} margin 外扩容差
 * @returns {boolean}
 */
function insideList(cursor, listBounds, margin) {
  if (!cursor || !listBounds) return false;
  const m = Math.max(0, margin || 0);
  return cursor.x >= listBounds.x - m
    && cursor.x <= listBounds.x + listBounds.width + m
    && cursor.y >= listBounds.y - m
    && cursor.y <= listBounds.y + listBounds.height + m;
}

/**
 * 算出列表窗口应该摆在哪。
 *
 * - 全屏：贴屏幕右缘、整屏高；
 * - 窗口模式：贴视频区右缘（不遮标记侧栏），高度跟视频区一致；
 * - 没有视频：贴主窗口客户区右缘。
 *
 * @param {object} p
 * @param {number} p.width 列表宽度
 * @param {boolean} p.fullscreen 视频是否全屏
 * @param {{x:number,y:number,width:number,height:number}} [p.display] 全屏时的显示器 bounds
 * @param {{x:number,y:number,w:number,h:number}} [p.videoRect] 视频区在客户区里的矩形
 * @param {{x:number,y:number,width:number,height:number}} [p.content] 主窗口客户区 bounds
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function computeBounds(p) {
  const width = Math.max(80, Math.round(p && p.width ? p.width : 320));

  // 全屏：贴屏幕右缘
  if (p && p.fullscreen && p.display) {
    return {
      x: Math.round(p.display.x + p.display.width - width),
      y: Math.round(p.display.y),
      width,
      height: Math.round(p.display.height),
    };
  }

  // 窗口模式：贴视频区右缘
  if (p && p.content) {
    const cb = p.content;
    if (p.videoRect && p.videoRect.w > width) {
      return {
        x: Math.round(cb.x + p.videoRect.x + p.videoRect.w - width),
        y: Math.round(cb.y + p.videoRect.y),
        width,
        height: Math.max(120, Math.round(p.videoRect.h)),
      };
    }
    return {
      x: Math.round(cb.x + cb.width - width),
      y: Math.round(cb.y),
      width,
      height: Math.max(120, Math.round(cb.height)),
    };
  }

  return null;
}

module.exports = {
  buildItems,
  computeBounds,
  dedupePaths,
  hitRightEdge,
  indexOfPath,
  insideList,
  makeItem,
  noteCurrent,
  pathKey,
};
