/* markers.js —— 打点标记 / 区间的数据、渲染与 sidecar 持久化
 *
 * 数据模型：
 *  - 标记（单点）：[{ id, label, time, color, kind }]
 *      label 如 "A1" / "B2"；kind 为 'A'|'B'|'C'|'D'|'F'|'G'，计数器每种独立递增
 *  - 区间（成对 in/out）：[{ id, name, in, out, color }]
 *      批量剪辑、EDL 导出都以区间为准，不再依赖"A/B 标记隐含配对"
 *  - color 取自 window.markplay.config.MARKER_COLORS（区间用强调色）
 * sidecar 文件：<视频路径>.markplay.json（直接追加在原文件名后，避免 a.mp4 / a.mkv 互相覆盖），
 * 格式 {version:2, video:basename, markers:[...], ranges:[...]}（v1 没有 ranges，读取时兼容）
 *
 * 由 renderer.js 通过 Markers.init({onSeek, onChange, timeProvider}) 接线。
 * 交互：单击跳转、双击标签内联重命名、拖动时间轴上的刻度改时间、Ctrl+Z 撤销。
 */

/* 全局命名空间 */
var Markers = (function () {
  'use strict';

  var SIDECAR_VERSION = 2;

  // ---- 内部状态 ----
  var items = [];                       // 全部标记
  var ranges = [];                      // 全部区间 { id, name, in, out, color }
  var counters = { A: 0, B: 0, C: 0, D: 0, F: 0, G: 0 };  // 每种 kind 独立的序号计数器
  var selectedId = null;                // 时间轴 / 列表中选中的标记 id
  var videoPath = '';                   // 当前视频完整路径
  var duration = 0;                     // 视频时长（秒），用于刻度定位
  var undoStack = [];                   // 撤销快照（JSON 字符串）
  var redoStack = [];                   // 重做快照
  var loadToken = 0;                    // sidecar 加载令牌，防止并发加载重复追加

  var onSeek = function () {};          // 跳转回调（renderer 注入）
  var onChange = function () {};        // 变更回调（renderer 注入，如刷新剪辑下拉）
  var timeProvider = function () { return 0; }; // 当前播放时间（renderer 注入）

  function colors() { return window.markplay.config.MARKER_COLORS; }

  function historyLimit() {
    var cfg = window.markplay && window.markplay.config;
    var n = cfg && cfg.HISTORY_LIMIT;
    return typeof n === 'number' && n > 0 ? n : 50;
  }

  function nextId() {
    return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  // 秒 → "HH:MM:SS.mmm"
  function fmtTc(sec) {
    sec = Math.max(0, sec || 0);
    var ms = Math.floor((sec % 1) * 1000);
    var s = Math.floor(sec);
    var hh = String(Math.floor(s / 3600)).padStart(2, '0');
    var mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    var ss = String(s % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss + '.' + String(ms).padStart(3, '0');
  }

  function basename(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function sidecarPath() {
    return videoPath ? videoPath + '.markplay.json' : '';
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // ---- 虚拟列表 ----
  // 列表只渲染视口内的项，1000+ 标记时也不会卡。行高必须和 CSS 一致。
  var LIST_ITEM_H = 34;
  var RANGE_ITEM_H = 46;

  /**
   * 把 list 渲染成"只画可见行"的滚动列表。
   * @param {HTMLElement} ul 滚动容器（CSS 需要 position:relative + 固定高度）
   * @param {Array} list
   * @param {number} itemH 行高
   * @param {(item:any, index:number)=>HTMLElement} build 构建单行
   */
  function renderVirtual(ul, list, itemH, build) {
    var scrollTop = ul.scrollTop || 0;
    ul.innerHTML = '';
    if (!list.length) return;

    var viewH = ul.clientHeight || 240;
    // 关键：所有行放进"撑高度"的 spacer 里，由 spacer 随内容一起滚动；
    // 如果把绝对定位行直接挂在滚动容器上，它们会固定在可视区不随滚动移动。
    var spacer = document.createElement('div');
    spacer.className = 'list-spacer';
    spacer.style.position = 'relative';
    spacer.style.width = '100%';
    spacer.style.height = (list.length * itemH) + 'px';
    ul.appendChild(spacer);

    var first = Math.max(0, Math.floor(scrollTop / itemH) - 2);
    var last = Math.min(list.length, Math.ceil((scrollTop + viewH) / itemH) + 2);
    for (var i = first; i < last; i++) {
      var row = build(list[i], i);
      row.style.position = 'absolute';
      row.style.left = '0';
      row.style.right = '0';
      row.style.top = (i * itemH) + 'px';
      row.style.height = itemH + 'px';
      spacer.appendChild(row);
    }
    // innerHTML='' 会把滚动位置清零，恢复回去
    ul.scrollTop = scrollTop;
  }

  /**
   * 行数不多时直接全量渲染：窗口缩放后不需要重新计算可视区间，
   * 也不会出现"只画了前几行、剩下的被虚拟化漏掉"的问题。
   */
  function renderSimple(ul, list, itemH, build) {
    var scrollTop = ul.scrollTop || 0;
    ul.innerHTML = '';
    list.forEach(function (item) {
      var row = build(item);
      row.style.height = itemH + 'px';
      ul.appendChild(row);
    });
    ul.scrollTop = scrollTop;
  }

  var SIMPLE_LIMIT = 200;

  /** 滚动时按帧节流重绘（只重绘对应列表） */
  var scrollRaf = 0;
  function bindListScroll() {
    var markerUl = document.getElementById('marker-list');
    var rangeUl = document.getElementById('range-list');

    function onScroll(which) {
      var ul = which === 'marker' ? markerUl : rangeUl;
      if (!ul) return;
      var itemH = which === 'marker' ? LIST_ITEM_H : RANGE_ITEM_H;
      // 重绘会把 innerHTML 清空再恢复 scrollTop，可能再触发 scroll 事件；
      // 用"可视区间没变就不重绘"来打断这个循环。
      var key = Math.floor(ul.scrollTop / itemH) + ':' +
        Math.ceil((ul.scrollTop + ul.clientHeight) / itemH);
      if (ul.dataset.vrange === key) return;
      ul.dataset.vrange = key;

      if (scrollRaf) return;
      var raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : function (fn) { setTimeout(fn, 16); };
      scrollRaf = raf(function () {
        scrollRaf = 0;
        if (which === 'marker') renderList();
        else renderRanges();
      });
    }

    if (markerUl && !markerUl.dataset.scrollBound) {
      markerUl.dataset.scrollBound = '1';
      markerUl.addEventListener('scroll', function () { onScroll('marker'); }, { passive: true });
    }
    if (rangeUl && !rangeUl.dataset.scrollBound) {
      rangeUl.dataset.scrollBound = '1';
      rangeUl.addEventListener('scroll', function () { onScroll('range'); }, { passive: true });
    }
  }

  // ---- 撤销 / 重做 ----

  function snapshot() {
    return JSON.stringify({ items: items, ranges: ranges, counters: counters });
  }

  /** 记录一次可撤销的变更（在真正修改数据之前调用） */
  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > historyLimit()) undoStack.shift();
    redoStack.length = 0;
  }

  function applySnapshot(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return false;
    }
    if (!data || !Array.isArray(data.items)) return false;
    items = data.items;
    ranges = Array.isArray(data.ranges) ? data.ranges : [];
    counters = Object.assign({ A: 0, B: 0, C: 0, D: 0, F: 0, G: 0 }, data.counters || {});
    if (!getById(selectedId)) selectedId = null;
    renderTimeline();
    renderList();
    renderRanges();
    try { onChange(); } catch (e) { /* 回调异常不影响主流程 */ }
    return true;
  }

  function undo() {
    if (!undoStack.length) return false;
    var current = snapshot();
    if (!applySnapshot(undoStack.pop())) return false;
    redoStack.push(current);
    saveSidecar();
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    var current = snapshot();
    if (!applySnapshot(redoStack.pop())) return false;
    undoStack.push(current);
    saveSidecar();
    return true;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  /** 给"拖动"这类连续操作手动压一个撤销点（只在第一次移动时调用） */
  function beginEdit() {
    pushHistory();
  }

  // ---- 数据操作 ----

  // 在当前播放时间打一个 kind 点（kind: 'A'|'B'|'C'|'D'|'F'|'G'；E 留给导出快捷键）
  function add(kind) {
    kind = String(kind || '').toUpperCase();
    if ('ABCDFG'.indexOf(kind) < 0) return null;
    if (!videoPath) return null; // 未打开视频时拒绝打点
    var t = Math.max(0, timeProvider());
    if (duration > 0) t = Math.min(t, duration);
    pushHistory();
    counters[kind] += 1;
    var m = {
      id: nextId(),
      label: kind + counters[kind],
      time: t,
      color: colors()[kind],
      kind: kind
    };
    items.push(m);
    selectedId = m.id;
    afterChange(true);
    return m;
  }

  function remove(id) {
    var i = items.findIndex(function (m) { return m.id === id; });
    if (i < 0) return false;
    pushHistory();
    items.splice(i, 1);
    if (selectedId === id) selectedId = null;
    afterChange(true);
    return true;
  }

  function rename(id, label) {
    var m = getById(id);
    if (!m) return false;
    label = String(label || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!label || label === m.label) return false;
    pushHistory();
    m.label = label.slice(0, 40);
    afterChange(true);
    return true;
  }

  /**
   * 直接设置标记时间（拖动刻度用）。
   * @param {string} id
   * @param {number} t 秒
   * @param {{render?: boolean}} [opts] render=false 时只改数据不重绘（拖动中逐帧省性能）
   */
  function setTime(id, t, opts) {
    var m = getById(id);
    if (!m || typeof t !== 'number' || !isFinite(t)) return false;
    m.time = clamp(t, 0, duration > 0 ? duration : t);
    if (!opts || opts.render !== false) {
      renderTimeline();
      renderList();
      try { onChange(); } catch (e) { /* 忽略 */ }
    }
    return true;
  }

  function deleteSelected() {
    if (!selectedId) return false;
    return remove(selectedId);
  }

  // ---- 区间（显式 [in, out]，批量剪辑/EDL 以它为准） ----

  function nextRangeId() {
    return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  /** 区间配色：按加入顺序循环取色，避免和时间轴标记的 A–G 配色混淆 */
  function rangeColor(index) {
    var palette = ['#40c4ff', '#69f0ae', '#ffd740', '#ea80fc', '#8c9eff', '#ff8a65'];
    return palette[index % palette.length];
  }

  /**
   * 新建一个区间。
   * @param {number} inT 入点（秒）
   * @param {number} outT 出点（秒），必须大于入点
   * @param {string} [name] 名称，缺省为"区间 N"
   * @returns {object|null} 新区间；参数非法或没有视频时返回 null
   */
  function addRange(inT, outT, name) {
    if (!videoPath) return null;
    var limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
    var a = clamp(Number(inT), 0, limit);
    var b = clamp(Number(outT), 0, limit);
    if (!isFinite(a) || !isFinite(b) || !(b > a)) return null;
    pushHistory();
    var r = {
      id: nextRangeId(),
      name: (name && String(name).trim()) || ('区间 ' + (ranges.length + 1)),
      in: a,
      out: b,
      color: rangeColor(ranges.length),
    };
    ranges.push(r);
    afterChange(true);
    return r;
  }

  function removeRange(id) {
    var i = ranges.findIndex(function (r) { return r.id === id; });
    if (i < 0) return false;
    pushHistory();
    ranges.splice(i, 1);
    afterChange(true);
    return true;
  }

  /**
   * 调整区间某一端（拖动边界用）。
   * @param {string} id
   * @param {'in'|'out'} edge
   * @param {number} t 目标时间（秒）
   * @param {{render?: boolean}} [opts]
   */
  function setRangeBoundary(id, edge, t, opts) {
    var r = getRangeById(id);
    if (!r || typeof t !== 'number' || !isFinite(t)) return false;
    var limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
    var v = clamp(t, 0, limit);
    var MIN = 0.05;
    if (edge === 'in') {
      r.in = Math.max(0, Math.min(v, r.out - MIN));
    } else {
      r.out = Math.min(limit, Math.max(v, r.in + MIN));
    }
    if (!opts || opts.render !== false) {
      renderRanges();
      try { onChange(); } catch (e) { /* 忽略 */ }
    }
    return true;
  }

  function renameRange(id, name) {
    var r = getRangeById(id);
    if (!r) return false;
    var next = String(name || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!next || next === r.name) return false;
    pushHistory();
    r.name = next.slice(0, 60);
    afterChange(true);
    return true;
  }

  function getRangeById(id) {
    return ranges.find(function (r) { return r.id === id; }) || null;
  }

  /** 按入点排序返回副本 */
  function getRanges() {
    return ranges.slice().sort(function (a, b) { return a.in - b.in; });
  }

  /**
   * 把现有 A/B 标记两两配对（每个 A 配它后面最近的未使用 B），
   * 一次性生成区间。用于兼容老项目"只打了 A/B 点"的数据。
   * @returns {number} 生成的数量
   */
  function addRangesFromMarkers() {
    if (!videoPath) return 0;
    var sorted = getSorted();
    var usedB = {};
    var pairs = [];
    sorted.forEach(function (m, i) {
      if (m.kind !== 'A') return;
      for (var j = i + 1; j < sorted.length; j++) {
        if (sorted[j].kind === 'B' && !usedB[j]) {
          usedB[j] = true;
          pairs.push([m.time, sorted[j].time]);
          break;
        }
      }
    });
    if (!pairs.length) return 0;

    pushHistory();
    var base = ranges.length;
    pairs.forEach(function (pair, idx) {
      ranges.push({
        id: nextRangeId(),
        name: '区间 ' + (base + idx + 1),
        in: pair[0],
        out: pair[1],
        color: rangeColor(base + idx),
      });
    });
    afterChange(true);
    return pairs.length;
  }

  /**
   * 按时间顺序把相邻两个标记（1-2、3-4…）配成区间，**不区分标记类型**。
   * 适合 C/D/F/G 等任意标记：A1,B1,C1,D1 会生成 A1–B1 与 C1–D1；
   * 已经存在完全相同的区间会跳过，避免重复。
   * @returns {number} 新建的数量
   */
  function addRangesFromAdjacentMarkers() {
    if (!videoPath) return 0;
    var sorted = getSorted();
    if (sorted.length < 2) return 0;

    pushHistory();
    var created = 0;
    for (var i = 0; i + 1 < sorted.length; i += 2) {
      var a = sorted[i];
      var b = sorted[i + 1];
      if (!(b.time > a.time)) continue;
      var dup = ranges.some(function (r) {
        return Math.abs(r.in - a.time) < 0.001 && Math.abs(r.out - b.time) < 0.001;
      });
      if (dup) continue;
      ranges.push({
        id: nextRangeId(),
        name: '区间 ' + (ranges.length + 1),
        in: a.time,
        out: b.time,
        color: rangeColor(ranges.length),
      });
      created++;
    }
    if (!created) {
      undoStack.pop(); // 没有生成任何东西，不留下空撤销点
      return 0;
    }
    afterChange(true);
    return created;
  }

  function clear() {
    loadToken += 1; // 作废还在路上的 loadSidecar 结果
    items = [];
    ranges = [];
    counters = { A: 0, B: 0, C: 0, D: 0, F: 0, G: 0 };
    selectedId = null;
    videoPath = '';
    duration = 0;
    undoStack = [];
    redoStack = [];
    renderTimeline();
    renderList();
    renderRanges();
    // 注意：clear 不写 sidecar（换片时旧片 sidecar 保持不动；loadSidecar 会设置新路径）
  }

  function getById(id) {
    return items.find(function (m) { return m.id === id; }) || null;
  }

  function getAll() { return items.slice(); }

  function getSorted() {
    return items.slice().sort(function (a, b) { return a.time - b.time; });
  }

  function getSelected() { return getById(selectedId); }

  function select(id) {
    selectedId = getById(id) ? id : null;
    renderTimeline();
    renderList();
  }

  // ---- 内联重命名 ----

  /**
   * 把列表项的标签换成输入框就地编辑。
   * Electron 的渲染进程不支持 window.prompt（调用会直接失败），
   * 所以双击重命名必须用内联 input，而不是弹系统输入框。
   */
  function startRename(li, m) {
    if (!li || !m || li.querySelector('.rename-input')) return;
    var labelEl = li.querySelector('.label');
    if (!labelEl) return;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = m.label;
    input.maxLength = 40;
    li.replaceChild(input, labelEl);
    input.focus();
    input.select();

    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var value = input.value;
      if (input.parentNode) input.parentNode.replaceChild(labelEl, input);
      if (commit) {
        var ok = rename(m.id, value);
        if (!ok) {
          // 名称没变 / 为空：只恢复显示
          labelEl.textContent = m.label;
        }
      } else {
        labelEl.textContent = m.label;
      }
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation(); // 别让 A/B/C 等全局快捷键吃到输入内容
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
  }

  // ---- 渲染：时间轴刻度 ----
  function renderTimeline() {
    var layer = document.getElementById('marker-ticks');
    if (!layer) return;
    layer.innerHTML = '';
    if (!(duration > 0)) return;
    var view = TimelineView.getState();
    getSorted().forEach(function (m) {
      // 缩放后只画窗口内的刻度，窗口外的直接跳过
      if (m.time < view.start - 0.05 || m.time > view.end + 0.05) return;
      var tick = document.createElement('div');
      tick.className = 'tick' + (m.id === selectedId ? ' selected' : '');
      tick.style.left = (TimelineView.toRatio(m.time) * 100) + '%';
      tick.style.background = m.color;
      tick.style.color = m.color; // selected 发光用 currentColor
      tick.dataset.tip = m.label + '  ' + fmtTc(m.time);
      tick.title = m.label + ' ' + fmtTc(m.time); // 兜底原生 tooltip
      attachTickDrag(tick, m);
      layer.appendChild(tick);
    });
  }

  /**
   * 刻度交互：单击选中并跳转；按住左右拖动=改这个标记的时间。
   * 位移小于 4px 视为单击，避免手抖把标记拖走。
   */
  function attachTickDrag(tick, m) {
    tick.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      var id = m.id;
      var startX = e.clientX;
      var moved = false;
      var began = false;
      var tl = document.getElementById('timeline');
      if (!tl) { select(id); onSeek(m.time); return; }
      var rect = tl.getBoundingClientRect();
      var width = Math.max(1, rect.width);

      function onMove(ev) {
        if (!moved && Math.abs(ev.clientX - startX) > 4) moved = true;
        if (!moved) return;
        if (!began) { pushHistory(); began = true; }
        var ratio = clamp((ev.clientX - rect.left) / width, 0, 1);
        var t = TimelineView.toTime(ratio);
        setTime(id, t, { render: false });
        tick.style.left = (TimelineView.toRatio(t) * 100) + '%';
        tick.dataset.tip = m.label + '  ' + fmtTc(t);
        tick.title = tick.dataset.tip;
      }

      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (moved) {
          renderTimeline();
          renderList();
          select(id);
          saveSidecar();
          try { onChange(); } catch (e) { /* 忽略 */ }
        } else {
          select(id);
          onSeek(m.time);
        }
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  // ---- 渲染：侧栏列表（虚拟化，只画可见行） ----
  function buildMarkerRow(m) {
    var li = document.createElement('li');
    li.className = 'marker-item' + (m.id === selectedId ? ' selected' : '');
    li.dataset.id = m.id;

    var sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = m.color;
    li.appendChild(sw);

    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = m.label;
    // 双击标签 → 内联重命名（Electron 不支持 window.prompt）
    label.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      startRename(li, m);
    });
    li.appendChild(label);

    var tc = document.createElement('span');
    tc.className = 'tc';
    tc.textContent = fmtTc(m.time);
    li.appendChild(tc);

    var del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '删除该标记';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      remove(m.id);
    });
    li.appendChild(del);

    // 单击整项 → 选中并跳转
    li.addEventListener('click', function () {
      select(m.id);
      onSeek(m.time);
    });
    return li;
  }

  function renderList() {
    var ul = document.getElementById('marker-list');
    if (!ul) return;
    var countEl = document.getElementById('marker-count');
    if (countEl) countEl.textContent = items.length ? '（' + items.length + '）' : '';
    var sorted = getSorted();
    if (sorted.length <= SIMPLE_LIMIT) {
      renderSimple(ul, sorted, LIST_ITEM_H, buildMarkerRow);
    } else {
      renderVirtual(ul, sorted, LIST_ITEM_H, buildMarkerRow);
    }
  }

  // ---- 渲染：区间 ----
  /**
   * 区间条两端的拖拽手柄：按住左右拖，直接改 in/out。
   * 拖动中只更新 bar 的几何，松手才整体重绘 + 落盘。
   */
  function attachRangeHandle(bar, r, edge) {
    var handle = document.createElement('span');
    handle.className = 'range-handle ' + (edge === 'in' ? 'left' : 'right');
    handle.addEventListener('click', function (e) { e.stopPropagation(); });

    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      var tl = document.getElementById('timeline');
      if (!tl) return;
      var rect = tl.getBoundingClientRect();
      var began = false;

      function apply(ev) {
        if (!began) { beginEdit(); began = true; }
        var ratio = clamp((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        var t = TimelineView.toTime(ratio);
        setRangeBoundary(r.id, edge, t, { render: false });

        var view = TimelineView.getState();
        var s = Math.max(r.in, view.start);
        var en = Math.min(r.out, view.end);
        if (en > s) {
          bar.style.left = (TimelineView.toRatio(s) * 100) + '%';
          bar.style.width = Math.max(0.2, (TimelineView.toRatio(en) - TimelineView.toRatio(s)) * 100) + '%';
        }
        bar.title = r.name + '  ' + fmtTc(r.in) + ' → ' + fmtTc(r.out);
      }

      function onUp() {
        window.removeEventListener('pointermove', apply);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (began) {
          renderRanges();
          saveSidecar();
          try { onChange(); } catch (e) { /* 忽略 */ }
        }
      }

      window.addEventListener('pointermove', apply);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });

    bar.appendChild(handle);
  }

  function buildRangeRow(r) {
    var li = document.createElement('li');
    li.className = 'range-item';
    li.dataset.id = r.id;

    var sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = r.color;
    li.appendChild(sw);

    var main = document.createElement('span');
    main.className = 'range-main';

    var name = document.createElement('span');
    name.className = 'range-name';
    name.textContent = r.name;
    name.title = '双击重命名';
    name.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      startRangeRename(li, r);
    });
    main.appendChild(name);

    var tc = document.createElement('span');
    tc.className = 'range-tc';
    tc.textContent = fmtTc(r.in) + ' → ' + fmtTc(r.out) + '  (' + (r.out - r.in).toFixed(2) + 's)';
    main.appendChild(tc);

    li.appendChild(main);

    var del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '删除该区间';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      removeRange(r.id);
    });
    li.appendChild(del);

    li.addEventListener('click', function () { onSeek(r.in); });
    return li;
  }

  function renderRanges() {
    var ul = document.getElementById('range-list');
    var sorted = getRanges();

    var countEl = document.getElementById('range-count');
    if (countEl) countEl.textContent = sorted.length ? '（' + sorted.length + '）' : '';

    if (ul) {
      if (sorted.length <= SIMPLE_LIMIT) {
        renderSimple(ul, sorted, RANGE_ITEM_H, buildRangeRow);
      } else {
        renderVirtual(ul, sorted, RANGE_ITEM_H, buildRangeRow);
      }
    }

    // 时间轴上的区间条：只画与当前可视窗口相交的部分
    var bars = document.getElementById('range-bars');
    if (!bars) return;
    bars.innerHTML = '';
    if (!(duration > 0)) return;
    var view = TimelineView.getState();

    sorted.forEach(function (r) {
      var s = Math.max(r.in, view.start);
      var e = Math.min(r.out, view.end);
      if (!(e > s)) return;

      var bar = document.createElement('div');
      bar.className = 'range-bar';
      bar.style.left = (TimelineView.toRatio(s) * 100) + '%';
      bar.style.width = Math.max(0.2, (TimelineView.toRatio(e) - TimelineView.toRatio(s)) * 100) + '%';
      bar.style.background = r.color;
      bar.title = r.name + '  ' + fmtTc(r.in) + ' → ' + fmtTc(r.out);
      bar.addEventListener('click', function (ev) {
        ev.stopPropagation();
        onSeek(r.in);
      });

      // 边缘在窗口内才给手柄，避免缩放到细节时误拖
      if (r.in >= view.start - 0.001 && r.in <= view.end + 0.001) attachRangeHandle(bar, r, 'in');
      if (r.out >= view.start - 0.001 && r.out <= view.end + 0.001) attachRangeHandle(bar, r, 'out');
      bars.appendChild(bar);
    });
  }

  /** 区间名内联重命名（同标记的重命名逻辑，只是字段不同） */
  function startRangeRename(li, r) {
    if (!li || !r || li.querySelector('.rename-input')) return;
    var nameEl = li.querySelector('.range-name');
    if (!nameEl) return;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = r.name;
    input.maxLength = 60;
    li.replaceChild(input, nameEl);
    input.focus();
    input.select();

    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var value = input.value;
      if (input.parentNode) input.parentNode.replaceChild(nameEl, input);
      if (commit) {
        var ok = renameRange(r.id, value);
        if (!ok) nameEl.textContent = r.name;
      } else {
        nameEl.textContent = r.name;
      }
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
  }

  function afterChange(save) {
    renderTimeline();
    renderList();
    renderRanges();
    if (save) saveSidecar();
    try { onChange(); } catch (e) { /* 回调异常不影响主流程 */ }
  }

  // ---- sidecar 持久化 ----

  function saveSidecar() {
    var path = sidecarPath();
    if (!path) return Promise.resolve();
    var payload = {
      version: SIDECAR_VERSION,
      video: basename(videoPath),
      markers: items.map(function (m) {
        return { id: m.id, label: m.label, time: m.time, color: m.color, kind: m.kind };
      }),
      ranges: ranges.map(function (r) {
        return { id: r.id, name: r.name, in: r.in, out: r.out, color: r.color };
      })
    };
    return window.markplay.writeJsonFile(path, payload).catch(function () {
      // 写失败仅静默忽略，不打断打点流程
    });
  }

  // 在 loadVideo 成功后调用：读入同目录 sidecar（若存在）
  function loadSidecar(path) {
    // 令牌：多个 loadSidecar 并发时（例如同一次打开被触发两次），
    // 只有最后一次的结果可以写进 items，避免同一批标记被追加两遍。
    var token = ++loadToken;
    videoPath = path || '';
    items = [];
    ranges = [];
    counters = { A: 0, B: 0, C: 0, D: 0, F: 0, G: 0 };
    selectedId = null;
    undoStack = [];
    redoStack = [];
    var sp = sidecarPath();
    if (!sp) {
      afterChange(false);
      return Promise.resolve(0);
    }
    return window.markplay.readJsonFile(sp).then(function (data) {
      if (token !== loadToken) return 0;
      var loaded = 0;
      var removed = 0;
      var seen = {};
      var list = data && Array.isArray(data.markers) ? data.markers : [];
      list.forEach(function (raw) {
        if (!raw || typeof raw.time !== 'number' || !isFinite(raw.time)) return;
        var kind = ('ABCDFG'.indexOf(raw.kind) >= 0) ? raw.kind : 'A';
        var label = String(raw.label || '');
        var id = String(raw.id || nextId());
        // 老 bug 会把同一批 sidecar 反复追加，id 完全一样；这里按 id 去重
        if (seen[id]) { removed++; return; }
        seen[id] = true;
        items.push({
          id: id,
          label: label || (kind + (counters[kind] + 1)),
          time: Math.max(0, raw.time),
          color: raw.color || colors()[kind],
          kind: kind
        });
        // 从 label 尾部数字恢复计数器（如 "A12" → A 计数器至少为 12）
        var num = parseInt(label.replace(/^[A-Za-z]+/, ''), 10);
        if (!isNaN(num) && num > counters[kind]) counters[kind] = num;
        loaded++;
      });
      // v2：区间（老 sidecar 没有这一段，保持空数组即可）
      var rawRanges = data && Array.isArray(data.ranges) ? data.ranges : [];
      var seenRanges = {};
      rawRanges.forEach(function (raw) {
        if (!raw) return;
        var a = Number(raw.in);
        var b = Number(raw.out);
        if (!isFinite(a) || !isFinite(b) || !(b > a)) return;
        var rid = String(raw.id || nextRangeId());
        if (seenRanges[rid]) { removed++; return; }
        seenRanges[rid] = true;
        ranges.push({
          id: rid,
          name: String(raw.name || ('区间 ' + (ranges.length + 1))),
          in: Math.max(0, a),
          out: Math.max(0, b),
          color: raw.color || rangeColor(ranges.length),
        });
      });
      afterChange(false); // 渲染 + 通知，但不回写
      // 如果读到了历史重复项，顺手把清理后的 sidecar 写回，避免下次再翻倍
      if (removed > 0) saveSidecar();
      return loaded;
    }).catch(function () {
      if (token !== loadToken) return 0;
      afterChange(false);
      return 0;
    });
  }

  // ---- 初始化 ----
  function init(opts) {
    opts = opts || {};
    if (typeof opts.onSeek === 'function') onSeek = opts.onSeek;
    if (typeof opts.onChange === 'function') onChange = opts.onChange;
    if (typeof opts.timeProvider === 'function') timeProvider = opts.timeProvider;
    bindListScroll();
    // 窗口/侧栏高度变化后重绘一次，避免虚拟列表停留在旧的"可视行数"
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', function () {
        renderList();
        renderRanges();
      });
    }
  }

  // ---- 对外 API ----
  return {
    init: init,
    add: add,
    remove: remove,
    rename: rename,
    setTime: setTime,
    deleteSelected: deleteSelected,
    addRange: addRange,
    removeRange: removeRange,
    setRangeBoundary: setRangeBoundary,
    beginEdit: beginEdit,
    renameRange: renameRange,
    getRangeById: getRangeById,
    getRanges: getRanges,
    addRangesFromMarkers: addRangesFromMarkers,
    addRangesFromAdjacentMarkers: addRangesFromAdjacentMarkers,
    renderRanges: renderRanges,
    clear: clear,
    getById: getById,
    getAll: getAll,
    getSorted: getSorted,
    getSelected: getSelected,
    select: select,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    renderTimeline: renderTimeline,
    renderList: renderList,
    loadSidecar: loadSidecar,
    saveSidecar: saveSidecar,
    setDuration: function (d) { if (typeof d === 'number' && d >= 0) { duration = d; renderTimeline(); renderRanges(); } },
    setTimeProvider: function (fn) { if (typeof fn === 'function') timeProvider = fn; },
    count: function () { return items.length; },
    fmtTc: fmtTc // 导出时间码格式化，供其它模块复用
  };
})();
