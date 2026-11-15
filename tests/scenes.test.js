'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererScript } = require('./helpers');

/** scenes.js 在 vm 沙盒里执行，返回的数组原型与宿主不同，统一用序列化比较 */
function makeScenes() {
  const ctx = loadRendererScript('scenes.js', { console });
  return ctx.Scenes;
}

const eq = (actual, expected) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), '实际 ' + JSON.stringify(actual));

const VIEW = { start: 0, end: 100 };

test('thin：全部落在窗口内且间距够时原样保留', () => {
  const S = makeScenes();
  // 宽度 1000px、跨度 100s → 1s = 10px，间距 8px 意味着 >0.8s 才保留
  eq(S.thin([0, 10, 20, 30], VIEW, 1000), [0, 10, 20, 30]);
});

test('thin：太密的点被跳过（避免浮标糊成一片）', () => {
  const S = makeScenes();
  // 0.1s 间隔 = 1px，远小于 8px
  eq(S.thin([0, 0.1, 0.2, 0.3, 0.4], VIEW, 1000), [0]);
});

test('thin：窗口外的点被过滤', () => {
  const S = makeScenes();
  eq(S.thin([5, 50, 95], { start: 40, end: 60 }, 1000), [50]);
});

test('thin：缩放后同一批点的保留结果不同（像素间距随之变化）', () => {
  const S = makeScenes();
  const times = [10, 10.5, 11];
  // 全片视图：1s = 10px。10 保留 → 10.5 距上次仅 5px 跳过 → 11 距上次 10px 又保留
  eq(S.thin(times, VIEW, 1000), [10, 11]);
  // 放大到 10s 窗口：0.5s = 50px → 全部保留
  eq(S.thin(times, { start: 5, end: 15 }, 1000), [10, 10.5, 11]);
});

test('thin：非法输入安全返回', () => {
  const S = makeScenes();
  eq(S.thin(null, VIEW, 1000), []);
  eq(S.thin([1, 2], VIEW, 0), []);
  eq(S.thin([1, 2], null, 1000), []);
  eq(S.thin([1, 2], { start: 10, end: 10 }, 1000), []);
  eq(S.thin([NaN, 3], VIEW, 1000), [3]);
});

test('thin：自定义间距生效', () => {
  const S = makeScenes();
  const times = [10, 10.5];
  eq(S.thin(times, VIEW, 1000, 100), [10], '100px 间距下两条都被跳过第二条');
  eq(S.thin(times, VIEW, 1000, 1), [10, 10.5]);
});

test('nearest：向后续方向找下一个转场', () => {
  const S = makeScenes();
  assert.equal(S.nearest([3, 6, 9], 4, 'next'), 6);
  assert.equal(S.nearest([3, 6, 9], 0, 'next'), 3);
});

test('nearest：向前找上一个转场', () => {
  const S = makeScenes();
  assert.equal(S.nearest([3, 6, 9], 7, 'prev'), 6);
  assert.equal(S.nearest([3, 6, 9], 100, 'prev'), 9);
});

test('nearest：没有更远/更近的点时返回 null', () => {
  const S = makeScenes();
  assert.equal(S.nearest([3, 6], 2, 'prev'), null);
  assert.equal(S.nearest([3, 6], 10, 'next'), null);
  assert.equal(S.nearest([], 5, 'next'), null);
  assert.equal(S.nearest(null, 5, 'prev'), null);
});

test('nearest：正好停在转场上时视为同一个点（避免原地跳）', () => {
  const S = makeScenes();
  assert.equal(S.nearest([3, 6], 6, 'next'), null, '已在 6 上，不该跳回 6');
  assert.equal(S.nearest([3, 6], 6, 'prev'), 3, '应该跳到前一个 3');
});
