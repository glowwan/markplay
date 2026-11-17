'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RS = require('../src/rev-step');

// ---------------------------------------------------------------- 默认值

test('默认与 config 的现有取值一致（MP4 行为不许变）', () => {
  const s = RS.createState();
  assert.equal(s.step, 0.2);
  assert.equal(s.interval, 100);
  assert.equal(s.speed, 2);
  assert.equal(s.coarsened, false);
});

// ---------------------------------------------------------------- MP4：始终停在基础步长

test('MP4：每步都恰好退回 0.2 秒 -> 步长与间隔保持 0.2 / 100ms', () => {
  let s = RS.createState();
  for (let i = 0; i < 50; i++) {
    s = RS.observe(s, 0.2);
    assert.equal(s.step, 0.2, `第 ${i + 1} 步后步长应仍为 0.2`);
    assert.equal(s.interval, 100, `第 ${i + 1} 步后间隔应仍为 100ms`);
    assert.equal(s.coarsened, false);
  }
});

test('MP4：浮点误差（0.1999）不影响判定', () => {
  let s = RS.createState();
  s = RS.observe(s, 0.1999);
  assert.equal(s.step, 0.2);
});

// ---------------------------------------------------------------- TS：逐步放大到能动的粒度

test('TS：连续退不动 -> 步长翻倍，直到上限', () => {
  let s = RS.createState();
  const seen = [];
  for (let i = 0; i < 6; i++) {
    s = RS.observe(s, 0);
    seen.push(s.step);
  }
  assert.deepEqual(seen, [0.4, 0.8, 1.6, 3.2, 4, 4], '应对称翻倍并封顶在 maxStep');
});

test('TS：步长还是 0.2 时不算"退化"，翻倍后才标记 coarsened', () => {
  let s = RS.createState();
  s = RS.observe(s, 0);   // 0.2 -> 0.4
  assert.equal(s.coarsened, true, '步长已超过基础值 1.5 倍');
});

test('TS：一旦真的动了，按实际位移折算间隔（保持 2x 平均速度）', () => {
  let s = RS.createState();
  // 模拟实测：步长涨到 3.2 之后，一次实际后退 2 秒
  for (let i = 0; i < 4; i++) s = RS.observe(s, 0);   // 0.2->0.4->0.8->1.6->3.2
  s = RS.observe(s, 2);
  assert.equal(s.step, 3.2, '成功后步长不该再变');
  assert.equal(s.interval, 1000, '退 2 秒要配 1000ms 间隔，平均才是 2x');
  assert.equal(s.coarsened, true);
});

test('TS：稳定后不再抖动（连续几轮都退 2 秒，间隔恒定）', () => {
  let s = RS.createState();
  for (let i = 0; i < 4; i++) s = RS.observe(s, 0);
  s = RS.observe(s, 2);
  for (let i = 0; i < 5; i++) {
    s = RS.observe(s, 2);
    assert.equal(s.step, 3.2);
    assert.equal(s.interval, 1000);
  }
});

test('间隔会被夹在 [minInterval, maxInterval]', () => {
  let s = RS.createState();
  // 实际退了 10 秒（超过 maxStep），间隔不该爆掉
  s = RS.observe(s, 10);
  assert.ok(s.interval <= s.maxInterval, '间隔不超过上限');
  assert.ok(s.interval >= s.minInterval, '间隔不低于下限');
});

test('位移小于 40% 视作没动', () => {
  let s = RS.createState();
  const before = s.step;
  s = RS.observe(s, before * 0.39);
  assert.ok(s.step > before, '没退够 40% 应继续放大步长');
});

test('位移正好 40% 也算动（边界含）', () => {
  let s = RS.createState();
  const before = s.step;
  s = RS.observe(s, before * 0.4);
  assert.equal(s.step, before, '达到阈值就不该放大');
});

// ---------------------------------------------------------------- 没救的情况

test('步长到顶还一直不动 -> isExhausted 变 true', () => {
  let s = RS.createState();
  for (let i = 0; i < 20; i++) s = RS.observe(s, 0);
  assert.equal(s.step, s.maxStep);
  assert.equal(RS.isExhausted(s), true);
});

test('中间成功过一次就不会被判定为没救', () => {
  let s = RS.createState();
  for (let i = 0; i < 4; i++) s = RS.observe(s, 0);
  s = RS.observe(s, 2);
  assert.equal(RS.isExhausted(s), false);
});

test('非法 moved 值不会把状态搞坏', () => {
  let s = RS.createState();
  s = RS.observe(s, NaN);
  assert.ok(Number.isFinite(s.step));
  s = RS.observe(s, undefined);
  assert.ok(Number.isFinite(s.step) && Number.isFinite(s.interval));
});

test('observe 不修改入参', () => {
  const s = RS.createState();
  const snapshot = JSON.stringify(s);
  RS.observe(s, 0);
  assert.equal(JSON.stringify(s), snapshot);
});

// ---------------------------------------------------------------- 到头判定

test('reachedStart：退到开头附近就收尾', () => {
  const s = RS.createState();
  assert.equal(RS.reachedStart(s, 0), true);
  assert.equal(RS.reachedStart(s, 0.1), true);
  assert.equal(RS.reachedStart(s, 0.3), false);
});

test('reachedStart：非法位置返回 false（宁可继续，也不要误停）', () => {
  const s = RS.createState();
  assert.equal(RS.reachedStart(s, NaN), false);
  assert.equal(RS.reachedStart(s, undefined), false);
});

// ---------------------------------------------------------------- 完整流程对照

test('完整流程：MP4 一直精细，TS 退化成 2 秒一跳但仍持续后退', () => {
  function simulate(movedFn, steps) {
    let s = RS.createState();
    const log = [];
    for (let i = 0; i < steps; i++) {
      const moved = movedFn(s);
      s = RS.observe(s, moved);
      log.push({ step: s.step, interval: s.interval });
    }
    return log;
  }

  // MP4：请求多少就退多少
  const mp4 = simulate((s) => s.step, 10);
  assert.ok(mp4.every((x) => x.step === 0.2 && x.interval === 100));

  // TS：步长 ≤2 秒时不动，≥3 秒时退 2 秒
  const ts = simulate((s) => (s.step >= 3 ? 2 : 0), 12);
  const last = ts[ts.length - 1];
  assert.equal(last.step, 3.2, '最终稳定在 3.2 秒步长');
  assert.equal(last.interval, 1000, '间隔 1 秒，平均 2x');
  // 后期每步都应该是"能动的状态"
  const tail = ts.slice(-4);
  assert.ok(tail.every((x) => x.step === 3.2 && x.interval === 1000), '后期稳定不抖动');
});
