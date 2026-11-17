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
      statusEarly(I18n.t('errors.noBridge'));
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
    pendingIn: null,     // 已按"设入点"但还没设出点的时间（秒），null 表示未设置
    scenes: [],          // 扫描结果 [{t, score}]，仅用于时间轴提示，不是标记
    threshold: 0.4,      // 当前灵敏度阈值，滑动时只在本地过滤
    showScenes: false,   // 是否显示转场浮标
    scanning: false      // 是否正在扫描
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
        el.textContent = I18n.t('ui.ready');
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
    timeProvider: function () { return state.currentTime; },
    fpsProvider: function () { return state.fps; }
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
    if (state.speedMode === 'fwd2x') status(I18n.t('status.playing2x'));
    else if (state.speedMode === 'rev2x') status(I18n.t('status.reversing2x'));
  }

  function toggleSpeed(mode) {
    if (!state.videoPath) return;
    window.markplay.toggleSpeedMode(mode).catch(function (err) {
      status(I18n.t('status.speedFailed', { msg: err && err.message ? err.message : err }), 'error');
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
      el.textContent = I18n.t('ui.pendingInNone');
      el.classList.remove('set');
      return;
    }
    el.textContent = I18n.t('ui.pendingInSet', { tc: Exporter.tc(state.pendingIn) });
    el.classList.add('set');
  }

  function markRangeIn() {
    if (!requireVideo()) return;
    state.pendingIn = state.currentTime;
    updateRangeHint();
    status(I18n.t('status.rangeInSet', { tc: Exporter.tc(state.pendingIn) }), 'ok');
  }

  function markRangeOut() {
    if (!requireVideo()) return;
    if (state.pendingIn == null) {
      status(I18n.t('status.rangeNeedIn'), 'error');
      return;
    }
    var a = state.pendingIn;
    var b = state.currentTime;
    if (!(b > a)) {
      status(I18n.t('status.rangeOutBeforeIn', { tc: Exporter.tc(a) }), 'error');
      return;
    }
    var r = Markers.addRange(a, b);
    if (!r) {
      status(I18n.t('status.rangeCreateFailed'), 'error');
      return;
    }
    state.pendingIn = null;
    updateRangeHint();
    Exporter.refreshClipSelectors();
    selectRange(r.id);
    status(I18n.t('status.rangeCreated', {
      name: r.name, from: Exporter.tc(r.in), to: Exporter.tc(r.out),
    }), 'ok');
    UI.toast(I18n.t('status.rangeCreated', {
      name: r.name, from: Exporter.tc(r.in), to: Exporter.tc(r.out),
    }), { kind: 'success' });
  }

  /** 把老的 A/B 标记批量迁移成区间 */
  function rangesFromMarkers() {
    if (!requireVideo()) return;
    var n = Markers.addRangesFromMarkers();
    if (!n) {
      status(I18n.t('status.rangeNoAB'), 'error');
      return;
    }
    Exporter.refreshClipSelectors();
    UI.toast(I18n.t('status.rangeFromABDone', { n }), { kind: 'success' });
  }

  /** 任意类型：按时间相邻两个标记生成区间（1-2、3-4…） */
  function rangesFromAdjacent() {
    if (!requireVideo()) return;
    var n = Markers.addRangesFromAdjacentMarkers();
    if (!n) {
      status(I18n.t('status.rangeNoAdjacent'), 'error');
      return;
    }
    Exporter.refreshClipSelectors();
    UI.toast(I18n.t('status.rangeAdjacentDone', { n }), { kind: 'success' });
  }

  // ---------- 批量重命名 ----------
  function batchBox() { return $('batch-rename-box'); }

  /** 读表单当前值 */
  function readBatchForm() {
    var scopeEl = $('batch-scope');
    var prefixEl = $('batch-prefix');
    var suffixEl = $('batch-suffix');
    var renumberEl = $('batch-renumber');
    return {
      scope: (scopeEl && scopeEl.value) || 'all',
      prefix: (prefixEl && prefixEl.value) || '',
      suffix: (suffixEl && suffixEl.value) || '',
      renumber: !!(renumberEl && renumberEl.checked),
    };
  }

  /** 用第一条命中的标记演示改名效果 */
  function updateBatchPreview() {
    var el = $('batch-preview');
    if (!el) return;
    var opts = readBatchForm();
    var scope = opts.scope.toUpperCase();
    var targets = Markers.getSorted().filter(function (m) {
      return scope === 'ALL' || m.kind === scope;
    });
    if (!targets.length) {
      el.textContent = I18n.t('ui.batchPreviewNoTarget');
      el.classList.remove('set');
      return;
    }
    var first = targets[0];
    var sample = Markers.composeBatchLabel(first.label, first.kind, 1, opts);
    el.textContent = I18n.t('ui.batchPreviewOne', {
      from: first.label, to: sample, n: targets.length,
    });
    el.classList.add('set');
  }

  function toggleBatchBox(show) {
    var box = batchBox();
    if (!box) return;
    var next = (typeof show === 'boolean') ? show : box.hidden;
    box.hidden = !next;
    if (next) {
      updateBatchPreview();
      var first = $('batch-prefix');
      if (first) first.focus();
    }
  }

  function applyBatchRename() {
    if (!requireVideo()) return;
    var opts = readBatchForm();
    if (!opts.prefix && !opts.suffix && !opts.renumber) {
      status(I18n.t('status.batchNeedField'), 'error');
      return;
    }
    var n = Markers.batchRename(opts);
    if (!n) {
      status(I18n.t('status.batchNoChange'), 'error');
      return;
    }
    toggleBatchBox(false);
    status(I18n.t('status.batchDone', { n }), 'ok');
    UI.toast(I18n.t('status.batchDone', { n }), { kind: 'success' });
  }

  // ---------- 标记文件备份（Ctrl+S） ----------
  var backingUp = false;

  /**
   * 备份当前视频的标记文件。
   * 先把内存里的标记写盘，再复制一份带时间戳的备份——否则备份到的可能是上一次的状态。
   */
  function backupSidecar() {
    if (!requireVideo()) return;
    if (backingUp) return;
    var sidecar = Markers.sidecarPath();
    if (!sidecar) return;

    backingUp = true;
    Markers.saveSidecar()
      .then(function () { return window.markplay.backupSidecar(sidecar); })
      .then(function (r) {
        if (!r || !r.ok) {
          status(I18n.t('status.backupFailed', {
            msg: (r && r.error) || I18n.t('common.unknown'),
          }), 'error');
          return;
        }
        var name = basename(r.path);
        var extra = r.removed > 0 ? I18n.t('status.backupCleaned', { n: r.removed }) : '';
        status(I18n.t('status.backupDone', { name, extra }), 'ok');
        UI.toast(I18n.t('status.backupDone', { name, extra }), {
          kind: 'success',
          actionLabel: I18n.t('ui.revealInFolder'),
          onAction: function () { window.markplay.showItemInFolder(r.path); },
        });
      })
      .catch(function (err) {
        var bmsg = err && err.message ? err.message : String(err);
        status(I18n.t('status.backupFailed', { msg: bmsg }), 'error');
        UI.toast(I18n.t('status.backupFailed', { msg: bmsg }), { kind: 'error' });
      })
      .then(function () { backingUp = false; });
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
      btn.title = I18n.t('ui.loopActiveTitle', { name: Markers.displayRangeName(range) });
    } else {
      btn.textContent = 'A–B';
      btn.title = I18n.t('ui.loopDesc');
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
      status(I18n.t('status.loopOff'));
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
      status(I18n.t('status.loopOn', {
        name: Markers.displayRangeName(range),
        from: Exporter.tc(range.in),
        to: Exporter.tc(range.out),
      }));

    }).catch(function (err) {
      state.looping = false;
      loopRangeId = null;
      updateLoopUI();
      status(I18n.t('status.loopFailed', { msg: err && err.message ? err.message : err }), 'error');
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
      status(I18n.t('status.loopNeedRange'), 'error');
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
      status(I18n.t('status.frameFailed', { msg: err && err.message ? err.message : err }), 'error');
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
  /**
   * 从拖放事件里取出**所有**本地路径（多选拖入时都用得到）。
   * @param {DataTransfer} dt
   * @returns {string[]}
   */
  function extractDropPaths(dt) {
    if (!dt) return [];
    var out = [];

    // 1) File 对象自带 path（Electron 特有）
    if (dt.files && dt.files.length) {
      for (var i = 0; i < dt.files.length; i++) {
        if (dt.files[i].path) out.push(dt.files[i].path);
      }
      if (out.length) return out;
    }

    // 2) text/uri-list（一行一个）
    try {
      var uri = dt.getData('text/uri-list') || '';
      uri.split('\n').forEach(function (line) {
        var s = line.trim();
        if (!s || s.charAt(0) === '#') return;
        if (s.indexOf('file://') !== 0) return;
        var p = decodeURIComponent(new URL(s).pathname);
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
        out.push(p);
      });
    } catch (_) { /* 忽略 */ }

    // 3) 兜底：text/plain 里可能只有一条
    if (!out.length) {
      try {
        var plain = (dt.getData('text/plain') || '').trim();
        if (plain) out.push(plain);
      } catch (_) { /* 忽略 */ }
    }

    return out;
  }

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
      // 拖入多个文件时：交给主进程建列表，并打开第一个
      var paths = extractDropPaths(e.dataTransfer);
      if (!paths.length) {
        status(I18n.t('status.dragNotRecognized'), 'error');
        return;
      }
      if (paths.length > 1) {
        var mediaPaths = paths.filter(function (x) {
          return SUBTITLE_EXTENSIONS.indexOf(extname(x)) < 0;
        });
        if (mediaPaths.length > 1) {
          window.markplay.openVideosFromPaths(mediaPaths).then(function (r) {
            if (r && r.count > 1) {
              status(I18n.t('status.playlistOpened', { n: r.count }), 'ok');
            }
          }).catch(function () {});
          return;
        }
        paths = mediaPaths.length ? mediaPaths : paths;
      }
      var p = paths[0];
      if (SUBTITLE_EXTENSIONS.indexOf(extname(p)) >= 0) {
        loadSubtitle(p);
        return;
      }
      loadVideo(p);
    });
  }

  function loadSubtitle(path) {
    status(I18n.t('status.loadingSubtitle', { name: basename(path) }));
    window.markplay.addSubtitle(path).then(function () {
      status(I18n.t('status.subtitleLoaded', { name: basename(path) }), 'ok');
      UI.toast(I18n.t('status.subtitleLoaded', { name: basename(path) }), { kind: 'success' });
    }).catch(function (err) {
      status(I18n.t('status.subtitleFailed', { msg: err && err.message ? err.message : err }), 'error');
    });
  }

  // ---------- 空态：未加载视频时禁用打点 / 导出 / 剪辑 ----------
  function updateEmptyState() {
    var has = !!state.videoPath;
    ['btn-mark-a', 'btn-mark-b', 'btn-mark-c',
     'btn-mark-d', 'btn-mark-f', 'btn-mark-g', 'btn-batch-rename',
     'btn-fullscreen', 'btn-speed-fwd', 'btn-speed-rev', 'btn-loop', 'btn-scenes',
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
      status(I18n.t('errors.noVideo'), 'error');
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
    // 多选对话框：主进程负责建列表并打开第一个，这里只处理提示
    window.markplay.openVideos().then(function (r) {
      if (!r || r.canceled) return;
      if (r.count > 1) {
        status(I18n.t('status.playlistOpened', { n: r.count }), 'ok');
      }
    }).catch(function (err) {
      status(I18n.t('status.openFailed', { msg: err && err.message ? err.message : String(err) }), 'error');
    });
  }

  function loadVideo(path) {
    showLoading(true, I18n.t('ui.loadingFile', { name: basename(path) }));
    status(I18n.t('status.loading', { name: basename(path) }));
    window.markplay.loadVideo(path).then(function (r) {
      if (!r || !r.ok) {
        showLoading(false);
        status(I18n.t('status.openFailed', { msg: r && r.error ? r.error : I18n.t('common.unknown') }), 'error');
        return;
      }
      afterVideoOpened(path).then(function () {
        showLoading(false);
        maybeResume(path, r && r.resumeAt);
      });
    }).catch(function (err) {
      showLoading(false);
      status(I18n.t('status.openFailed', { msg: err && err.message ? err.message : String(err) }), 'error');
    });
  }

  /**
   * 续播：上次看到一半的视频，打开后自动跳回去。
   *
   * 为什么要等一下再 seek：刚 loadfile 完 mpv 还没解析出时长，
   * 立刻 set time-pos 有时会被忽略。这里等时长事件到了再定位。
   *
   * @param {string} path
   * @param {number} resumeAt 秒；0 表示不续播
   */
  function maybeResume(path, resumeAt) {
    var t = Number(resumeAt);
    if (!(t > 0)) return;

    var done = false;
    function go() {
      if (done) return;
      done = true;
      if (unsubscribe) unsubscribe();
      seekTo(t);
      state.currentTime = t;
      updatePlayhead();
      status(I18n.t('status.resumed', { tc: Exporter.tc(t) }), 'ok');
      UI.toast(I18n.t('status.resumedToast', { tc: Exporter.tc(t) }), {
        kind: 'info',
        actionLabel: I18n.t('ui.startFromBeginning'),
        onAction: function () {
          seekTo(0);
          state.currentTime = 0;
          updatePlayhead();
          if (window.markplay.clearResumePoint) {
            window.markplay.clearResumePoint(path).catch(function () {});
          }
          status(I18n.t('status.restartFromBeginning'), 'ok');
        },
      });
    }

    // 时长已经知道就直接跳；否则等第一次 duration 事件
    var unsubscribe = null;
    if (state.duration > 0) {
      go();
    } else {
      var started = Date.now();
      unsubscribe = window.markplay.onEvent(function (ev) {
        if (ev && ev.type === 'mpv-duration') go();
      });
      // 兜底：1.2 秒还没等到时长就直接跳（部分流媒体没有 duration）
      setTimeout(function () {
        if (!done && Date.now() - started >= 1200) go();
      }, 1300);
    }
  }

  // ---------- 全屏播放状态栏：快照推送 ----------

  /** 状态栏快照的推送定时器（只在状态栏显示时跑） */
  var controlsTimer = 0;

  /**
   * 把当前状态打包成一份快照推给主进程（它再转发给状态栏窗口）。
   * 状态栏没有 Markers / TimelineView / Exporter，所以标记、区间、
   * 转场点和时间轴视图范围都必须由这里提供。
   */
  function pushControlsSnapshot() {
    if (!window.markplay.controlsState) return;
    var view = TimelineView.getState();
    var snapshot = {
      currentTime: state.currentTime,
      duration: state.duration,
      paused: state.paused,
      volume: Math.round(state.volume),
      speedMode: state.speedMode,
      looping: state.looping === true,
      showScenes: state.showScenes === true,
      scenes: visibleSceneTimes(),
      markers: Markers.getSorted().map(function (m) {
        return { label: m.label, time: m.time, color: m.color };
      }),
      ranges: Markers.getRanges().map(function (r) {
        return { name: r.name, in: r.in, out: r.out, color: r.color };
      }),
      view: { start: view.start, end: view.end },
      status: (document.getElementById('status') || {}).textContent || '',
    };
    window.markplay.controlsState(snapshot);
  }

  /** 开始/停止周期推送 */
  function setControlsPushing(on) {
    if (on) {
      if (controlsTimer) return;
      pushControlsSnapshot();
      controlsTimer = setInterval(pushControlsSnapshot, 400);
    } else if (controlsTimer) {
      clearInterval(controlsTimer);
      controlsTimer = 0;
    }
  }

  // ---------- 全屏播放状态栏：执行命令 ----------

  /**
   * 状态栏窗口发来的命令，在这里落到已有的函数上。
   * @param {string} name
   * @param {any} arg
   */
  function runControlCommand(name, arg) {
    switch (name) {
      case 'toggle-play': togglePlay(); break;
      case 'seek': seekTo(Number(arg)); break;
      case 'volume':
        if (window.markplay.mpvCommand) {
          window.markplay.mpvCommand(['set_property', 'volume', Math.round(Number(arg))]).catch(function () {});
        }
        break;
      case 'toggle-fullscreen':
        window.markplay.toggleFullscreen().catch(function () {});
        break;
      case 'speed-fwd': toggleSpeed('fwd2x'); break;
      case 'speed-rev': toggleSpeed('rev2x'); break;
      case 'toggle-loop': toggleLoop(); break;
      case 'toggle-scenes': toggleScenes(); break;
      case 'zoom-in': zoomStep(true); break;
      case 'zoom-out': zoomStep(false); break;
      case 'zoom-fit': zoomFit(); break;
      case 'open': openFile(); break;
      case 'playlist': window.markplay.togglePlaylist().catch(function () {}); break;
      default: break;
    }
    // 命令改变了状态，立刻回推一份，界面不用等下一个 400ms
    pushControlsSnapshot();
  }

  // 视频已载入后的 UI 刷新（对话框/拖放/菜单/视频窗口拖放共用）
  function afterVideoOpened(path) {
    state.videoPath = path;

    // 告诉主进程当前文件变了，文件列表据此高亮（不在列表里会被追加进去）
    if (window.markplay.notePlaylistCurrent) {
      window.markplay.notePlaylistCurrent(path).catch(function () {});
    }
    state.currentTime = 0;
    state.duration = 0;
    state.paused = true;
    state.speedMode = 'normal';
    state.looping = false;
    state.fps = 0;
    state.pendingIn = null;
    state.scenes = [];
    state.showScenes = false;
    state.scanning = false;
    loopRangeId = null;
    TimelineView.setDuration(0);
    updateSpeedUI();
    updateLoopUI();
    updateFpsLabel();
    updateRangeHint();
    updateZoomLabel();
    renderScenes();
    updateSceneButton();
    updateScenePanel();
    showScenePanel(false);
    document.title = basename(path) + ' — MarkPlay';
    // 换片：清空旧标记，再读新片的 sidecar
    Markers.clear();
    return Markers.loadSidecar(path).then(function (n) {
      updateEmptyState();
      updatePlayhead();
      updateTotal();
      updatePlayBtn();
      updateVideoRect();
      status((n > 0 || Markers.getRanges().length > 0)
        ? I18n.t('status.openedWith', {
            name: basename(path), markers: n, ranges: Markers.getRanges().length,
          })
        : I18n.t('status.opened', { name: basename(path) }), 'ok');
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
      status(I18n.t('status.playFailed', { msg: err && err.message ? err.message : String(err) }), 'error');
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
      el.textContent = I18n.t('ui.zoomFull');
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
    renderScenes();
    updatePlayhead();
    updateZoomLabel();
  }

  // ---------- 转场提示浮标 ----------

  /**
   * 当前阈值下命中的转场时间（升序）。
   * 主进程一次扫描返回全部帧的分数，这里只做过滤，所以拖动阈值是即时的。
   */
  function visibleSceneTimes() {
    return Scenes.filterByThreshold(state.scenes, state.threshold);
  }

  /** 重画时间轴上的转场浮标（只提示，不是标记） */
  function renderScenes() {
    var layer = $('scene-bubbles');
    if (!layer) return;
    layer.innerHTML = '';
    if (!state.showScenes || !(state.duration > 0) || !state.scenes.length) return;

    var tl = $('timeline');
    if (!tl) return;
    var widthPx = tl.getBoundingClientRect().width;
    var view = TimelineView.getState();
    var keep = Scenes.thin(visibleSceneTimes(), view, widthPx);

    keep.forEach(function (t) {
      var ratio = TimelineView.toRatio(t);
      var b = document.createElement('div');
      b.className = 'scene-bubble';
      b.style.left = (ratio * 100) + '%';
      b.dataset.tip = I18n.t('ui.sceneTip', { tc: Exporter.tc(t) });
      b.title = I18n.t('ui.sceneTitle', { tc: Exporter.tc(t) });
      b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        seekTo(t);
      });
      layer.appendChild(b);
    });
  }

  function updateSceneButton() {
    var btn = $('btn-scenes');
    if (!btn) return;
    var hits = state.scenes.length ? visibleSceneTimes().length : 0;
    btn.classList.toggle('active', state.showScenes);
    btn.classList.toggle('busy', state.scanning);
    if (state.scanning) {
      btn.textContent = I18n.t('ui.scenesScanning');
      btn.title = I18n.t('ui.scenesScanningTitle');
    } else if (state.scenes.length && state.showScenes) {
      btn.textContent = I18n.t('ui.scenesCount', { n: hits });
      btn.title = I18n.t('ui.scenesActiveTitle', { th: state.threshold.toFixed(2), n: hits });

    } else if (state.scenes.length) {
      btn.textContent = I18n.t('ui.scenes');
      btn.title = I18n.t('ui.scenesHasDataTitle', { n: state.scenes.length });
    } else {
      btn.textContent = I18n.t('ui.scenes');
      btn.title = I18n.t('ui.scenesDesc');
    }
  }

  /**
   * 扫描完成后的收尾：当前阈值一处都没命中时，自动降到"能命中若干处"的档位。
   * 行车记录仪这类连续运动的素材帧间差异普遍很小，0.4 这种默认值往往一个都不过。
   */
  function afterSceneDetected(cached) {
    var total = state.scenes.length;
    if (!total) {
      status(I18n.t('status.scenesNoFrames'));
      return;
    }
    var hits = visibleSceneTimes().length;
    if (hits > 0) {
      status(I18n.t('status.scenesFound', {
        total, th: state.threshold.toFixed(2), hits,
        cached: cached ? I18n.t('status.scenesCached') : '',
      }), 'ok');
      return;
    }

    var suggested = Scenes.suggestThreshold(state.scenes, 8);
    if (suggested && suggested > 0.01) {
      state.threshold = Math.min(0.9, Math.max(0.02, suggested));
      renderScenes();
      updateSceneButton();
      updateScenePanel();
      var next = visibleSceneTimes().length;
      status(I18n.t('status.scenesAutoLower', {
        from: '0.40', to: state.threshold.toFixed(2), n: next,
      }), next ? 'ok' : 'normal');
      return;
    }
    status(I18n.t('status.scenesAllWeak', { n: total }));
  }

  /** 同步灵敏度面板上的数值与提示 */
  function updateScenePanel() {
    var slider = $('scene-threshold');
    var valueEl = $('scene-threshold-value');
    var hintEl = $('scene-threshold-hint');
    if (slider) slider.value = String(state.threshold);
    if (valueEl) valueEl.textContent = state.threshold.toFixed(2);
    if (!hintEl) return;

    if (!state.scenes.length) {
      hintEl.textContent = I18n.t('ui.scenePanelNotScanned');
      return;
    }
    var hits = visibleSceneTimes().length;
    var total = state.scenes.length;
    if (hits === 0) {
      hintEl.textContent = I18n.t('ui.scenePanelNoHit', { total });
      hintEl.classList.add('set');
    } else {
      hintEl.textContent = I18n.t('ui.scenePanelHits', { total, hits });
      hintEl.classList.remove('set');
    }
  }

  function showScenePanel(show) {
    var panel = $('scene-panel');
    if (!panel) return;
    panel.hidden = !show;
    if (show) updateScenePanel();
  }

  /** 拖动灵敏度：即时过滤 + 重画，不重扫 */
  function onThresholdInput() {
    var slider = $('scene-threshold');
    if (!slider) return;
    var v = Number(slider.value);
    if (!isFinite(v)) return;
    state.threshold = Math.min(0.99, Math.max(0.01, v));
    state.showScenes = true;
    renderScenes();
    updateSceneButton();
    updateScenePanel();
  }

  function startSceneScan(force) {
    if (!requireVideo()) return;
    if (state.scanning) return;
    if (force) {
      state.scenes = [];
      state.showScenes = false;
    }
    state.scanning = true;
    updateSceneButton();
    updateScenePanel();
    status(I18n.t('status.scenesScanning'));
    window.markplay.detectScenes().then(function (r) {
      if (!r || !r.ok) {
        state.scanning = false;
        updateSceneButton();
        status(I18n.t('status.scenesFailed', {
          msg: (r && r.error) || I18n.t('common.unknown'),
        }), 'error');
      }
    }).catch(function (err) {
      state.scanning = false;
      updateSceneButton();
      status(I18n.t('status.scenesFailed', {
        msg: err && err.message ? err.message : String(err),
      }), 'error');
    });
  }

  function cancelSceneScan() {
    window.markplay.cancelScenes().catch(function () {});
    state.scanning = false;
    updateSceneButton();
    status(I18n.t('status.scenesCancelled'));
  }

  /** 跳到上一个/下一个转场提示点（只跳转，不打点） */
  function jumpToScene(dir) {
    var times = visibleSceneTimes();
    var t = Scenes.nearest(times, state.currentTime, dir);
    if (t == null) {
      status(I18n.t(dir === 'prev' ? 'status.noScenePrev' : 'status.noSceneNext'));
      return;
    }
    seekTo(t);
    status(I18n.t('status.jumpScene', { tc: Exporter.tc(t) }));
  }

  /** 转场按钮：没扫过就扫，扫过就切换显示 */
  function toggleScenes() {
    if (!requireVideo()) return;
    if (state.scanning) { cancelSceneScan(); return; }
    if (state.scenes.length) {
      state.showScenes = !state.showScenes;
      renderScenes();
      updateSceneButton();
      updateScenePanel();
      var hits = visibleSceneTimes().length;
      status(state.showScenes
        ? (hits ? I18n.t('status.scenesShown', { n: hits }) : I18n.t('status.scenesShownNone'))
        : I18n.t('status.scenesHidden'));
      if (state.showScenes) showScenePanel(true);
      return;
    }
    showScenePanel(true);
    startSceneScan();
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
      el.textContent = I18n.t('ui.fpsUnknown');
      return;
    }
    var shown = Math.abs(state.fps - Math.round(state.fps)) < 0.001
      ? String(Math.round(state.fps))
      : state.fps.toFixed(3);
    el.textContent = I18n.t('ui.fpsKnown', { fps: shown, nominal: Exporter.nominalFps() });
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
    if (m) status(I18n.t('status.addedMarker', { label: m.label, tc: Exporter.tc(m.time) }), 'ok');
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
    renderScenes();
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
          status(I18n.t('status.playbackEnded'));
          break;
        case 'mpv-error':
          showLoading(false);
          status(I18n.t('status.playFailed', { msg: ev.message }), 'error');
          UI.toast(I18n.t('status.playFailed', { msg: ev.message }), { kind: 'error' });
          break;
        case 'open-failed':
          showLoading(false);
          var ofmsg = ev.message || I18n.t('common.unknown');
          status(I18n.t('status.openFailed', { msg: ofmsg }), 'error');
          UI.toast(I18n.t('status.openFailed', { msg: ofmsg }), { kind: 'error' });
          break;
        case 'open-file':
          // 来自应用菜单"文件 > 打开视频" / 最近打开 / 命令行
          if (ev.path) loadVideo(ev.path);
          break;
        case 'video-loaded':
          // 来自视频子窗口的拖放：主进程已载入，这里只刷新 UI
          if (ev.path && ev.path !== state.videoPath) {
            afterVideoOpened(ev.path).then(function () { maybeResume(ev.path, ev.resumeAt); });
          }
          break;
        case 'subtitle-added':
          status(I18n.t('status.subtitleLoaded', { name: basename(ev.path || '') }), 'ok');
          break;
        case 'backup-sidecar':
          // 菜单「文件 → 备份标记文件」(Ctrl+S) 触发
          backupSidecar();
          break;
        case 'scene-start':
          state.scanning = true;
          updateSceneButton();
          updateScenePanel();
          break;
        case 'scene-progress':
          status(I18n.t('status.scenesProgress', {
            frames: ev.frames || 0,
            pos: ev.scannedTo > 0 ? I18n.t('status.scenesProgressPos', { tc: Exporter.tc(ev.scannedTo) }) : '',
            sec: ev.elapsedSec,
          }));
          break;
        case 'scene-detected':
          state.scanning = false;
          state.scenes = Array.isArray(ev.scores) ? ev.scores : [];
          state.showScenes = true;
          renderScenes();
          updateSceneButton();
          updateScenePanel();
          showScenePanel(true);
          afterSceneDetected(ev.cached === true);
          break;
        case 'scene-cancelled':
          state.scanning = false;
          updateSceneButton();
          updateScenePanel();
          break;
        case 'scene-error':
          state.scanning = false;
          updateSceneButton();
          status(I18n.t('status.scenesFailed', { msg: ev.message }), 'error');
          UI.toast(I18n.t('status.scenesFailed', { msg: ev.message }), { kind: 'error' });
          break;
        case 'surface-dragover':
          // 文件正悬停在视频画面上：提示松开以打开
          showDropHint(true);
          break;
        case 'playlist-state': {
          // 主进程才是显隐的拥有者（全屏悬浮也会改它），图标跟着走
          var pb = $('btn-playlist');
          if (pb) pb.classList.toggle('active', ev.visible === true);
          break;
        }
        case 'zoom':
          if (ev.action === 'in') zoomStep(true);
          else if (ev.action === 'out') zoomStep(false);
          else zoomFit();
          break;
        case 'rev-coarse':
          // 倒放退化成"按关键帧大步跳"（TS 这类无索引格式）。
          // 不说明的话用户会以为倒放坏了。
          if (ev.failed) {
            status(I18n.t('status.revUnsupported'), 'error');
            UI.toast(I18n.t('status.revUnsupported'), { kind: 'error' });
          } else {
            status(I18n.t('status.revCoarse', {
              step: (Number(ev.step) || 0).toFixed(1),
            }));
          }
          break;
        case 'controls-shown':
          // 状态栏显示中才持续推快照，避免平时无谓的 IPC
          setControlsPushing(ev.visible === true);
          break;
        case 'controls-need-snapshot':
          pushControlsSnapshot();
          break;
        case 'control-command':
          runControlCommand(ev.name, ev.arg);
          break;
        case 'language-changed':
          // 主进程换语言后：重刷静态文案 + 重绘 JS 生成的内容，不重载页面
          I18n.setLanguage(ev.language);
          status(I18n.t('locale.switched', { name: ev.name }), 'ok');
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
          status(ok
            ? I18n.t(e.shiftKey ? 'status.redone' : 'status.undone')
            : I18n.t(e.shiftKey ? 'status.nothingToRedo' : 'status.nothingToUndo'));
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
          // 有转场提示时，Shift+← 跳到上一个转场；否则按普通步长后退
          if (e.shiftKey && state.showScenes && state.scenes.length) {
            jumpToScene('prev');
          } else {
            seekRelative(-cfg().SEEK_STEP);
          }
          e.preventDefault();
          break;
        case 'arrowright':
          if (e.shiftKey && state.showScenes && state.scenes.length) {
            jumpToScene('next');
          } else {
            seekRelative(cfg().SEEK_STEP);
          }
          e.preventDefault();
          break;
        case 'a': addMarker('A'); break;
        case 'b': addMarker('B'); break;
        case 'c': addMarker('C'); break;
        case 'd': addMarker('D'); break;
        case 'f': addMarker('F'); break;
        case 'g': addMarker('G'); break;
        case 'delete':
          if (Markers.deleteSelected()) status(I18n.t('status.deletedMarker'));
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

    // 文件列表：图标点击 = 切换显示；真正的显隐由主进程决定
    var playlistBtn = $('btn-playlist');
    if (playlistBtn) {
      playlistBtn.addEventListener('click', function () {
        window.markplay.togglePlaylist().then(function (r) {
          playlistBtn.classList.toggle('active', !!(r && r.visible));
        }).catch(function () {});
      });
    }
    $('btn-speed-fwd').addEventListener('click', function () { toggleSpeed('fwd2x'); });
    $('btn-speed-rev').addEventListener('click', function () { toggleSpeed('rev2x'); });
    $('btn-loop').addEventListener('click', toggleLoop);
    $('btn-scenes').addEventListener('click', toggleScenes);

    // 语言切换：交给主进程改设置 + 重建菜单，再回来重刷界面
    var langBtn = $('btn-lang');
    if (langBtn) {
      langBtn.addEventListener('click', function () {
        var next = I18n.currentLanguage() === 'zh-CN' ? 'en-US' : 'zh-CN';
        window.markplay.switchLanguage(next);
      });
    }

    // 转场灵敏度面板：拖动即时过滤，不需要重扫
    var thr = $('scene-threshold');
    if (thr) {
      thr.value = String(state.threshold);
      thr.addEventListener('input', onThresholdInput);
      thr.addEventListener('change', onThresholdInput);
    }
    var rescan = $('btn-scene-rescan');
    if (rescan) rescan.addEventListener('click', function () { startSceneScan(true); });
    var sceneClose = $('btn-scene-close');
    if (sceneClose) sceneClose.addEventListener('click', function () { showScenePanel(false); });
    $('btn-zoom-in').addEventListener('click', function () { zoomStep(true); });
    $('btn-zoom-out').addEventListener('click', function () { zoomStep(false); });
    $('btn-zoom-fit').addEventListener('click', zoomFit);
    $('btn-range-in').addEventListener('click', markRangeIn);
    $('btn-range-out').addEventListener('click', markRangeOut);
    $('btn-range-from-ab').addEventListener('click', rangesFromMarkers);
    $('btn-range-adjacent').addEventListener('click', rangesFromAdjacent);

    // 批量重命名表单
    var batchBtn = $('btn-batch-rename');
    if (batchBtn) batchBtn.addEventListener('click', function () { toggleBatchBox(); });
    ['batch-scope', 'batch-prefix', 'batch-suffix', 'batch-renumber'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', updateBatchPreview);
      el.addEventListener('change', updateBatchPreview);
    });
    var applyBtn = $('btn-batch-apply');
    if (applyBtn) applyBtn.addEventListener('click', applyBatchRename);
    var cancelBtn = $('btn-batch-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { toggleBatchBox(false); });
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
        if (b) b.textContent = I18n.t(mergeChk.checked ? 'ui.clipBatchMerge' : 'ui.clipBatch');
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
    // 首帧就把标注过的文案换成当前语言（preload 已经注入正确语言，不会闪）
    I18n.applyI18n();

    // 语言切换后 JS 生成的内容要重绘（列表、fps 标签、按钮状态等）
    I18n.onLanguageChange(function () {
      Markers.renderList();
      Markers.renderRanges();
      renderScenes();
      updateSceneButton();
      updateScenePanel();
      updateFpsLabel();
      updateLoopUI();
      updateZoomLabel();
      updateRangeHint();
      updatePlayBtn();
    });

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
    updateSceneButton();
    updateScenePanel();

    // 时间轴宽度变化（窗口缩放）后浮标可能过密/过疏，重画一次
    window.addEventListener('resize', renderScenes);

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
      if (v && v.version) status(I18n.t('status.readyVersion', { version: v.version }));
    }).catch(function () {
      status(I18n.t('ui.ready'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
