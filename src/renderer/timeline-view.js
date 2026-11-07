/* timeline-view.js —— 时间轴可视窗口（缩放/平移的单一数据源）
 *
 * 默认显示整段视频；缩放后只显示 [start, end] 这一段。
 * markers.js 用它把时间换算成百分比，renderer.js 用它把鼠标位置换算回时间。
 * 纯计算模块，不碰 DOM，便于单元测试。
 */

var TimelineView = (function () {
  'use strict';

  var MIN_SPAN = 0.5;       // 最小可视跨度（秒），避免缩到看不见
  var duration = 0;
  var start = 0;
  var end = 1;              // 没有视频时用 0..1 占位，避免除零

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function span() {
    return Math.max(0.0001, end - start);
  }

  /** 重置到整段可见 */
  function reset() {
    start = 0;
    end = duration > 0 ? duration : 1;
  }

  /**
   * 设置视频总时长。时长没变时保持当前缩放窗口（避免每次 duration 事件把用户缩放重置）。
   * @param {number} d
   */
  function setDuration(d) {
    if (typeof d !== 'number' || !isFinite(d) || d < 0) return;
    if (duration > 0 && Math.abs(d - duration) < 0.01) return;
    duration = d;
    reset();
  }

  /**
   * 设置可视窗口（秒）。
   * @param {number} s
   * @param {number} e
   */
  function setView(s, e) {
    if (!(duration > 0)) { start = 0; end = 1; return; }
    var width = e - s;
    if (!(width > 0) || !isFinite(width)) return;
    width = Math.min(width, duration);
    width = Math.max(width, Math.min(MIN_SPAN, duration));
    start = clamp(s, 0, duration - width);
    end = start + width;
  }

  /**
   * 以可视窗口内的某个比例点为锚点缩放。
   * @param {number} ratio 0–1（锚点在窗口中的位置）
   * @param {number} factor >1 放大，<1 缩小
   */
  function zoomAt(ratio, factor) {
    if (!(duration > 0)) return;
    ratio = clamp(ratio, 0, 1);
    var anchorTime = start + ratio * span();
    var nextSpan = clamp(span() / factor, Math.min(MIN_SPAN, duration), duration);
    var nextStart = anchorTime - ratio * nextSpan;
    setView(nextStart, nextStart + nextSpan);
  }

  function zoomIn(ratio) { zoomAt(ratio == null ? 0.5 : ratio, 2); }
  function zoomOut(ratio) { zoomAt(ratio == null ? 0.5 : ratio, 0.5); }

  /** 窗口平移（秒） */
  function panBy(deltaSec) {
    if (!(duration > 0) || !isFinite(deltaSec)) return;
    setView(start + deltaSec, end + deltaSec);
  }

  /** 把某个时间点放到窗口中央 */
  function centerOn(t) {
    if (!(duration > 0) || !isFinite(t)) return;
    var width = span();
    setView(t - width / 2, t + width / 2);
  }

  /** 播放头离开窗口时把它拉回来 */
  function keepVisible(t) {
    if (!(duration > 0) || !isFinite(t)) return false;
    if (t < start || t > end) {
      centerOn(t);
      return true;
    }
    return false;
  }

  /** 时间 → 窗口内比例（可能 <0 或 >1，调用方可自行过滤） */
  function toRatio(t) {
    return (t - start) / span();
  }

  /** 窗口内比例 → 时间 */
  function toTime(ratio) {
    return start + clamp(ratio, 0, 1) * span();
  }

  function isFull() {
    return !(duration > 0) || (start <= 0.001 && end >= duration - 0.001);
  }

  function getState() {
    return { start: start, end: end, duration: duration, span: span(), full: isFull() };
  }

  reset();

  return {
    setDuration: setDuration,
    reset: reset,
    setView: setView,
    zoomAt: zoomAt,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    panBy: panBy,
    centerOn: centerOn,
    keepVisible: keepVisible,
    toRatio: toRatio,
    toTime: toTime,
    isFull: isFull,
    getState: getState,
  };
})();
