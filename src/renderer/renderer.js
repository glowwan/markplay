/* renderer.js —— 主接线：状态管理、播放控制、时间轴交互、键盘、拖拽、视频区定位
 *
 * 依赖（加载顺序）：scrub.js → markers.js → ui.js → export.js → 本文件。
 * 所有 mpv 交互只走 window.markplay 契约 API，不做任何假设之外的调用。
 */

(function () {
  'use strict';

  // ---------- 启动自检：preload 桥接失败时大声报错，而不是静默死掉 ----------
  function $(id) { return document.getElementById(id); }
  function statusEarly(text) {
    var el = document.getElementById('status');
    if (el) { el.textContent = text; el.style.color = '#ff5252'; }
  }
  if (!window.markplay) {
    document.addEventListener('DOMContentLoaded', function () {
      statusEarly('错误：主进程接口未加载（window.markplay 缺失）。请尝试重装，或把此信息发给开发者。');
    });
    return; // 后续接线全部依赖 markplay，直接中止
  }

  // ---------- 工具 ----------
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function basename(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }
  function extname(p) {
    var m = /\.[^.\\/]+$/.exec(String(p || ''));
    return m ? m[0].slice(1).toLowerCase() : '';
  }
  // 总时长显示不需要毫秒：H:MM:SS
  function fmtDur(sec) {
    if (!(sec > 0)) return '--:--:--';
    var s = Math.floor(sec);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  var SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup'];

  // ---------- 状态 ----------
  var state = {
    videoPath: '',     // 当前视频完整路径
    duration: 0,       // 时长（秒）
    currentTime: 0,    // 当前播放时间（秒）
    paused: true,
    speedMode: 'normal', // 'normal' | 'fwd2x' | 'rev2x'
    fullscreen: false,   // 视频子窗口是否全屏
    looping: false,      // A–B 循环是否开启
    fps: 0,              // 素材帧率（mpv container-fps；0 表示未知）
    pendingIn: null      // 已按"设入点"但还没设出点的时间（秒），null 表示未设置
  };
  var timelineDragging = false; // 时间轴指针拖拽 seek 中
  var preferredVolume = 100;    // 记住的音量（新开 mpv 时重新应用）
  var volumeSaveTimer = 0;
  var statusTimer = 0;

  /**
   * 状态栏文字。
   * @param {string} text
   * @param {'normal'|'error'|'ok'} [kind] error 会标红并在 6 秒后自动恢复
   */
  function status(text, kind) {
    var el = $('status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', kind === 'error');
    el.classList.toggle('ok', kind === 'ok');
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
    if (kind === 'error') {
      statusTimer = setTimeout(function () {
        el.classList.remove('err');
        el.textContent = '就绪';
      }, 6000);
    }
  }

  function cfg() { return window.markplay.config; }

  // ---------- 模块接线 ----------
  Markers.init({
    onSeek: seekTo,
    onChange: function () {
      Exporter.refreshClipSelectors();
      // 区间增删/改名后，如果循环开着且目标变了，自动跟过去
      if (state.looping) syncLoopWithSelection();
      else updateLoopUI();
    },
    timeProvider: function () { return state.currentTime; }
  });
  Exporter.init({
    getVideoPath: function () { return state.videoPath; },
    getDuration: function () { return state.duration; },
    getFps: function () { return state.fps; },
    status: status
  });
  Scrub.init();

  // ---------- 2x 速度模式 UI ----------
  function updateSpeedUI() {
    var fwd = $('btn-speed-fwd');
    var rev = $('btn-speed-rev');
    if (fwd) fwd.classList.toggle('active', state.speedMode === 'fwd2x');
    if (rev) rev.classList.toggle('active', state.speedMode === 'rev2x');
    if (state.speedMode === 'fwd2x') status('2 倍速播放中（再按 X / 点左键恢复）');
    else if (state.speedMode === 'rev2x') status('2 倍速倒放中（再按 Z / 点右键恢复）');
  }

  function toggleSpeed(mode) {
    if (!state.videoPath) return;
    window.markplay.toggleSpeedMode(mode).catch(function (err) {
      status('切换速度失败：' + (err && err.message ? err.message : err), 'error');
    });
  }

  // ---------- 区间：设入点 / 设出点 ----------
  function selectedRange() {
    var sel = $('clip-range');
    var ranges = Markers.getRanges();
    if (!ranges.length) return null;
    return ranges.find(function (r) { return r.id === (sel && sel.value); }) || ranges[0];
  }

  function selectRange(id) {
    var sel = $('clip-range');
    if (sel && id) sel.value = id;
  }

  function updateRangeHint() {
    var el = $('range-pending');
    if (!el) return;
    if (state.pendingIn == null) {
      el.textContent = '入点：未设置';
      el.classList.remove('set');
      return;
    }
    el.textContent = '入点：' + Exporter.tc(state.pendingIn) + '（再按 ] 设出点）';
    el.classList.add('set');
  }

  function markRangeIn() {
    if (!requireVideo()) return;
    state.pendingIn = state.currentTime;
    updateRangeHint();
    status('区间入点 @ ' + Exporter.tc(state.pendingIn) + '，播到出点后按 ]', 'ok');
  }

  function markRangeOut() {
    if (!requireVideo()) return;
    if (state.pendingIn == null) {
      status('先设入点：按 [ 或点"设入点"', 'error');
      return;
    }
    var a = state.pendingIn;
    var b = state.currentTime;
    if (!(b > a)) {
      status('出点必须晚于入点（入点 ' + Exporter.tc(a) + '）', 'error');
      return;
    }
    var r = Markers.addRange(a, b);
    if (!r) {
      status('创建区间失败：时间范围无效', 'error');
      return;
    }
    state.pendingIn = null;
    updateRangeHint();
    Exporter.refreshClipSelectors();
    selectRange(r.id);
    status('已创建区间：' + r.name + '  ' + Exporter.tc(r.in) + ' → ' + Exporter.tc(r.out), 'ok');
    UI.toast('已创建区间：' + r.name, { kind: 'success' });
  }

  /** 把老的 A/B 标记批量迁移成区间 */
  function rangesFromMarkers() {
    if (!requireVideo()) return;
    var n = Markers.addRangesFromMarkers();
    if (!n) {
      status('没有可配对的 A/B 标记（需要 A 后面跟一个 B）', 'error');
      return;
    }
    Exporter.refreshClipSelectors();
    UI.toast('已从 A/B 标记生成 ' + n + ' 个区间', { kind: 'success' });
  }

  /** 任意类型：按时间相邻两个标记生成区间（1-2、3-4…） */
  function rangesFromAdjacent() {
    if (!requireVideo()) return;
    var n = Markers.addRangesFromAdjacentMarkers();
    if (!n) {
      status('没有可配对的相邻标记（至少 2 个，且不能与已有区间完全重复）', 'error');
      return;
    }
    Exporter.refreshClipSelectors();
    UI.toast('已按相邻标记生成 ' + n + ' 个区间', { kind: 'success' });
  }

  // ---------- A–B 循环 ----------
  var loopRangeId = null; // 当前正在循环的区间 id，避免重复下发同样的 ab-loop

  function rangeIndex(range) {
    var all = Markers.getRanges();
    var i = all.indexOf(range);
    return i >= 0 ? i + 1 : 0;
  }

  function updateLoopUI() {
    var btn = $('btn-loop');
    if (!btn) return;
    btn.classList.toggle('active', state.looping);
    var range = selectedRange();
    if (state.looping && range) {
      var n = rangeIndex(range);
      btn.textContent = n ? ('A–B ' + n) : 'A–B';
      btn.title = '正在循环：' + range.name + '（点击关闭；在剪辑面板换区间会自动切换）';
    } else {
      btn.textContent = 'A–B';
      btn.title = 'A–B 循环（L）：循环剪辑面板中选中的区间';
    }
  }

  function stopLoop() {
    return Promise.all([
      window.markplay.mpvCommand(['set_property', 'ab-loop-a', 'no']).catch(function () {}),
      window.markplay.mpvCommand(['set_property', 'ab-loop-b', 'no']).catch(function () {})
    ]).then(function () {
      state.looping = false;
      loopRangeId = null;
      updateLoopUI();
      status('已关闭 A–B 循环');
    });
  }

  /** 把循环点设到指定区间（已开启循环时切区间走这里） */
  function applyLoopRange(range) {
    if (!range) return Promise.resolve();
    return Promise.all([
      window.markplay.mpvCommand(['set_property', 'ab-loop-a', range.in]),
      window.markplay.mpvCommand(['set_property', 'ab-loop-b', range.out])
    ]).then(function () {
      state.looping = true;
      loopRangeId = range.id;
      updateLoopUI();
      status('A–B 循环：' + range.name + '（'
        + Exporter.tc(range.in) + ' → ' + Exporter.tc(range.out) + '）');
    }).catch(function (err) {
      state.looping = false;
      loopRangeId = null;
      updateLoopUI();
      status('设置 A–B 循环失败：' + (err && err.message ? err.message : err), 'error');
    });
  }

  function toggleLoop() {
    if (!state.videoPath) return;
    if (state.looping) {
      stopLoop();
      return;
    }
    var range = selectedRange();
    if (!range) {
      status('A–B 循环需要一个区间：先按 [ / ] 建区间', 'error');
      return;
    }
    applyLoopRange(range);
  }

  /** 剪辑面板换了区间：循环开着就自动切到新区间，没开就只刷新按钮提示 */
  function syncLoopWithSelection() {
    var range = selectedRange();
    if (!state.looping) {
      updateLoopUI();
      return;
    }
    if (!range) {
      stopLoop();
      return;
    }
    if (range.id === loopRangeId) {
      updateLoopUI();
      return;
    }
    applyLoopRange(range);
  }

  // ---------- 逐帧 ----------
  function frameStep(direction) {
    if (!requireVideo()) return;
    window.markplay.mpvCommand(['set_property', 'pause', true]).then(function () {
      return window.markplay.mpvCommand([direction > 0 ? 'frame-step' : 'frame-back-step']);
    }).catch(function (err) {
      status('逐帧失败：' + (err && err.message ? err.message : err), 'error');
    });
  }

  // ---------- 拖放 ----------
  var dropHintTimer = 0;
  /** 显示/隐藏拖放提示遮罩（true 显示，false 或超时自动隐藏） */
  function showDropHint(on) {
    var el = $('drop-hint');
    if (!el) return;
    if (dropHintTimer) { clearTimeout(dropHintTimer); dropHintTimer = 0; }
    el.hidden = !on;
    if (on) {
      dropHintTimer = setTimeout(function () { el.hidden = true; }, 3000);
    }
  }

  /** 从 DataTransfer 抠文件路径：优先 files[0].path，兜底 text/uri-list */
  function extractDropPath(dt) {
    if (!dt) return null;
    if (dt.files && dt.files[0] && dt.files[0].path) return dt.files[0].path;
    try {
      var uri = dt.getData('text/uri-list') || '';
      var first = uri.split('\n').map(function (s) { return s.trim(); })
        .filter(function (s) { return s && s.charAt(0) !== '#'; })[0];
      if (first && first.indexOf('file://') === 0) {
        var p = decodeURIComponent(new URL(first).pathname);
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
        return p;
      }
      return first || null;
    } catch (_) { return null; }
  }

  function wireDragDrop() {
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      showDropHint(true);
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      if (--dragDepth <= 0) { dragDepth = 0; showDropHint(false); }
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      showDropHint(false);
      var p = extractDropPath(e.dataTransfer);
      if (!p) {
        status('拖放未识别到文件路径，请从文件资源管理器拖入', 'error');
        return;
      }
      if (SUBTITLE_EXTENSIONS.indexOf(extname(p)) >= 0) {
        loadSubtitle(p);
        return;
      }
      loadVideo(p);
    });
  }

  function loadSubtitle(path) {
    status('正在加载字幕：' + basename(path) + ' …');
    window.markplay.addSubtitle(path).then(function () {
      status('字幕已加载：' + basename(path), 'ok');
      UI.toast('字幕已加载：' + basename(path), { kind: 'success' });
    }).catch(function (err) {
      status('字幕加载失败：' + (err && err.message ? err.message : err), 'error');
    });
  }

  // ---------- 空态：未加载视频时禁用打点 / 导出 / 剪辑 ----------
  function updateEmptyState() {
    var has = !!state.videoPath;
    ['btn-mark-a', 'btn-mark-b', 'btn-mark-c',
     'btn-mark-d', 'btn-mark-f', 'btn-mark-g',
     'btn-fullscreen', 'btn-speed-fwd', 'btn-speed-rev', 'btn-loop',
     'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit',
     'btn-range-in', 'btn-range-out', 'btn-range-from-ab', 'btn-range-adjacent',
     'btn-export-csv', 'btn-export-edl', 'btn-export-rng', 'btn-export-json',
     'btn-play'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !has;
    });
    ['clip-range', 'clip-name', 'clip-reencode', 'clip-merge', 'btn-clip-batch'].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = !has;
    });
    var ph = $('video-placeholder');
    if (ph) ph.style.display = has ? 'none' : 'flex';
    Exporter.refreshClipSelectors(); // 其内部会按标记数量决定剪辑按钮
  }

  function requireVideo() {
    if (!state.videoPath) {
      status('请先打开视频（按 O 或拖拽文件到窗口）', 'error');
      return false;
    }
    return true;
  }

  // ---------- 打开 / 加载 ----------
  function showLoading(on, text) {
    var el = $('loading');
    if (!el) return;
    if (on) {
      var label = el.querySelector('.loading-text');
      if (label && text) label.textContent = text;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function openFile() {
    window.markplay.openFileDialog().then(function (p) {
      if (p) loadVideo(p);
    }).catch(function (err) {
      status('打开文件对话框失败：' + (err && err.message ? err.message : String(err)), 'error');
    });
  }

  function loadVideo(path) {
    showLoading(true, '正在加载：' + basename(path));
    status('正在加载：' + basename(path) + ' …');
    window.markplay.loadVideo(path).then(function (r) {
      if (!r || !r.ok) {
        showLoading(false);
        status('打开失败：' + (r && r.error ? r.error : '未知错误'), 'error');
        return;
      }
      afterVideoOpened(path).then(function () { showLoading(false); });
    }).catch(function (err) {
      showLoading(false);
      status('打开失败：' + (err && err.message ? err.message : String(err)), 'error');
    });
  }

  // 视频已载入后的 UI 刷新（对话框/拖放/菜单/视频窗口拖放共用）
  function afterVideoOpened(path) {
    state.videoPath = path;
    state.currentTime = 0;
    state.duration = 0;
    state.paused = true;
    state.speedMode = 'normal';
    state.looping = false;
    state.fps = 0;
    state.pendingIn = null;
    loopRangeId = null;
    TimelineView.setDuration(0);
    updateSpeedUI();
    updateLoopUI();
    updateFpsLabel();
    updateRangeHint();
    updateZoomLabel();
    document.title = basename(path) + ' — MarkPlay';
    // 换片：清空旧标记，再读新片的 sidecar
    Markers.clear();
    return Markers.loadSidecar(path).then(function (n) {
      updateEmptyState();
      updatePlayhead();
      updateTotal();
      updatePlayBtn();
      updateVideoRect();
      status(n > 0 || Markers.getRanges().length > 0
        ? '已打开：' + basename(path)
          + '（恢复 ' + n + ' 个标记 / ' + Markers.getRanges().length + ' 个区间）'
        : '已打开：' + basename(path), 'ok');
      // 新 mpv 实例是默认音量，把记住的音量重新应用一次
      window.markplay.mpvCommand(['set_property', 'volume', preferredVolume]).catch(function () {});
      // 清掉上一部片子的 A–B 循环点，否则新片会沿用旧时间点
      window.markplay.mpvCommand(['set_property', 'ab-loop-a', 'no']).catch(function () {});
      window.markplay.mpvCommand(['set_property', 'ab-loop-b', 'no']).catch(function () {});
      Scrub.setDuration(0);
      // 主动拉一次时长/暂停态，避免等待首个事件
      window.markplay.mpvGet('duration').then(function (d) {
        if (typeof d === 'number' && d > 0) onDuration(d);
      }).catch(function () {});
      window.markplay.mpvGet('pause').then(function (p) {
        if (typeof p === 'boolean') onPaused(p);
      }).catch(function () {});
      // 帧率：file-loaded 之后一般就有，先主动拉一次
      window.markplay.mpvGet('container-fps').then(function (f) {
        if (typeof f === 'number' && f > 0) onFps(f);
      }).catch(function () {});
    });
  }

  // ---------- 播放控制 ----------
  function togglePlay() {
    if (!requireVideo()) return;
    window.markplay.mpvGet('pause').then(function (paused) {
      return window.markplay.mpvCommand(['set_property', 'pause', !paused]);
    }).catch(function (err) {
      status('播放控制失败：' + (err && err.message ? err.message : String(err)), 'error');
    });
  }

  function seekTo(t) {
    if (!requireVideo()) return;
    t = clamp(t, 0, state.duration > 0 ? state.duration : t);
    window.markplay.mpvCommand(['set_property', 'time-pos', t]).catch(function () {});
    // 本地先行更新，避免等待事件回传的延迟
    state.currentTime = t;
    if (!Scrub.isScrubbing()) updatePlayhead();
  }

  function seekRelative(deltaSec) {
    if (!requireVideo()) return;
    seekTo(state.currentTime + deltaSec);
  }

  function updatePlayBtn() {
    var btn = $('btn-play');
    if (btn) btn.textContent = state.paused ? '▶' : '⏸';
  }

  // ---------- 时间轴缩放 ----------
  function updateZoomLabel() {
    var el = $('zoom-label');
    if (!el) return;
    var s = TimelineView.getState();
    if (s.full) {
      el.textContent = '全片';
    } else {
      el.textContent = '×' + Math.max(1.1, s.duration / s.span).toFixed(1);
    }
    var fit = $('btn-zoom-fit');
    if (fit) fit.disabled = s.full || !state.videoPath;
  }

  /** 缩放锚点：播放头在窗口内就用播放头，否则用窗口中心 */
  function currentViewRatio() {
    if (!(state.duration > 0)) return 0.5;
    var r = TimelineView.toRatio(state.currentTime);
    return (r >= 0 && r <= 1) ? r : 0.5;
  }

  function refreshTimelineView() {
    Markers.renderTimeline();
    Markers.renderRanges();
    updatePlayhead();
    updateZoomLabel();
  }

  function zoomStep(inward) {
    if (!state.videoPath) return;
    var ratio = currentViewRatio();
    if (inward) TimelineView.zoomIn(ratio);
    else TimelineView.zoomOut(ratio);
    refreshTimelineView();
  }

  function zoomFit() {
    if (!state.videoPath) return;
    TimelineView.reset();
    refreshTimelineView();
  }
  // ---------- 时间轴 ----------
  function updatePlayhead() {
    var ratio = state.duration > 0 ? TimelineView.toRatio(state.currentTime) : 0;
    var ph = $('timeline-playhead');
    if (ph) {
      var outside = ratio < -0.0001 || ratio > 1.0001;
      ph.style.display = outside ? 'none' : '';
      ph.style.left = (clamp(ratio, 0, 1) * 100) + '%';
    }
    var tc = $('time-current');
    if (tc) tc.textContent = Exporter.tc(state.currentTime);
  }

  function updateTotal() {
    var el = $('time-total');
    if (el) el.textContent = fmtDur(state.duration);
  }

  /** 导出面板上的"工程帧率"提示：真实 fps + EDL/帧号实际使用的整数帧率 */
  function updateFpsLabel() {
    var el = $('fps-label');
    if (!el) return;
    if (!(state.fps > 0)) {
      el.textContent = '工程帧率：--';
      return;
    }
    var shown = Math.abs(state.fps - Math.round(state.fps)) < 0.001
      ? String(Math.round(state.fps))
      : state.fps.toFixed(3);
    el.textContent = '工程帧率：' + shown + ' fps · EDL/帧号按 '
      + Exporter.nominalFps() + ' fps 换算';
  }

  function seekFromPointerEvent(e) {
    var tl = $('timeline');
    if (!tl || !(state.duration > 0)) return;
    var rect = tl.getBoundingClientRect();
    var ratio = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    seekTo(TimelineView.toTime(ratio));
  }

  function wireTimeline() {
    var tl = $('timeline');
    if (!tl) return;
    // pointer 按住拖拽实时 seek（click 即一次短促拖拽，自然支持点击 seek）
    tl.addEventListener('pointerdown', function (e) {
      if (!requireVideo()) return;
      timelineDragging = true;
      try { tl.setPointerCapture(e.pointerId); } catch (err) {}
      seekFromPointerEvent(e);
      e.preventDefault();
    });
    tl.addEventListener('pointermove', function (e) {
      if (timelineDragging) seekFromPointerEvent(e);
    });
    var end = function () { timelineDragging = false; };
    tl.addEventListener('pointerup', end);
    tl.addEventListener('pointercancel', end);

    // Ctrl+滚轮 = 以鼠标位置为锚点缩放；Shift+滚轮 = 平移窗口。
    // 普通滚轮仍然交给 scrub.js（触摸板推拉快进/后退）。
    tl.addEventListener('wheel', function (e) {
      if (!state.videoPath || !(state.duration > 0)) return;
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();
      if (e.ctrlKey) {
        var rect = tl.getBoundingClientRect();
        var ratio = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        TimelineView.zoomAt(ratio, e.deltaY < 0 ? 1.5 : 1 / 1.5);
      } else {
        TimelineView.panBy((e.deltaY > 0 ? 1 : -1) * TimelineView.getState().span * 0.15);
      }
      refreshTimelineView();
    }, { passive: false });
  }

  // ---------- 视频区定位：告诉主进程把 mpv 子窗口摆到 #video-host 上 ----------
  var lastSentRect = '';
  function updateVideoRect() {
    if (!state.videoPath) return;
    var host = $('video-host');
    if (!host) return;
    var r = host.getBoundingClientRect();
    var rect = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
    // 500ms 轮询会重复送同一个矩形，去重后只在布局真的变化时才发 IPC
    var key = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h;
    if (key === lastSentRect) return;
    lastSentRect = key;
    window.markplay.setVideoRect(rect);
  }

  // ---------- 打点 ----------
  function addMarker(kind) {
    if (!requireVideo()) return;
    var m = Markers.add(kind);
    if (m) status('已打点 ' + m.label + ' @ ' + Exporter.tc(m.time), 'ok');
  }

  // ---------- mpv 事件 ----------
  function onDuration(d) {
    state.duration = d;
    TimelineView.setDuration(d);
    Markers.setDuration(d);
    Scrub.setDuration(d);
    updateTotal();
    updatePlayhead();
    updateZoomLabel();
  }

  function onPaused(paused) {
    state.paused = paused;
    updatePlayBtn();
  }

  function onFps(fps) {
    if (typeof fps !== 'number' || !isFinite(fps) || fps <= 0) return;
    if (Math.abs(fps - state.fps) < 0.0001) return;
    state.fps = fps;
    updateFpsLabel();
  }

  function wireEvents() {
    window.markplay.onEvent(function (ev) {
      if (!ev) return;
      switch (ev.type) {
        case 'mpv-time':
          state.currentTime = ev.t;
          // 通知 scrub：在途 seek 落位后才允许发下一个（latest-only 下发）
          if (Scrub.notifySeekLanded) Scrub.notifySeekLanded(ev.t);
          if (typeof ev.dur === 'number' && ev.dur > 0 && ev.dur !== state.duration) {
            onDuration(ev.dur);
          }
          // scrub 期间或时间轴拖拽期间不回写，避免打架
          if (!Scrub.isScrubbing() && !timelineDragging) {
            // 缩放状态下播放头跑出窗口：把窗口拉回来再重绘
            if (TimelineView.keepVisible(ev.t)) {
              Markers.renderTimeline();
              Markers.renderRanges();
            }
            updatePlayhead();
          }
          break;
        case 'mpv-duration':
          onDuration(ev.dur);
          break;
        case 'mpv-fps':
          onFps(ev.fps);
          break;
        case 'mpv-file-loaded':
          // 文件解析完成：时长现在可靠，顺手清掉"加载中"遮罩
          showLoading(false);
          window.markplay.mpvGet('duration').then(function (d) {
            if (typeof d === 'number' && d > 0) onDuration(d);
          }).catch(function () {});
          break;
        case 'mpv-paused':
          onPaused(!!ev.paused);
          break;
        case 'mpv-ended':
          onPaused(true);
          status('播放结束');
          break;
        case 'mpv-error':
          showLoading(false);
          status('播放错误：' + ev.message, 'error');
          UI.toast('播放错误：' + ev.message, { kind: 'error' });
          break;
        case 'open-failed':
          showLoading(false);
          status('打开失败：' + (ev.message || '未知错误'), 'error');
          UI.toast('打开失败：' + (ev.message || '未知错误'), { kind: 'error' });
          break;
        case 'open-file':
          // 来自应用菜单"文件 > 打开视频" / 最近打开 / 命令行
          if (ev.path) loadVideo(ev.path);
          break;
        case 'video-loaded':
          // 来自视频子窗口的拖放：主进程已载入，这里只刷新 UI
          if (ev.path && ev.path !== state.videoPath) afterVideoOpened(ev.path);
          break;
        case 'subtitle-added':
          status('字幕已加载：' + basename(ev.path || ''), 'ok');
          break;
        case 'surface-dragover':
          // 文件正悬停在视频画面上：提示松开以打开
          showDropHint(true);
          break;
        case 'zoom':
          if (ev.action === 'in') zoomStep(true);
          else if (ev.action === 'out') zoomStep(false);
          else zoomFit();
          break;
        case 'wheel':
          // 视频画面上的 Ctrl/Shift+滚轮（触摸板同样适用）：缩放 / 平移
          if (ev.ctrlKey) {
            zoomStep(ev.deltaY < 0);
          } else if (ev.shiftKey) {
            TimelineView.panBy((ev.deltaY > 0 ? 1 : -1) * TimelineView.getState().span * 0.15);
            refreshTimelineView();
          }
          break;
        case 'speed-mode':
          state.speedMode = ev.mode || 'normal';
          updateSpeedUI();
          break;
        case 'fullscreen':
          state.fullscreen = !!ev.fullscreen;
          break;
        default:
          break; // clip-* 由 export.js 订阅处理
      }
    });
  }

  // ---------- 键盘 ----------
  function isTypingTarget(e) {
    var tag = (e.target && e.target.tagName ? e.target.tagName : '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /** 只有真正能打字的控件（输入框/文本域）才需要让出 [ ] */
  function isEditableTarget(e) {
    var tag = (e.target && e.target.tagName ? e.target.tagName : '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  function wireKeyboard() {
    document.addEventListener('keydown', function (e) {
      // [ ] 建区间：用物理键位 code 判断，避免中文输入法/键盘布局把 e.key
      // 变成 "【" 或 "Process"；焦点在 <select> 上也生效（否则点过区间下拉后快捷键就失效），
      // 但在输入框里仍然让 [ ] 正常打字。
      if (!isEditableTarget(e) && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        if (e.code === 'BracketLeft') markRangeIn();
        else markRangeOut();
        return;
      }
      // 输入框聚焦时：所有快捷键都不触发（否则剪辑名里打不出空格和字母）
      if (isTypingTarget(e)) {
        if (e.code === 'Escape' && state.fullscreen) {
          window.markplay.toggleFullscreen().catch(function () {});
        }
        return;
      }
      // Ctrl/Cmd 组合键（Ctrl+0 / Ctrl+± 在 main 的 before-input-event 里处理）
      if (e.ctrlKey || e.metaKey) {
        var k = e.key ? e.key.toLowerCase() : '';
        if (k === 'z') {
          e.preventDefault();
          var ok = e.shiftKey ? Markers.redo() : Markers.undo();
          status(ok ? (e.shiftKey ? '已重做' : '已撤销') : '没有可' + (e.shiftKey ? '重做' : '撤销') + '的操作');
        }
        return;
      }
      // Space：播放/暂停。preventDefault 防止按钮焦点导致浏览器再触发一次点击
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        return;
      }
      // ESC：全屏时退出全屏
      if (e.code === 'Escape' && state.fullscreen) {
        window.markplay.toggleFullscreen().catch(function () {});
        return;
      }
      var key = e.key ? e.key.toLowerCase() : '';
      switch (key) {
        case 'f11':
          e.preventDefault();
          window.markplay.toggleFullscreen().catch(function () {});
          break;
        case 'x': toggleSpeed('fwd2x'); break;  // 2x 正放 / 恢复
        case 'z': toggleSpeed('rev2x'); break;  // 2x 倒放 / 恢复
        case 'l': toggleLoop(); break;          // A–B 循环
        case '[': case '【': markRangeIn(); e.preventDefault(); break;
        case ']': case '】': markRangeOut(); e.preventDefault(); break;
        case ',': frameStep(-1); e.preventDefault(); break;
        case '.': frameStep(1); e.preventDefault(); break;
        case 'arrowleft':
          seekRelative(-cfg().SEEK_STEP);
          e.preventDefault();
          break;
        case 'arrowright':
          seekRelative(cfg().SEEK_STEP);
          e.preventDefault();
          break;
        case 'a': addMarker('A'); break;
        case 'b': addMarker('B'); break;
        case 'c': addMarker('C'); break;
        case 'd': addMarker('D'); break;
        case 'f': addMarker('F'); break;
        case 'g': addMarker('G'); break;
        case 'delete':
          if (Markers.deleteSelected()) status('已删除选中标记（Ctrl+Z 可撤销）');
          break;
        case 'o': openFile(); break;
        case 'e': {
          var g = $('export-group');
          if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
        default: break;
      }
    });
  }

  // ---------- 按钮 / 音量 ----------
  function wireControls() {
    $('btn-play').addEventListener('click', togglePlay);
    $('btn-open').addEventListener('click', openFile);
    $('btn-fullscreen').addEventListener('click', function () {
      window.markplay.toggleFullscreen().catch(function () {});
    });
    $('btn-speed-fwd').addEventListener('click', function () { toggleSpeed('fwd2x'); });
    $('btn-speed-rev').addEventListener('click', function () { toggleSpeed('rev2x'); });
    $('btn-loop').addEventListener('click', toggleLoop);
    $('btn-zoom-in').addEventListener('click', function () { zoomStep(true); });
    $('btn-zoom-out').addEventListener('click', function () { zoomStep(false); });
    $('btn-zoom-fit').addEventListener('click', zoomFit);
    $('btn-range-in').addEventListener('click', markRangeIn);
    $('btn-range-out').addEventListener('click', markRangeOut);
    $('btn-range-from-ab').addEventListener('click', rangesFromMarkers);
    $('btn-range-adjacent').addEventListener('click', rangesFromAdjacent);
    $('btn-mark-a').addEventListener('click', function () { addMarker('A'); });
    $('btn-mark-b').addEventListener('click', function () { addMarker('B'); });
    $('btn-mark-c').addEventListener('click', function () { addMarker('C'); });
    $('btn-mark-d').addEventListener('click', function () { addMarker('D'); });
    $('btn-mark-f').addEventListener('click', function () { addMarker('F'); });
    $('btn-mark-g').addEventListener('click', function () { addMarker('G'); });
    $('btn-export-csv').addEventListener('click', function () { Exporter.exportAs('csv'); });
    $('btn-export-edl').addEventListener('click', function () { Exporter.exportAs('edl'); });
    $('btn-export-rng').addEventListener('click', function () { Exporter.exportAs('rng'); });
    $('btn-export-json').addEventListener('click', function () { Exporter.exportAs('json'); });
    $('btn-clip').addEventListener('click', function () { Exporter.startClip(); });
    $('btn-clip-batch').addEventListener('click', function () { Exporter.startBatchClip(); });

    // 剪辑面板换区间时，如果 A–B 循环开着，自动把循环点切到新区间
    var rangeSel = $('clip-range');
    if (rangeSel) rangeSel.addEventListener('change', syncLoopWithSelection);

    var mergeChk = $('clip-merge');
    if (mergeChk) {
      mergeChk.addEventListener('change', function () {
        var b = $('btn-clip-batch');
        if (b) b.textContent = mergeChk.checked ? '批量剪辑并合并' : '批量剪辑（按区间）';
      });
    }

    var vol = $('volume');
    if (vol) {
      vol.addEventListener('input', function () {
        var v = clamp(parseInt(vol.value, 10) || 0, 0, 100);
        preferredVolume = v;
        Scrub.setVolumeCache(v);
        window.markplay.mpvCommand(['set_property', 'volume', v]).catch(function () {});
        // 防抖保存，拖动滑块时不要每像素写一次磁盘
        if (volumeSaveTimer) clearTimeout(volumeSaveTimer);
        volumeSaveTimer = setTimeout(function () {
          window.markplay.setSetting('volume', v).catch(function () {});
        }, 400);
      });
    }
  }

  // ---------- 启动 ----------
  /** 把未捕获异常写进主进程日志，避免"界面没反应但查不到原因" */
  function wireCrashLog() {
    window.addEventListener('error', function (e) {
      var msg = (e.error && e.error.stack) || e.message || 'unknown error';
      var where = (e.filename || '') + ':' + (e.lineno || 0);
      if (window.markplay && window.markplay.log) {
        window.markplay.log('error', msg + ' @ ' + where);
      }
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      var msg = (r && r.stack) || (r && r.message) || String(r);
      if (window.markplay && window.markplay.log) {
        window.markplay.log('error', 'unhandledrejection: ' + msg);
      }
    });
  }

  function boot() {
    wireCrashLog();
    wireControls();
    wireTimeline();
    wireEvents();
    wireKeyboard();
    wireDragDrop();
    updateEmptyState();
    updatePlayhead();
    updateTotal();
    updatePlayBtn();
    updateLoopUI();
    updateRangeHint();
    updateZoomLabel();

    window.addEventListener('resize', updateVideoRect);
    // 渲染进程收不到窗口 move 事件：500ms 轮询重发，覆盖移动/布局变化
    setInterval(updateVideoRect, 500);

    // 恢复上次音量
    window.markplay.getSettings().then(function (s) {
      if (s && typeof s.volume === 'number') {
        preferredVolume = clamp(s.volume, 0, 100);
        var vol = $('volume');
        if (vol) vol.value = String(preferredVolume);
        Scrub.setVolumeCache(preferredVolume);
      }
    }).catch(function () {});

    // 版本信息（从主进程取，app.getVersion() 才准确）
    var info = window.markplay.getAppInfo ? window.markplay.getAppInfo() : Promise.resolve(null);
    Promise.resolve(info).then(function (v) {
      if (v && v.version) status('就绪 · MarkPlay ' + v.version);
    }).catch(function () {
      status('就绪');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
