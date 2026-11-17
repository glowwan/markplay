'use strict';

/**
 * 画面点击手势判定（纯逻辑，可单测）。
 *
 * 需求：左键**双击**切换播放/暂停，同时保留左键**单击**的 2x 正放开关。
 *
 * 两者的冲突只能靠时间窗口区分：单击必须等一小段时间，确认没有第二下，
 * 才能执行它的动作；否则"双击"会被拆成两次单击。
 *
 * 为什么不用 mpv 的 `MBTN_LEFT_DBL`：
 * 它依赖 mpv 内部的鼠标双击状态机（`--input-doubleclick-time`），
 * 而这套机制只能在真实鼠标输入下工作——用 IPC 的 `keypress MBTN_LEFT`
 * 模拟验证时，mpv 每次都立刻上报 `left`，双击绑定根本不会触发，
 * 也就是说"mpv 会替我区分单击/双击"这件事在我们这里无法被验证。
 * 与其依赖一个测不到的行为，不如自己做判定：几十行、可单测、行为确定。
 */

/** 双击窗口（毫秒）。太短会误判，太长单击会明显发木 */
const DEFAULT_DBL_MS = 250;

/**
 * 建一个初始状态。
 * @param {number} [dblMs]
 * @returns {{dblMs: number, pendingAt: number|null}}
 */
function createState(dblMs) {
  return {
    dblMs: Number(dblMs) > 0 ? Number(dblMs) : DEFAULT_DBL_MS,
    pendingAt: null,
  };
}

/**
 * 处理一次左键按下。
 *
 * @param {{dblMs: number, pendingAt: number|null}} state
 * @param {number} now 时间戳（毫秒）
 * @returns {{action: 'double'|'single', state: object, token: number}}
 *   - 'double'：这是双击的第二下，调用方应执行"播放/暂停"；
 *   - 'single'：先挂起，调用方等 `dblMs` 后调用 `shouldFire()` 确认再执行单击动作。
 *   `token` 用于在定时器回调里确认"还是我那次挂起"。
 */
function resolve(state, now) {
  const t = Number(now);
  const pending = state && typeof state.pendingAt === 'number' ? state.pendingAt : null;
  const dblMs = state && state.dblMs > 0 ? state.dblMs : DEFAULT_DBL_MS;

  // 双击窗口内又按了一下 -> 是双击，把挂起的那次取消掉
  if (pending !== null && t - pending >= 0 && t - pending <= dblMs) {
    return { action: 'double', state: { dblMs, pendingAt: null }, token: 0 };
  }

  // 否则挂起，等窗口过去
  return { action: 'single', state: { dblMs, pendingAt: t }, token: t };
}

/**
 * 挂起的那次单击到时候了，是否该执行？
 * （如果期间发生了双击，pendingAt 已被清空或换成新的，就不该再执行）
 *
 * @param {{dblMs: number, pendingAt: number|null}} state
 * @param {number} token resolve() 返回的 token
 * @returns {boolean}
 */
function shouldFire(state, token) {
  return !!state && state.pendingAt === token;
}

/**
 * 清掉挂起状态（执行完单击后调用）。
 * @param {{dblMs: number, pendingAt: number|null}} state
 * @returns {{dblMs: number, pendingAt: number|null}}
 */
function consume(state) {
  return { dblMs: state && state.dblMs > 0 ? state.dblMs : DEFAULT_DBL_MS, pendingAt: null };
}

module.exports = {
  DEFAULT_DBL_MS,
  consume,
  createState,
  resolve,
  shouldFire,
};
