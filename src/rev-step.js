'use strict';

/**
 * 2x 倒放的自适应步长（纯逻辑，可单测）。
 *
 * 背景：倒放是"暂停 + 反复往回 seek"模拟出来的。
 * MP4/MKV 这类有索引的容器，往回退 0.2 秒就是 0.2 秒；
 * 但 **MPEG-TS 没有索引**，mpv 只能按关键帧对齐——实测 2 秒 GOP 的 TS：
 *   步长 0.2 秒 / 1 秒 / 2 秒  → 位置完全不动（被量化到同一个关键帧）
 *   步长 3 秒 / 4 秒          → 每步实际后退 2 秒
 * 所以固定 0.2 秒步长在 TS 上表现为"倒放没反应"，正是用户报的那个现象。
 *
 * 对策：**用"上一次是否真的动了"来自适应步长**。
 *  - 动了：保持步长，并按"实际后退量"折算定时器间隔，让平均速度仍是 2x；
 *  - 没动：步长翻倍，直到能动（上限 maxStep）。
 * MP4 上 moved 恒等于步长，所以永远停留在 baseStep / baseInterval，
 * 行为与改动前完全一致（有单测钉住这一点）。
 */

const DEFAULTS = Object.freeze({
  /** 基础步长（秒），与 config.REV2X_STEP 一致 */
  baseStep: 0.2,
  /** 基础间隔（毫秒），与 config.REV2X_INTERVAL_MS 一致 */
  baseInterval: 100,
  /** 目标倍速（倒放 2x） */
  speed: 2,
  /** 步长上限（秒）：再大就太跳了 */
  maxStep: 4,
  /** 间隔下限 / 上限（毫秒） */
  minInterval: 100,
  maxInterval: 2000,
  /** 连续失败多少次后认定"这个文件无法倒放" */
  maxFailures: 8,
});

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 造一个初始状态。
 * @param {Partial<typeof DEFAULTS>} [options]
 */
function createState(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  return {
    baseStep: o.baseStep,
    baseInterval: o.baseInterval,
    speed: o.speed,
    maxStep: o.maxStep,
    minInterval: o.minInterval,
    maxInterval: o.maxInterval,
    maxFailures: o.maxFailures,
    /** 当前步长（秒） */
    step: o.baseStep,
    /** 当前定时器间隔（毫秒） */
    interval: o.baseInterval,
    /** 是否已经退化成"按关键帧大步跳" */
    coarsened: false,
    /** 连续"没动"的次数 */
    failures: 0,
  };
}

/**
 * 根据"上一次 seek 实际后退了多少秒"更新状态。
 *
 * @param {object} state createState() 的结果
 * @param {number} moved 实际后退秒数（≤0 表示没动）
 * @returns {object} 新状态（不修改入参）
 */
function observe(state, moved) {
  const next = Object.assign({}, state);
  const m = Number(moved);

  // 判定"这一步有没有真的退动"：至少要到步长的 40%
  const movedOk = Number.isFinite(m) && m >= state.step * 0.4;

  if (!movedOk) {
    next.failures = (state.failures || 0) + 1;
    next.step = Math.min(state.maxStep, Math.max(state.baseStep, state.step * 2));
    next.interval = state.baseInterval;
    next.coarsened = next.step > state.baseStep * 1.5;
    return next;
  }

  next.failures = 0;
  // 实际位移可能大于请求步长（关键帧对齐会一次跳一个 GOP），
  // 按实际位移折算间隔，才能让平均速度仍接近目标倍速。
  const effective = clamp(m, state.baseStep, state.maxStep);
  next.interval = clamp(
    Math.round((effective / state.speed) * 1000),
    state.minInterval,
    state.maxInterval
  );
  next.coarsened = next.step > state.baseStep * 1.5 || next.interval > state.baseInterval * 1.5;
  return next;
}

/**
 * 是否已经没救（步长到顶还连续失败很多次）。
 * 到这一步应当停止倒放并告知用户，而不是假装在工作。
 * @param {object} state
 * @returns {boolean}
 */
function isExhausted(state) {
  return state.step >= state.maxStep && (state.failures || 0) >= (state.maxFailures || 8);
}

/**
 * 下一次是否该结束了（已经退到开头附近）。
 * @param {object} state
 * @param {number} pos 当前位置（秒）
 * @returns {boolean}
 */
function reachedStart(state, pos) {
  const p = Number(pos);
  if (!Number.isFinite(p)) return false;
  return p <= Math.max(state.baseStep, 0.05) + 0.05;
}

module.exports = {
  DEFAULTS,
  clamp,
  createState,
  isExhausted,
  observe,
  reachedStart,
};
