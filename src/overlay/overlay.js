/* MarkPlay 悬浮控件层（透明覆盖窗口）
 *
 * 这是一个独立的 frameless + transparent 窗口，叠在 mpv 视频子窗口之上，
 * 专门承载"悬浮在画面上的控件"。
 *
 * 为什么不直接把控件放进主窗口：主窗口的 HTML 画不到 mpv 的原生子窗口之上，
 * 那是 --wid 方案的固有限制（见 docs/LIBMPV-MIGRATION.md）。再开一层透明窗口
 * 是成本最低的绕法。
 *
 * 交互要点：
 *  - 默认整窗鼠标穿透（setIgnoreMouseEvents(true, {forward:true})），
 *    这样滚轮还能落到 mpv 上做 scrub；
 *  - 指针移到控件条范围内 → 请求主进程关闭穿透，才能点击；
 *  - 指针离开 → 恢复穿透。
 */

(function () {
  'use strict';

  var pill = document.getElementById('pill');
  var btnPlay = document.getElementById('ov-play');
  var timeEl = document.getElementById('ov-time');
  var totalEl = document.getElementById('ov-total');
  var bar = document.getElementById('ov-bar');
  var fill = document.getElementById('ov-fill');
  var knob = document.getElementById('ov-knob');
  var btnMute = document.getElementById('ov-mute');
  var volEl = document.getElementById('ov-vol');
  var btnFull = document.getElementById('ov-full');

  /** 当前是否处于"可交互"状态（已请求主进程关闭穿透） */
  var interactive = false;
  /** 隐藏定时器 */
  var hideTimer = 0;
  /** 控件条外扩多少像素算"在控件上"，方便鼠标移上去 */
  var HOVER_PAD = 14;

  var state = {
    paused: true,
    currentTime: 0,
    duration: 0,
    volume: 100,
    muted: false
  };

  // ---------- 时间格式 ----------

  function fmtClock(sec) {
    if (!(sec > 0)) return '--:--:--';
    var s = Math.floor(sec);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  // ---------- 显示 / 隐藏 ----------

  function showPill() {
    pill.classList.add('visible');
  }

  function hidePill() {
    // 正在拖进度条或悬停在控件上时不要藏
    if (dragging) return;
    if (pointerOnPill) return;
    pill.classList.remove('visible');
    setInteractive(false);
  }

  function bumpHideTimer() {
    showPill();
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePill, 2200);
  }

  // ---------- 鼠标穿透 ----------

  function setInteractive(next) {
    if (interactive === next) return;
    interactive = next;
    // 由主进程执行 setIgnoreMouseEvents，渲染进程没有这个能力
    window.overlayApi && window.overlayApi.setInteractive(next);
  }

  /** 指针是否落在控件条（含外扩）范围内 */
  var pointerOnPill = false;

  function hitTest(x, y) {
    var r = pill.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return x >= r.left - HOVER_PAD && x <= r.right + HOVER_PAD &&
           y >= r.top - HOVER_PAD && y <= r.bottom + HOVER_PAD;
  }

  // ---------- 进度条 ----------

  var dragging = false;

  function ratioFromEvent(e) {
    var r = bar.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  function applyRatio(ratio) {
    if (!(state.duration > 0)) return;
    var t = ratio * state.duration;
    fill.style.width = (ratio * 100) + '%';
    knob.style.left = (ratio * 100) + '%';
    timeEl.textContent = fmtClock(t);
  }

  bar.addEventListener('pointerdown', function (e) {
    if (!(state.duration > 0)) return;
    dragging = true;
    setInteractive(true);
    bar.setPointerCapture && bar.setPointerCapture(e.pointerId);
    applyRatio(ratioFromEvent(e));
    e.preventDefault();
  });

  bar.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    applyRatio(ratioFromEvent(e));
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    var ratio = ratioFromEvent(e);
    window.overlayApi && window.overlayApi.command('seek-ratio', ratio);
    bumpHideTimer();
  }

  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', function () { dragging = false; });

  // ---------- 按钮 ----------

  btnPlay.addEventListener('click', function () {
    window.overlayApi && window.overlayApi.command('toggle-play');
    bumpHideTimer();
  });

  btnFull.addEventListener('click', function () {
    window.overlayApi && window.overlayApi.command('toggle-fullscreen');
    bumpHideTimer();
  });

  btnMute.addEventListener('click', function () {
    window.overlayApi && window.overlayApi.command('toggle-mute');
    bumpHideTimer();
  });

  volEl.addEventListener('input', function () {
    window.overlayApi && window.overlayApi.command('volume', Number(volEl.value));
    bumpHideTimer();
  });

  // ---------- 全局指针跟踪 ----------

  document.addEventListener('mousemove', function (e) {
    var onPill = hitTest(e.clientX, e.clientY);
    if (onPill !== pointerOnPill) {
      pointerOnPill = onPill;
      // 离开控件条时如果不在显示状态就恢复穿透
      setInteractive(onPill || dragging);
    }

    if (onPill) {
      showPill();
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    } else if (!dragging) {
      bumpHideTimer();
    }
  }, { passive: true });

  // 鼠标离开窗口时恢复穿透，避免穿透关掉后卡住
  document.addEventListener('mouseleave', function () {
    pointerOnPill = false;
    if (!dragging) setInteractive(false);
  });

  // ---------- 键盘转发 ----------
  // 覆盖窗口一旦被点击就可能拿到焦点，这里把按键转回主窗口，
  // 否则 Space / A–G / Ctrl+Z 这些快捷键会突然失灵。
  window.addEventListener('keydown', function (e) {
    window.overlayApi && window.overlayApi.forwardKey({
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    });
    e.preventDefault();
  });

  // ---------- 状态同步 ----------

  function render() {
    btnPlay.textContent = state.paused ? '▶' : '⏸';

    var ratio = state.duration > 0 ? Math.min(1, Math.max(0, state.currentTime / state.duration)) : 0;
    if (!dragging) {
      fill.style.width = (ratio * 100) + '%';
      knob.style.left = (ratio * 100) + '%';
      timeEl.textContent = fmtClock(state.currentTime);
    }
    totalEl.textContent = fmtClock(state.duration);

    var muted = state.muted || state.volume === 0;
    btnMute.textContent = muted ? '🔇' : '🔊';
    if (document.activeElement !== volEl) {
      volEl.value = String(state.volume);
    }
  }

  window.overlayApi && window.overlayApi.onState(function (patch) {
    if (!patch) return;
    Object.keys(patch).forEach(function (k) {
      if (k in state) state[k] = patch[k];
    });
    render();
  });

  render();

  // 首次进入时先隐藏，鼠标一动才出现
  pill.classList.remove('visible');
})();
