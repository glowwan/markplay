'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeMarkersContext } = require('./helpers');

/** 建一个已经载入视频、设好时长的上下文 */
async function setup(opts) {
  const { ctx, writes, setSidecar } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: (opts && opts.time) || (() => 0) });
  await M.loadSidecar('C:\\v\\a.mp4');
  M.setDuration((opts && opts.duration) != null ? opts.duration : 100);
  if (opts && opts.fps) M.setFpsProvider(() => opts.fps);
  return { ctx, M, writes, setSidecar };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('帧吸附：30fps 下打点落到最近的帧', async () => {
  const { M } = await setup({ fps: 30, time: () => 10.017 });
  const m = M.add('A');
  // round(10.017 * 30) = 301 → 301/30
  assert.ok(near(m.time, 301 / 30), '实际 ' + m.time);
});

test('帧吸附：帧率未知时不吸附（保持原值）', async () => {
  const { M } = await setup({ time: () => 10.017 });
  const m = M.add('A');
  assert.equal(m.time, 10.017);
});

test('帧吸附：23.976 这样的非整数帧率同样生效', async () => {
  const { M } = await setup({ fps: 23.976, time: () => 10 });
  const m = M.add('A');
  assert.ok(near(m.time, Math.round(10 * 23.976) / 23.976));
});

test('帧吸附：吸附结果不会超出 [0, duration]', async () => {
  const { M } = await setup({ fps: 30, duration: 10, time: () => 9.995 });
  const m = M.add('A');
  assert.ok(m.time <= 10, '实际 ' + m.time);
  assert.ok(m.time >= 0);
});

test('帧吸附：config.SNAP_TO_FRAME=false 可关闭', async () => {
  const { ctx, M } = await setup({ fps: 30, time: () => 10.017 });
  ctx.window.markplay.config.SNAP_TO_FRAME = false;
  const m = M.add('A');
  assert.equal(m.time, 10.017);
});

test('帧吸附：snapToFrame 直接调用也遵循同一规则', async () => {
  const { ctx, M } = await setup({ fps: 25 });
  assert.ok(near(M.snapToFrame(1.01), 25 / 25));
  assert.ok(near(M.snapToFrame(1.02), Math.round(1.02 * 25) / 25));

  ctx.window.markplay.config.SNAP_TO_FRAME = false;
  assert.equal(M.snapToFrame(1.01), 1.01);

  // 非法输入原样返回，不产生 NaN
  assert.ok(Number.isNaN(M.snapToFrame(NaN)));
});

test('帧吸附：拖动标记刻度也吸附', async () => {
  const { M } = await setup({ fps: 30, time: () => 1 });
  const m = M.add('A');
  M.setTime(m.id, 20.017);
  // round(20.017 * 30) = 601 → 601/30
  assert.ok(near(M.getById(m.id).time, 601 / 30), '实际 ' + M.getById(m.id).time);
});

test('帧吸附：拖动区间入点落到帧网格上', async () => {
  const { M } = await setup({ fps: 30 });
  const r = M.addRange(10, 20, '段');
  M.setRangeBoundary(r.id, 'in', 15.017);
  assert.ok(near(M.getRangeById(r.id).in, Math.round(15.017 * 30) / 30),
    '实际 ' + M.getRangeById(r.id).in);
});

test('帧吸附：入点拖过出点时仍保持最小间隔且落在帧上', async () => {
  const { M } = await setup({ fps: 30 });
  const r = M.addRange(10, 20, '段');
  M.setRangeBoundary(r.id, 'in', 30);
  const inT = M.getRangeById(r.id).in;
  assert.ok(inT < 20, '必须严格小于出点，实际 ' + inT);
  // 应落在帧网格：inT * 30 接近整数
  assert.ok(Math.abs(inT * 30 - Math.round(inT * 30)) < 1e-6, '未对齐帧网格：' + inT);
});

test('帧吸附：出点顶到视频末尾时退回帧网格', async () => {
  const { M } = await setup({ fps: 30, duration: 100 });
  const r = M.addRange(10, 20, '段');
  M.setRangeBoundary(r.id, 'out', 200);
  const out = M.getRangeById(r.id).out;
  assert.ok(out <= 100, '不应超过时长，实际 ' + out);
  assert.ok(Math.abs(out * 30 - Math.round(out * 30)) < 1e-6, '未对齐帧网格：' + out);
});

test('帧吸附：帧率未知时区间边界行为与之前一致', async () => {
  const { M } = await setup({ duration: 100 });
  const r = M.addRange(10, 20, '段');
  M.setRangeBoundary(r.id, 'in', 15.017);
  assert.equal(M.getRangeById(r.id).in, 15.017, '未知帧率不应吸附');
  M.setRangeBoundary(r.id, 'out', 200);
  assert.equal(M.getRangeById(r.id).out, 100);
});
