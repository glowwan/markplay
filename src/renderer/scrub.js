/* scrub.js —— 触摸板手势：横滑惯性微调时间轴 / 纵滑调节音量
 *
 * 数据流：
 *  - 视频子窗口（原生）收到的触摸板滚轮事件由主进程经 markplay.onEvent
 *    以 {type:'wheel',deltaX,deltaY,deltaMode} 转发到渲染进程；
 *  - 桌面端备用：在控制条时间轴 #timeline 上直接监听 wheel。
 *  - scrub 期间 renderer 通过 Scrub.isScrubbing() 得知，暂停 mpv-time
 *    对时间轴的回写，避免两者打架。
 */

/* 全局命名空间 */
var Scrub = (function () {
  'use strict';

  var cfg = function () { return window.markplay.config; };

  // ---- 内部状态 ----
  var scrubbing = false;      // 是否正处于横滑 scrub 会话
  var entering = false;       // 正在进入会话（等待首帧 mpvGet 返回），防并发
  var target = 0;             // 目标时间（秒）
  var current = 0;            // 当前已发送到 mpv 的时间（秒）
  var duration = 0;           // 视频时长（秒）
  var wasPlaying = false;     // 进入 scrub 前是否在播放
  var lastWheelAt = 0;        // 最近一次横滑 wheel 事件时间戳
  var pendingDx = 0;          // entering 期间累积的横滑增量（防丢失）
  var rafId = 0;              // rAF 循环 id
  var volumeCache = 100;      // 音量缓存（避免高频 wheel 下每次都 mpvGet）
  // 惯性 + 节流（v4 新增）
  var velocity = 0;           // 滑动速度（秒/秒）：手指离开后 target 按此速度衰减滑行
  var lastDxAt = 0;           // 上次横滑事件时间戳（算速度用）
  var lastSent = -1;          // 上次实际下发给 mpv 的 seek 目标
  var lastSentAt = 0;         // 上次下发的时间戳
  // v7 下发策略（学 mpv 官方 OSC / LosslessCut 的成熟做法）：
  //  - 拖动中：absolute+keyframes（快，5~50ms），节流 40ms；
  //  - 慢速微调（|velocity| < SCRUB_KEYFRAME_VELOCITY）：absolute+exact（准），
  //    一次只发一个，等 time-pos 变化（任意变化即算 mpv 已处理）再发下一个；
  //  - 松手时：一次 absolute+exact，落到精确位置。
  // 原理：exact seek 要从前一个关键帧开始逐帧解码，耗时随 GOP 长度暴涨
  // （VP9 长 GOP 下 1200ms+ vs keyframes 50ms），拖动中发 exact 必然积压跳帧。
  var seekInFlight = false;   // 精确 seek 在途（只用于 exact 的门控）
  var lastObservedT = -1;     // 上次 time-pos 回报（landing 判定用）
  var lastWasExact = true;    // 上次下发是否为 exact（松手时决定要不要补一次 exact）

  var hudEl = null;           // #scrub-hud
  var volEl = null;           // #volume
  var timeEl = null;          // #time-current

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

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

  // deltaMode 换算系数：0=像素，1=行（×16），2=页（×16×24）
  function modeFactor(mode) {
    if (mode === 1) return 16;
    if (mode === 2) return 384;
    return 1;
  }

  // ---- HUD ----
  function showHud() {
    if (hudEl) hudEl.hidden = false;
    updateHud();
  }
  function hideHud() {
    if (hudEl) hudEl.hidden = true;
  }
  function updateHud() {
    if (!hudEl || hudEl.hidden) return;
    // 样式示例："◀◀ 00:12:34.567 ▶▶"（HTML 区指示，不覆盖视频）
    hudEl.textContent = '◀◀ ' + fmtTc(target) + ' ▶▶';
  }

  // ---- 进入 / 退出 scrub 会话 ----
  function ensureScrub() {
    if (scrubbing || entering) return Promise.resolve();
    entering = true;
    // duration 和 pause 并行取，减少起手延迟
    var p = Promise.all([
        refreshDuration(),
        window.markplay.mpvGet('pause').catch(function () { return true; })
      ])
      .then(function (results) {
        wasPlaying = !results[1];
        if (wasPlaying) {
          return window.markplay.mpvCommand(['set_property', 'pause', true]).catch(function () {});
        }
      })
      .then(function () { return window.markplay.mpvGet('time-pos').catch(function () { return 0; }); })
      .then(function (pos) {
        current = (typeof pos === 'number' && pos >= 0) ? pos : 0;
        var c = cfg();
        target = clamp(current + pendingDx * c.SCRUB_SENSITIVITY, 0, duration);
        pendingDx = 0;
        velocity = 0;
        lastDxAt = performance.now();
        lastWheelAt = lastDxAt;
        lastSent = -1;
        lastSentAt = 0;
        lastWasExact = true;
        lastObservedT = -1;
        scrubbing = true;
        showHud();
        startLoop();
      })
      .catch(function () { /* 进入失败则保持非 scrub 状态 */ })
      .then(function () { entering = false; });
    return p;
  }

  function endScrub() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    scrubbing = false;
    velocity = 0;
    // 松手：一次 exact seek 落到精确位置。
    // （拖动中快速段用的是 keyframes 近似值；慢速段已是 exact 时若位置没变则跳过。）
    if (!lastWasExact || Math.abs(target - lastSent) > 0.05) {
      window.markplay.mpvCommand(['seek', target, 'absolute+exact']).catch(function () {});
    }
    lastSent = -1;
    seekInFlight = false;
    hideHud();
    // 空闲超时后：恢复进入前的播放状态
    if (wasPlaying) {
      wasPlaying = false;
      window.markplay.mpvCommand(['set_property', 'pause', false]).catch(function () {});
    }
  }

  // rAF 循环（v4 重写）：
  //  1) 惯性：手指离开后（>40ms 无 wheel 事件）且仍有速度时，target 按速度衰减滑行；
  //  2) current 向 target 指数逼近（帧率无关的写法）；
  //  3) 节流下发：mpv 的 seek 有成本，60fps 狂发只会让它排队卡顿。
  //     只有当位置变化超过一帧（0.04s）或超过 50ms 没下发过，才真正发一次。
  function startLoop() {
    if (rafId) return;
    var lastT = performance.now();
    var step = function () {
      var now = performance.now();
      var dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000)); // 秒
      lastT = now;
      var c = cfg();
      var idleFor = now - lastWheelAt;

      // 1) 惯性滑行
      if (idleFor > 40 && Math.abs(velocity) > 0.05) {
        target = clamp(target + velocity * dt, 0, duration);
        velocity *= Math.pow(c.SCRUB_INERTIA_DECAY, dt * 60);
        if (Math.abs(velocity) < 0.05) velocity = 0;
      }

      // 提前恢复播放：手指已离开（>40ms 无事件）、速度衰减到很小、且接近目标时，
      // 不再等完全静止，直接结束 scrub 并恢复播放。
      // 这样"滑行减速"无缝转入"正常播放"，避免"静止→卡顿一下→播放"的割裂感。
      if (wasPlaying && idleFor > 40 && Math.abs(velocity) < 2 && Math.abs(target - current) < 1.0) {
        endScrub();
        return;
      }

      // 2) 指数逼近（帧率无关）
      var k = 1 - Math.pow(1 - c.SCRUB_SMOOTHING, dt * 60);
      current += (target - current) * k;
      var settled = (velocity === 0) && Math.abs(target - current) < 0.005;
      if (settled) current = target;

      // 3) 下发（v7）：慢速 exact / 快速 keyframes
      if (seekInFlight && now - lastSentAt > 300) seekInFlight = false; // 看门狗
      var useExact = Math.abs(velocity) < c.SCRUB_KEYFRAME_VELOCITY;
      var moveThresh = useExact ? 0.04 : 0.08;
      var movedEnough = Math.abs(current - lastSent) >= moveThresh ||
          (now - lastSentAt > 120 && Math.abs(current - lastSent) > 0.001);
      // exact：等上一个被 mpv 处理（门控）；keyframes：纯节流 40ms（便宜，不会积压）
      var gateOk = useExact ? !seekInFlight : (now - lastSentAt >= 40);
      if (movedEnough && gateOk) {
        lastSent = current;
        lastSentAt = now;
        var flags = useExact ? 'absolute+exact' : 'absolute+keyframes';
        lastWasExact = useExact;
        if (useExact) seekInFlight = true;
        window.markplay.mpvCommand(['seek', current, flags]).catch(function () {
          seekInFlight = false;
        });
      }
      if (timeEl) timeEl.textContent = fmtTc(current);
      updateHud();

      // 收敛 + 空闲超时 → 结束会话
      if (idleFor > c.SCRUB_IDLE_MS && settled) {
        endScrub();
        return;
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  // ---- 横滑处理 ----
  function onHorizontalWheel(dx, mode) {
    // 时长未知时先尝试刷新，本次事件丢弃（避免 target 被钳到 0 误 seek）
    if (!(duration > 0)) { refreshDuration(); return; }
    var c = cfg();
    // 方向：默认内容跟随手指（右推快退 / 左推快进）；SCRUB_INVERT_X=false 则反之
    if (c.SCRUB_INVERT_X) dx = -dx;
    var delta = dx * modeFactor(mode) * c.SCRUB_SENSITIVITY;
    var now = performance.now();
    // 速度追踪（指数滑动平均）：供手指离开后的惯性滑行使用
    var dt = Math.max(1, now - lastDxAt) / 1000;
    var instV = delta / dt;
    // 异常大跳变（>120 秒/秒）视为噪声，不计入速度
    if (Math.abs(instV) < 120) {
      velocity = velocity * 0.65 + instV * 0.35;
    }
    lastDxAt = now;
    lastWheelAt = now;
    if (scrubbing) {
      target = clamp(target + delta, 0, duration);
    } else {
      // 尚未进入会话：先累积，ensureScrub 完成后一次性应用
      pendingDx += dx * modeFactor(mode);
      ensureScrub();
    }
  }

  // ---- 纵滑：音量 ----
  function onVerticalWheel(dy) {
    var c = cfg();
    var next = clamp(
      volumeCache - Math.sign(dy) * c.VOLUME_STEP * (Math.abs(dy) / 100),
      0, 100
    );
    volumeCache = next;
    var rounded = Math.round(next);
    window.markplay.mpvCommand(['set_property', 'volume', rounded]).catch(function () {});
    if (volEl) volEl.value = String(rounded);
  }

  // ---- 统一 wheel 入口 ----
  function handleWheel(dx, dy, mode) {
    if (typeof dx !== 'number' || typeof dy !== 'number') return;
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      onHorizontalWheel(dx, mode || 0);
    } else {
      onVerticalWheel(dy);
    }
  }

  function refreshDuration() {
    return window.markplay.mpvGet('duration')
      .then(function (d) {
        if (typeof d === 'number' && d > 0) duration = d;
      })
      .catch(function () {});
  }

  // ---- 初始化 ----
  function init() {
    hudEl = document.getElementById('scrub-hud');
    volEl = document.getElementById('volume');
    timeEl = document.getElementById('time-current');

    // 1) 主进程从视频子窗口转发的触摸板滚轮事件
    window.markplay.onEvent(function (ev) {
      if (ev && ev.type === 'wheel') {
        // Ctrl/Shift+滚轮 是时间轴缩放/平移，交给 renderer.js 处理
        if (ev.ctrlKey || ev.shiftKey || ev.metaKey) return;
        handleWheel(ev.deltaX, ev.deltaY, ev.deltaMode);
      }
    });

    // 2) 桌面端备用：控制条时间轴上的滚轮（阻止页面滚动行为）
    //    Ctrl/Shift+滚轮 是时间轴缩放/平移，由 renderer.js 处理，这里让开。
    var timeline = document.getElementById('timeline');
    if (timeline) {
      timeline.addEventListener('wheel', function (e) {
        if (e.ctrlKey || e.shiftKey || e.metaKey) return;
        e.preventDefault();
        handleWheel(e.deltaX, e.deltaY, e.deltaMode);
      }, { passive: false });
    }

    // 初始化音量缓存
    window.markplay.mpvGet('volume')
      .then(function (v) { if (typeof v === 'number') volumeCache = clamp(v, 0, 100); })
      .catch(function () {});
  }

  // ---- 对外 API ----
  return {
    init: init,
    isScrubbing: function () { return scrubbing; },
    /**
     * mpv 的 time-pos 回报：暂停 scrub 时 time-pos 只会因我们的 seek 变化，
     * 因此任何变化都说明 mpv 已处理上一个 seek → 解除 exact 门控。
     * （关键帧 seek 上报的是吸附后的关键帧位置，不能用 ±0.15 精确匹配。）
     * 由 renderer 的 mpv-time 事件处理调用。
     */
    notifySeekLanded: function (t) {
      if (typeof t !== 'number') return;
      if (lastObservedT >= 0 && Math.abs(t - lastObservedT) > 0.02) {
        seekInFlight = false;
      }
      lastObservedT = t;
    },
    setDuration: function (d) { if (typeof d === 'number' && d >= 0) duration = d; },
    setVolumeCache: function (v) { if (typeof v === 'number') volumeCache = clamp(v, 0, 100); },
    getTarget: function () { return target; }
  };
})();
