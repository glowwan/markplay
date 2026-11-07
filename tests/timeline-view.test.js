'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererScript } = require('./helpers');

function makeView(duration) {
  const ctx = loadRendererScript('timeline-view.js', { console });
  const V = ctx.TimelineView;
  if (duration != null) V.setDuration(duration);
  return V;
}

test('默认显示全片，比例与时间可互转', () => {
  const V = makeView(100);
  const s = V.getState();
  assert.equal(s.start, 0);
  assert.equal(s.end, 100);
  assert.equal(s.full, true);
  assert.equal(V.toRatio(50), 0.5);
  assert.equal(V.toTime(0.25), 25);
});

test('缩放：锚点时间在窗口中的比例保持不变', () => {
  const V = makeView(100);
  V.zoomAt(0.5, 2); // 以中点放大 2 倍
  const s = V.getState();
  assert.equal(s.span, 50);
  assert.equal(s.start, 25);
  assert.equal(s.end, 75);

  // 以 20% 位置为锚点再放大
  const anchorBefore = V.toTime(0.2);
  V.zoomAt(0.2, 2);
  assert.ok(Math.abs(V.toTime(0.2) - anchorBefore) < 1e-9);
});

test('缩放有下限（0.5 秒），且不会越界', () => {
  const V = makeView(100);
  for (let i = 0; i < 20; i++) V.zoomIn(0.5);
  const s = V.getState();
  assert.ok(s.span >= 0.5 - 1e-9);
  assert.ok(s.start >= 0);
  assert.ok(s.end <= 100 + 1e-9);
});

test('平移会被夹在 [0, duration] 内', () => {
  const V = makeView(100);
  V.panBy(-50);
  assert.equal(V.getState().start, 0);
  V.panBy(1000);
  assert.equal(V.getState().end, 100);
});

test('keepVisible：窗口外返回 true 并居中，窗口内返回 false', () => {
  const V = makeView(100);
  V.zoomAt(0.5, 4); // span 25，窗口 37.5..62.5
  assert.equal(V.keepVisible(50), false);
  assert.equal(V.keepVisible(70), true);
  const s = V.getState();
  assert.ok(70 >= s.start && 70 <= s.end);
  assert.ok(Math.abs((s.start + s.end) / 2 - 70) < 1e-9);
});

test('setDuration：同一时长不重置缩放，换片才重置', () => {
  const V = makeView(100);
  V.zoomAt(0.5, 2);
  const span = V.getState().span;
  assert.equal(span, 50);

  V.setDuration(100.001); // 视为同一部片子（duration 事件可能重复）
  assert.equal(V.getState().span, 50);

  V.setDuration(200); // 换片
  const s = V.getState();
  assert.equal(s.span, 200);
  assert.equal(s.full, true);
});

test('没有视频时时长 0，setView 保持占位窗口不崩', () => {
  const V = makeView(0);
  assert.equal(V.getState().full, true);
  V.zoomAt(0.5, 2);
  assert.equal(V.getState().start, 0);
});
