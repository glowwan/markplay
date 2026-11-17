/* 全屏播放状态栏的逻辑
 *
 * 数据全部来自主窗口渲染进程推送的快照（它才有 markers / ranges / 视图状态），
 * 这里只做两件事：把快照画出来、把点击转成命令发回去。
 */

(function () {
  'use strict';

  var bar = document.getElementById('controlbar');
  var btnPlay = document.getElementById('btn-play');
  var btnOpen = document.getElementById('btn-open');
  var btnPlaylist = document.getElementById('btn-playlist');
  var btnFull = document.getElementById('btn-fullscreen');
  var btnFwd = document.getElementById('btn-speed-fwd');
  var btnRev = document.getElementById('btn-speed-rev');
  var btnLoop = document.getElementById('btn-loop');
  var btnScenes = document.getElementById('btn-scenes');
  var btnZoomOut = document.getElementById('btn-zoom-out');
  var btnZoomIn = document.getElementById('btn-zoom-in');
  var btnZoomFit = document.getElementById('btn-zoom-fit');
  var zoomLabel = document.getElementById('zoom-label');
  var timeCur = document.getElementById('time-current');
  var timeTotal = document.getElementById('time-total');
  var volEl = document.getElementById('volume');
  var statusEl = document.getElementById('status');

  var timeline = document.getElementById('timeline');
  var playhead = document.getElementById('timeline-playhead');
  var rangeBars = document.getElementById('range-bars');
  var markerTicks = document.getElementById('marker-ticks');
  var sceneBubbles = document.getElementById('scene-bubbles');

  function t(key, params) {
    return window.markplay && window.markplay.t
      ? window.markplay.t(key, params)
      : key;
  }

  function cmd(name, arg) {
    window.markplay.command(name, arg);
  }

  // ---------- 时间格式 ----------

  function pad(n, w) {
    var s = String(Math.floor(n));
    while (s.length < w) s = '0' + s;
    return s;
  }

  /** 与非全屏模式完全一致的时间码：HH:MM:SS.mmm */
  function tc(sec) {
    if (!(sec > 0)) return '--:--:--';
    var ms = Math.floor((sec % 1) * 1000);
    return pad(sec / 3600, 1) + ':' + pad((sec % 3600) / 60, 2) + ':' + pad(sec % 60, 2) + '.' + pad(ms, 3);
  }

  function fmtClock(sec) {
    if (!(sec > 0)) return '--:--:--';
    return pad(sec / 3600, 1) + ':' + pad((sec % 3600) / 60, 2) + ':' + pad(sec % 60, 2);
  }

  // ---------- 状态 ----------

  var state = {
    currentTime: 0,
    duration: 0,
    paused: true,
    volume: 100,
    speedMode: 'normal',
    looping: false,
    showScenes: false,
    scenes: [],
    markers: [],
    ranges: [],
    view: { start: 0, end: 0 },
    status: '',
  };

  /** 视图窗口；duration 未知时退回全片 */
  function viewRange() {
    var v = state.view || {};
    var start = Number(v.start) || 0;
    var end = Number(v.end) || 0;
    if (!(end > start)) {
      start = 0;
      end = state.duration > 0 ? state.duration : 0;
    }
    return { start: start, end: end };
  }

  function toRatio(time) {
    var v = viewRange();
    var span = v.end - v.start;
    if (!(span > 0)) return 0;
    return Math.min(1, Math.max(0, (time - v.start) / span));
  }

  // ---------- 时间轴绘制 ----------

  function renderTimeline() {
    // 播放头
    var ratio = toRatio(state.currentTime);
    playhead.style.left = (ratio * 100) + '%';

    // 区间条：只画与可视窗口相交的部分
    rangeBars.innerHTML = '';
    var view = viewRange();
    (state.ranges || []).forEach(function (r) {
      var s = Math.max(r.in, view.start);
      var e = Math.min(r.out, view.end);
      if (!(e > s)) return;
      var el = document.createElement('div');
      el.className = 'range-bar';
      el.style.left = (toRatio(s) * 100) + '%';
      el.style.width = Math.max(0.2, (toRatio(e) - toRatio(s)) * 100) + '%';
      el.style.background = r.color || '#40c4ff';
      el.title = (r.name || '') + '  ' + tc(r.in) + ' → ' + tc(r.out);
      rangeBars.appendChild(el);
    });

    // 标记刻度
    markerTicks.innerHTML = '';
    (state.markers || []).forEach(function (m) {
      if (m.time < view.start || m.time > view.end) return;
      var el = document.createElement('div');
      el.className = 'marker-tick';
      el.style.left = (toRatio(m.time) * 100) + '%';
      el.style.background = m.color || '#fff';
      el.title = m.label + '  ' + tc(m.time);
      markerTicks.appendChild(el);
    });

    // 转场提示浮标
    sceneBubbles.innerHTML = '';
    if (state.showScenes) {
      (state.scenes || []).forEach(function (time) {
        if (time < view.start || time > view.end) return;
        var el = document.createElement('div');
        el.className = 'scene-bubble';
        el.style.left = (toRatio(time) * 100) + '%';
        el.title = t('ui.sceneTip', { tc: tc(time) });
        sceneBubbles.appendChild(el);
      });
    }
  }

  // ---------- 整体渲染 ----------

  function render() {
    btnPlay.textContent = state.paused ? '▶' : '⏸';

    btnFwd.classList.toggle('active', state.speedMode === 'fwd2x');
    btnRev.classList.toggle('active', state.speedMode === 'rev2x');
    btnLoop.classList.toggle('active', state.looping === true);
    btnScenes.classList.toggle('active', state.showScenes === true);

    timeCur.textContent = tc(state.currentTime);
    timeTotal.textContent = fmtClock(state.duration);

    var v = viewRange();
    var span = v.end - v.start;
    if (span > 0 && span < (state.duration || 0) - 0.01) {
      zoomLabel.textContent = '×' + (state.duration / span).toFixed(1);
    } else {
      zoomLabel.textContent = t('ui.zoomFull');
    }

    if (document.activeElement !== volEl) volEl.value = String(state.volume);

    var text = state.status || '';
    statusEl.textContent = text;

    renderTimeline();
  }

  // ---------- 命令接线 ----------

  btnPlay.addEventListener('click', function () { cmd('toggle-play'); });
  btnOpen.addEventListener('click', function () { cmd('open'); });
  btnPlaylist.addEventListener('click', function () { cmd('playlist'); });
  btnFull.addEventListener('click', function () { cmd('toggle-fullscreen'); });
  btnFwd.addEventListener('click', function () { cmd('speed-fwd'); });
  btnRev.addEventListener('click', function () { cmd('speed-rev'); });
  btnLoop.addEventListener('click', function () { cmd('toggle-loop'); });
  btnScenes.addEventListener('click', function () { cmd('toggle-scenes'); });
  btnZoomOut.addEventListener('click', function () { cmd('zoom-out'); });
  btnZoomIn.addEventListener('click', function () { cmd('zoom-in'); });
  btnZoomFit.addEventListener('click', function () { cmd('zoom-fit'); });

  volEl.addEventListener('input', function () {
    cmd('volume', Number(volEl.value));
  });

  // ---------- 时间轴：点击 / 拖拽跳转 ----------

  var dragging = false;

  function seekFromEvent(e) {
    var v = viewRange();
    var span = v.end - v.start;
    if (!(span > 0)) return;
    var rect = timeline.getBoundingClientRect();
    if (rect.width <= 0) return;
    var ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    var time = v.start + ratio * span;
    cmd('seek', time);
  }

  timeline.addEventListener('pointerdown', function (e) {
    dragging = true;
    // 先 seek 再抓指针：setPointerCapture 在某些情况下会抛
    // （例如合成事件没有真实 pointerId），抛了不该把跳转也一起吞掉
    seekFromEvent(e);
    try {
      if (timeline.setPointerCapture) timeline.setPointerCapture(e.pointerId);
    } catch { /* 忽略：抓不住指针只影响拖拽连续性，不影响点击跳转 */ }
    e.preventDefault();
  });

  timeline.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    seekFromEvent(e);
  });

  function endDrag() { dragging = false; }
  timeline.addEventListener('pointerup', endDrag);
  timeline.addEventListener('pointercancel', endDrag);

  // 点转场浮标 = 跳到该处
  sceneBubbles.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('scene-bubble')) return;
    var pct = parseFloat(el.style.left);
    if (!isFinite(pct)) return;
    var v = viewRange();
    cmd('seek', v.start + (pct / 100) * (v.end - v.start));
  });

  // ---------- 订阅 ----------

  window.markplay.onState(function (snap) {
    if (!snap) return;
    Object.keys(snap).forEach(function (k) {
      if (k in state) state[k] = snap[k];
    });
    render();
  });

  window.markplay.onLanguage(function () {
    I18n.applyI18n();
    render();
  });

  // 淡入
  requestAnimationFrame(function () { bar.classList.add('in'); });

  render();
  window.markplay.ready();
})();
