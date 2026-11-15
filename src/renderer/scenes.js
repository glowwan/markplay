/* scenes.js —— 转场提示浮标的纯逻辑（抽稀 + 命中判断）
 *
 * 转场由主进程用 ffmpeg 识别（select=gt(scene,T) + showinfo），结果是一串秒数。
 * 直接全部画到时间轴上会糊成一片，所以按"屏幕像素间距"抽稀。
 *
 * 纯计算，不碰 DOM，便于单测。
 */

var Scenes = (function () {
  'use strict';

  /** 两个浮标之间至少留多少像素，否则跳过（避免重叠） */
  var MIN_GAP_PX = 8;

  /**
   * 按像素间距抽稀。
   *
   * @param {number[]} times 升序的转场时间（秒）
   * @param {{start:number, end:number}} view 当前可视窗口
   * @param {number} widthPx 时间轴像素宽度
   * @param {number} [minGapPx] 最小间距，默认 8
   * @returns {number[]} 保留下来、且落在窗口内的时间
   */
  function thin(times, view, widthPx, minGapPx) {
    var list = Array.isArray(times) ? times : [];
    var width = Number(widthPx);
    if (!(width > 0)) return [];
    var s = Number(view && view.start);
    var e = Number(view && view.end);
    if (!isFinite(s) || !isFinite(e) || !(e > s)) return [];
    var gap = Number(minGapPx) > 0 ? Number(minGapPx) : MIN_GAP_PX;

    var span = e - s;
    var out = [];
    var lastPx = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var t = Number(list[i]);
      if (!isFinite(t)) continue;
      if (t < s - 1e-6 || t > e + 1e-6) continue;
      var px = ((t - s) / span) * width;
      if (px - lastPx < gap) continue;
      lastPx = px;
      out.push(t);
    }
    return out;
  }

  /**
   * 找出离给定时间最近的转场点（用于"跳到上一个/下一个转场"）。
   *
   * @param {number[]} times 升序
   * @param {number} t 当前时间
   * @param {'prev'|'next'} dir
   * @param {number} [tolerance] 距离小于该值视为同一个点，返回 null
   * @returns {number|null}
   */
  function nearest(times, t, dir, tolerance) {
    var list = Array.isArray(times) ? times : [];
    var cur = Number(t);
    if (!isFinite(cur) || !list.length) return null;
    var tol = Number(tolerance) > 0 ? Number(tolerance) : 0.02;

    if (dir === 'prev') {
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] < cur - tol) return list[i];
      }
      return null;
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j] > cur + tol) return list[j];
    }
    return null;
  }

  return {
    MIN_GAP_PX: MIN_GAP_PX,
    nearest: nearest,
    thin: thin,
  };
})();
