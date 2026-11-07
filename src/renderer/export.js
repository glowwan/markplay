/* export.js —— 标记导出（CSV / EDL / JSON）与视频剪辑
 *
 * 依赖 Markers.getSorted() 获取按时间排序的标记。
 * 由 renderer.js 通过 Exporter.init({getVideoPath, getDuration, status}) 接线；
 * 标记变更时 renderer 会调用 Exporter.refreshClipSelectors() 刷新剪辑下拉。
 */

/* 全局命名空间 */
var Exporter = (function () {
  'use strict';

  var EDL_FPS = 25; // 兜底帧率（读不到 container-fps 时用）

  var getVideoPath = function () { return ''; };
  var getDuration = function () { return 0; };
  var getFps = function () { return 0; };
  var status = function () {};

  var clipping = false;   // 是否正在剪辑（单段或批量）
  var batchState = null;  // { total, index } 批量剪辑进度
  var pendingClip = null; // 当前等待结果的 { resolve, reject }

  function basename(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function stripExt(name) {
    return String(name).replace(/\.[^.\\/]+$/, '');
  }

  function joinPath(dir, name) {
    return String(dir).replace(/[\\/]+$/, '') + '\\' + name;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // ---- 时间码 ----

  // 秒 → "HH:MM:SS.mmm"（CSV / JSON / 界面共用）
  function tc(sec) {
    sec = Math.max(0, sec || 0);
    var ms = Math.floor((sec % 1) * 1000);
    var s = Math.floor(sec);
    var hh = String(Math.floor(s / 3600)).padStart(2, '0');
    var mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    var ss = String(s % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss + '.' + String(ms).padStart(3, '0');
  }

  // 秒 → "HH:MM:SS:FF"（EDL 用，非丢帧；毫秒四舍五入为帧）
  // fps 缺省时用兜底的 25；23.976 / 29.97 这类按整数名义帧率（24 / 30）计帧。
  function tcFrames(sec, fps) {
    var rate = nominalFps(fps);
    sec = Math.max(0, sec || 0);
    var totalFrames = Math.round(sec * rate);
    var ff = totalFrames % rate;
    var s = Math.floor(totalFrames / rate);
    var hh = String(Math.floor(s / 3600)).padStart(2, '0');
    var mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    var ss = String(s % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss + ':' + String(ff).padStart(2, '0');
  }

  /**
   * EDL / 帧号使用的"名义帧率"：把 23.976 → 24、29.97 → 30、59.94 → 60。
   * CMX3600 的 non-drop 时间码按整数帧计数，所以这里必须取整。
   * @param {number} [fps] 素材真实帧率
   * @returns {number} 1–120 的整数
   */
  function nominalFps(fps) {
    var value = (typeof fps === 'number' && isFinite(fps) && fps > 0) ? fps : sourceFps();
    if (!value) value = EDL_FPS;
    var rounded = Math.round(value);
    return Math.min(120, Math.max(1, rounded));
  }

  /** 当前素材帧率（用于界面显示，保留真实值） */
  function sourceFps() {
    var v = getFps();
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
  }

  // ---- 片段区间计算 ----

  /**
   * 计算每个标记对应的区间终点：下一标记的时间；最后一个给 10 秒（不超过视频时长）。
   * @param {Array<{time:number}>} markers 已按时间排序
   * @param {number} duration
   * @returns {Array<{start:number, end:number}>}
   */
  function segments(markers, duration) {
    return markers.map(function (m, i) {
      var end;
      if (i + 1 < markers.length) {
        end = markers[i + 1].time;
      } else if (duration > m.time) {
        end = Math.min(m.time + 10, duration);
      } else {
        end = m.time + 10;
      }
      return { start: m.time, end: end };
    });
  }

  // ---- 各格式序列化 ----

  // CSV：index,label,kind,time_seconds,timecode,frame,end_seconds,end_tc
  // frame 按素材帧率换算，方便在剪辑软件里按帧号定位。
  function toCSV(markers, duration, fps) {
    var rate = nominalFps(fps);
    var lines = ['index,label,kind,time_seconds,timecode,frame,end_seconds,end_tc'];
    var segs = segments(markers, duration);
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var seg = segs[i];
      lines.push([
        i + 1,
        csvCell(m.label),
        csvCell(m.kind || ''),
        m.time.toFixed(3),
        tc(m.time),
        Math.round(m.time * rate),
        seg.end.toFixed(3),
        tc(seg.end),
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }

  /** CSV 单元格转义（标记名可能含逗号/引号） */
  function csvCell(value) {
    var s = String(value == null ? '' : value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // 区间 CSV：index,name,in_seconds,in_tc,in_frame,out_seconds,out_tc,out_frame,duration_seconds
  function toRangesCSV(ranges, fps) {
    var rate = nominalFps(fps);
    var lines = ['index,name,in_seconds,in_tc,in_frame,out_seconds,out_tc,out_frame,duration_seconds'];
    (ranges || []).forEach(function (r, i) {
      lines.push([
        i + 1,
        csvCell(r.name || ('区间 ' + (i + 1))),
        r.in.toFixed(3),
        tc(r.in),
        Math.round(r.in * rate),
        r.out.toFixed(3),
        tc(r.out),
        Math.round(r.out * rate),
        (r.out - r.in).toFixed(3),
      ].join(','));
    });
    return lines.join('\n') + '\n';
  }

  // EDL：CMX3600 简化版。record 时间轴从 01:00:00:00 起，按段累积。
  // 帧号按素材帧率换算（non-drop），文件里额外注释真实帧率。
  function toEDL(markers, duration, videoBase, fps) {
    var rate = nominalFps(fps);
    var lines = [];
    lines.push('TITLE: ' + (videoBase || 'MarkPlay'));
    lines.push('FCM: NON-DROP FRAME');
    lines.push('* MARKPLAY FPS: ' + rate + (sourceFps() ? ' (source ' + sourceFps().toFixed(3) + ')' : ''));
    lines.push('');
    var segs = segments(markers, duration);
    var recCursor = 3600; // 01:00:00:00
    for (var i = 0; i < markers.length; i++) {
      var seg = segs[i];
      var evt = String(i + 1).padStart(3, '0');
      var recIn = recCursor;
      var recOut = recCursor + (seg.end - seg.start);
      lines.push(
        evt + '  AX       V     C        ' +
        tcFrames(seg.start, rate) + ' ' + tcFrames(seg.end, rate) + ' ' +
        tcFrames(recIn, rate) + ' ' + tcFrames(recOut, rate)
      );
      lines.push('* FROM CLIP NAME: ' + markers[i].label);
      recCursor = recOut;
    }
    return lines.join('\n') + '\n';
  }

  /** 由显式区间生成 EDL（批量剪辑/导出的主路径） */
  function toEDLRanges(ranges, videoBase, fps) {
    var rate = nominalFps(fps);
    var lines = [];
    lines.push('TITLE: ' + (videoBase || 'MarkPlay'));
    lines.push('FCM: NON-DROP FRAME');
    lines.push('* MARKPLAY FPS: ' + rate + (sourceFps() ? ' (source ' + sourceFps().toFixed(3) + ')' : ''));
    lines.push('');
    var recCursor = 3600; // 01:00:00:00
    (ranges || []).forEach(function (r, i) {
      var evt = String(i + 1).padStart(3, '0');
      var recOut = recCursor + (r.out - r.in);
      lines.push(
        evt + '  AX       V     C        ' +
        tcFrames(r.in, rate) + ' ' + tcFrames(r.out, rate) + ' ' +
        tcFrames(recCursor, rate) + ' ' + tcFrames(recOut, rate)
      );
      lines.push('* FROM CLIP NAME: ' + (r.name || ('区间 ' + (i + 1))));
      recCursor = recOut;
    });
    return lines.join('\n') + '\n';
  }

  // JSON：原生结构（标记 + 区间）
  function toJSON(markers, duration, videoBase, fps, ranges) {
    var payload = {
      version: 2,
      video: videoBase,
      duration: duration,
      edlFps: nominalFps(fps),
      sourceFps: sourceFps() || null,
      exportedAt: new Date().toISOString(),
      markers: markers.map(function (m) {
        return {
          label: m.label,
          kind: m.kind,
          time: m.time,
          startTc: tc(m.time),
          color: m.color,
        };
      }),
      ranges: (ranges || []).map(function (r, i) {
        return {
          name: r.name || ('区间 ' + (i + 1)),
          in: r.in,
          out: r.out,
          inTc: tc(r.in),
          outTc: tc(r.out),
          duration: r.out - r.in,
          color: r.color,
        };
      }),
    };
    return JSON.stringify(payload, null, 2) + '\n';
  }

  // ---- 导出流程：saveDialog → writeTextFile ----
  function exportAs(format) {
    var markers = Markers.getSorted();
    var ranges = Markers.getRanges();

    if (format === 'rng' && !ranges.length) {
      status('还没有区间：播到起点按 [ 设入点，到终点按 ] 建区间');
      return Promise.resolve();
    }
    if (format === 'csv' && !markers.length) {
      status('没有可导出的标记，请先打点');
      return Promise.resolve();
    }
    if (format === 'edl' && !ranges.length && !markers.length) {
      status('没有区间或标记可导出');
      return Promise.resolve();
    }
    if (format === 'json' && !markers.length && !ranges.length) {
      status('没有可导出的内容');
      return Promise.resolve();
    }

    var videoPath = getVideoPath();
    var base = stripExt(basename(videoPath)) || 'markplay';
    var suffix = format === 'rng' ? '_ranges.csv'
      : (format === 'edl' ? '.edl' : '_markers.' + format);
    var defName = base + suffix;

    return window.markplay.saveDialog(defName).then(function (out) {
      if (!out) { status('已取消导出'); return; }
      var duration = getDuration();
      var fps = sourceFps();
      var content;
      if (format === 'rng') content = toRangesCSV(ranges, fps);
      else if (format === 'csv') content = toCSV(markers, duration, fps);
      else if (format === 'edl') {
        content = ranges.length
          ? toEDLRanges(ranges, base, fps)
          : toEDL(markers, duration, base, fps);
      } else {
        content = toJSON(markers, duration, base, fps, ranges);
      }
      return window.markplay.writeTextFile(out, content).then(function () {
        var label = format === 'rng' ? '区间 CSV' : format.toUpperCase();
        status('已导出 ' + label + '：' + out);
        UI.toast('已导出 ' + label + '：' + basename(out), {
          kind: 'success',
          actionLabel: '在文件夹中显示',
          onAction: function () { window.markplay.showItemInFolder(out); },
        });
      });
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      status('导出失败：' + msg);
      UI.toast('导出失败：' + msg, { kind: 'error' });
    });
  }

  // ---- 剪辑 ----

  function setProgress(percent) {
    var fill = document.getElementById('clip-progress-fill');
    if (fill) fill.style.width = clamp(percent, 0, 100) + '%';
  }

  function setClipBusy(busy) {
    var btn = document.getElementById('btn-clip');
    var batch = document.getElementById('btn-clip-batch');
    if (btn) btn.disabled = busy;
    if (batch) batch.disabled = busy;
  }

  /**
   * 填充剪辑的"区间"下拉。
   * 区间是显式的 [in, out]，不再从 A/B 标记里猜配对。
   * 注意：给 <select> 添加 option 后浏览器会自动选中第一项，所以只在有旧值时保留。
   */
  function refreshClipSelectors() {
    var sel = document.getElementById('clip-range');
    if (!sel) return;

    var prev = sel.value;
    var ranges = Markers.getRanges();
    var ids = ranges.map(function (r) { return r.id; });

    sel.innerHTML = '';
    ranges.forEach(function (r, i) {
      var opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = (r.name || ('区间 ' + (i + 1))) + '  ' + tc(r.in) + ' → ' + tc(r.out);
      sel.appendChild(opt);
    });
    if (ids.indexOf(prev) >= 0) sel.value = prev;
    else if (ids.length) sel.selectedIndex = 0;

    var btn = document.getElementById('btn-clip');
    if (btn) btn.disabled = clipping || !getVideoPath() || ranges.length === 0;
    var batch = document.getElementById('btn-clip-batch');
    if (batch) batch.disabled = clipping || !getVideoPath() || ranges.length === 0;
    var rng = document.getElementById('btn-export-rng');
    if (rng) rng.disabled = !getVideoPath() || ranges.length === 0;
  }

  /**
   * 批量剪辑的区间配对规则：
   *  - 有 B 标记时：每个 A 配它后面最近的一个未使用 B（适合"A 起点 / B 终点"的打点习惯）；
   *  - 没有 B 标记时：按时间排序后相邻两个标记为一组（1-2、3-4…）。
   * @param {Array} sorted 按时间排序的标记
   * @returns {Array<{in: object, out: object}>}
   */
  function pairRegions(sorted) {
    var regions = [];
    if (!Array.isArray(sorted) || sorted.length < 2) return regions;
    var hasB = sorted.some(function (m) { return m.kind === 'B'; });

    if (hasB) {
      var usedB = {}; // 用下标标记已配对，避免标记缺 id 时互相顶掉
      sorted.forEach(function (m, i) {
        if (m.kind !== 'A') return;
        for (var j = i + 1; j < sorted.length; j++) {
          var candidate = sorted[j];
          if (candidate.kind === 'B' && !usedB[j]) {
            usedB[j] = true;
            regions.push({ in: m, out: candidate });
            break;
          }
        }
      });
      return regions;
    }

    for (var k = 0; k + 1 < sorted.length; k += 2) {
      regions.push({ in: sorted[k], out: sorted[k + 1] });
    }
    return regions;
  }

  /**
   * 启动一次剪辑并等待结果（结果走 player-event 的 clip-done / clip-error）。
   * @param {{input:string, ss:number, to:number, output:string, reencode:boolean}} opts
   * @returns {Promise<string>} 成功的输出路径
   */
  function runOne(opts) {
    return new Promise(function (resolve, reject) {
      pendingClip = { resolve: resolve, reject: reject };
      window.markplay.runClip(opts).then(function (r) {
        if (!r || !r.ok) {
          pendingClip = null;
          reject(new Error((r && r.error) || '剪辑启动失败'));
        }
      }).catch(function (err) {
        pendingClip = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  function startClip() {
    if (clipping) return Promise.resolve();
    var videoPath = getVideoPath();
    if (!videoPath) { status('请先打开视频'); return Promise.resolve(); }
    var ranges = Markers.getRanges();
    var sel = document.getElementById('clip-range');
    var range = ranges.find(function (r) { return r.id === (sel && sel.value); }) || ranges[0];
    if (!range) {
      status('还没有区间：播到起点按 [ 设入点，到终点按 ] 建区间');
      return Promise.resolve();
    }

    var base = stripExt(basename(videoPath)) || 'markplay';
    var idx = String(ranges.indexOf(range) + 1).padStart(2, '0');
    var nameInput = document.getElementById('clip-name');
    var name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      // 默认：视频名_clip_01.mp4（序号为区间顺序）
      name = base + '_clip_' + idx + '.mp4';
    } else if (!/\.[a-z0-9]{2,4}$/i.test(name)) {
      name += '.mp4';
    }

    return window.markplay.saveDialog(name).then(function (out) {
      if (!out) { status('已取消剪辑'); return; }
      var reencode = document.getElementById('clip-reencode');
      clipping = true;
      setClipBusy(true);
      setProgress(0);
      status('剪辑中：' + (range.name || '区间') + ' …');
      return runOne({
        input: videoPath,
        ss: range.in,
        to: range.out,
        output: out,
        reencode: !!(reencode && reencode.checked),
        duration: getDuration(),
      }).then(function (output) {
        setProgress(100);
        status('剪辑完成：' + output);
        UI.toast('剪辑完成：' + basename(output), {
          kind: 'success',
          actionLabel: '在文件夹中显示',
          onAction: function () { window.markplay.showItemInFolder(output); },
        });
      }).catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        status('剪辑失败：' + msg);
        UI.toast('剪辑失败：' + msg, { kind: 'error' });
      }).then(function () {
        clipping = false;
        batchState = null;
        setClipBusy(false);
        refreshClipSelectors();
      });
    }).catch(function (err) {
      status('剪辑失败：' + (err && err.message ? err.message : String(err)));
    });
  }

  /**
   * 启动一次"分段裁剪 + 拼接"的合并剪辑并等待结果。
   * @param {{input:string, ranges:Array<{ss:number,to:number}>, output:string, reencode:boolean}} opts
   * @returns {Promise<string>} 成功的输出路径
   */
  function runMerge(opts) {
    return new Promise(function (resolve, reject) {
      pendingClip = { resolve: resolve, reject: reject };
      window.markplay.runMergeClip(opts).then(function (r) {
        if (!r || !r.ok) {
          pendingClip = null;
          reject(new Error((r && r.error) || '合并剪辑启动失败'));
        }
      }).catch(function (err) {
        pendingClip = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * 合并模式：所有区间拼成一个文件。
   * 输出用"另存为"选路径，而不是选目录。
   */
  function startMergedClip(ranges, videoPath) {
    var base = stripExt(basename(videoPath)) || 'markplay';
    return window.markplay.saveDialog(base + '_merged.mp4').then(function (out) {
      if (!out) { status('已取消合并剪辑'); return; }

      clipping = true;
      batchState = null; // 合并的进度是整条链路的 0–100，不再按段换算
      setClipBusy(true);
      setProgress(0);
      status('合并剪辑（重新编码）：' + ranges.length + ' 个区间 → ' + basename(out) + ' …');

      return runMerge({
        input: videoPath,
        ranges: ranges.map(function (r) { return { ss: r.in, to: r.out }; }),
        output: out,
        duration: getDuration(),
      }).then(function (output) {
        setProgress(100);
        status('合并剪辑完成：' + output);
        UI.toast('合并剪辑完成：' + basename(output), {
          kind: 'success',
          actionLabel: '在文件夹中显示',
          onAction: function () { window.markplay.showItemInFolder(output); },
        });
      }).catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        status('合并剪辑失败：' + msg);
        UI.toast('合并剪辑失败：' + msg, { kind: 'error' });
      }).then(function () {
        clipping = false;
        batchState = null;
        setClipBusy(false);
        refreshClipSelectors();
      });
    }).catch(function (err) {
      status('合并剪辑失败：' + (err && err.message ? err.message : String(err)));
    });
  }

  /**
   * 批量剪辑：把每个显式区间各导出一个片段到同一个文件夹。
   * 同一时间只跑一个 ffmpeg，按区间顺序串行执行。
   */
  function startBatchClip() {
    if (clipping) return Promise.resolve();
    var videoPath = getVideoPath();
    if (!videoPath) { status('请先打开视频'); return Promise.resolve(); }
    var ranges = Markers.getRanges();
    if (!ranges.length) {
      status('还没有区间：播到起点按 [ 设入点，到终点按 ] 建区间（也可用 A/B 配对或相邻配对）');
      return Promise.resolve();
    }

    // 勾选"合并为一个文件"时走另一条路径
    var mergeEl = document.getElementById('clip-merge');
    if (mergeEl && mergeEl.checked) {
      return startMergedClip(ranges, videoPath);
    }

    return window.markplay.pickDirectory().then(function (dir) {
      if (!dir) { status('已取消批量剪辑'); return; }
      var base = stripExt(basename(videoPath)) || 'markplay';
      var reencodeEl = document.getElementById('clip-reencode');
      var reencode = !!(reencodeEl && reencodeEl.checked);
      var lastOutput = '';

      clipping = true;
      batchState = { total: ranges.length, index: 0 };
      setClipBusy(true);
      setProgress(0);

      var chain = Promise.resolve();
      ranges.forEach(function (range, i) {
        chain = chain.then(function () {
          batchState.index = i;
          setProgress(Math.round((i / ranges.length) * 100));
          status('批量剪辑 ' + (i + 1) + '/' + ranges.length + '：'
            + (range.name || ('区间 ' + (i + 1))));
          var name = base + '_clip_' + String(i + 1).padStart(2, '0') + '.mp4';
          lastOutput = joinPath(dir, name);
          return runOne({
            input: videoPath,
            ss: range.in,
            to: range.out,
            output: lastOutput,
            reencode: reencode,
            duration: getDuration(),
          });
        });
      });

      return chain.then(function () {
        setProgress(100);
        status('批量剪辑完成：' + ranges.length + ' 个片段 → ' + dir);
        UI.toast('批量剪辑完成：' + ranges.length + ' 个片段', {
          kind: 'success',
          actionLabel: '在文件夹中显示',
          onAction: function () { window.markplay.showItemInFolder(lastOutput); },
        });
      }).catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        status('批量剪辑中断：' + msg);
        UI.toast('批量剪辑中断：' + msg, { kind: 'error' });
      }).then(function () {
        clipping = false;
        batchState = null;
        setClipBusy(false);
        refreshClipSelectors();
      });
    }).catch(function (err) {
      status('批量剪辑失败：' + (err && err.message ? err.message : String(err)));
    });
  }

  function onClipProgress(percent) {
    if (!clipping) return;
    if (batchState) {
      var overall = ((batchState.index + (percent / 100)) / batchState.total) * 100;
      setProgress(overall);
    } else {
      setProgress(percent);
    }
  }

  function onClipDone(output) {
    if (!clipping) return;
    if (pendingClip) {
      var p = pendingClip;
      pendingClip = null;
      p.resolve(output);
    }
    // 单段剪辑的收尾在 startClip 的 then 里做；这里只负责把 Promise 放行
  }

  function onClipError(message) {
    if (!clipping) return;
    if (pendingClip) {
      var p = pendingClip;
      pendingClip = null;
      p.reject(new Error(message || '剪辑失败'));
    }
  }

  // ---- 初始化 ----
  function init(opts) {
    opts = opts || {};
    if (typeof opts.getVideoPath === 'function') getVideoPath = opts.getVideoPath;
    if (typeof opts.getDuration === 'function') getDuration = opts.getDuration;
    if (typeof opts.getFps === 'function') getFps = opts.getFps;
    if (typeof opts.status === 'function') status = opts.status;

    // 订阅剪辑进度 / 完成 / 失败事件
    window.markplay.onEvent(function (ev) {
      if (!ev) return;
      if (ev.type === 'clip-progress') onClipProgress(ev.percent);
      else if (ev.type === 'clip-done') onClipDone(ev.output);
      else if (ev.type === 'clip-error') onClipError(ev.message);
    });
  }

  // ---- 对外 API ----
  return {
    init: init,
    tc: tc,
    tcFrames: tcFrames,
    nominalFps: nominalFps,
    sourceFps: sourceFps,
    segments: segments,
    pairRegions: pairRegions,
    toCSV: toCSV,
    toRangesCSV: toRangesCSV,
    toEDL: toEDL,
    toEDLRanges: toEDLRanges,
    toJSON: toJSON,
    exportAs: exportAs,
    startClip: startClip,
    startBatchClip: startBatchClip,
    refreshClipSelectors: refreshClipSelectors,
    isClipping: function () { return clipping; },
  };
})();
