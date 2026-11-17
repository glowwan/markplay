'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../src/resume');

// ---------------------------------------------------------------- 路径键

test('pathKey：Windows 大小写不敏感', () => {
  assert.equal(R.pathKey('C:\\V\\A.mp4'), 'c:\\v\\a.mp4');
  assert.equal(R.pathKey(''), '');
  assert.equal(R.pathKey(null), '');
});

// ---------------------------------------------------------------- 写入

test('putEntry：正常写入并保留两位小数', () => {
  const map = {};
  const ok = R.putEntry(map, 'C:\\V\\a.mp4', 123.456, 600, 1000);
  assert.equal(ok, true);
  assert.deepEqual(map['c:\\v\\a.mp4'], { t: 123.46, dur: 600, at: 1000 });
});

test('putEntry：总长未知时 dur 记 0', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 30, 0, 1000);
  assert.equal(map['c:\\v\\a.mp4'].dur, 0);
});

test('putEntry：看到结尾附近不记，并清掉旧记录', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 100, 600, 1000);
  const ok = R.putEntry(map, 'C:\\V\\a.mp4', 598, 600, 2000);
  assert.equal(ok, false);
  assert.equal(map['c:\\v\\a.mp4'], undefined);
});

test('putEntry：非法输入不写', () => {
  const map = {};
  assert.equal(R.putEntry(map, '', 10, 100, 1), false);
  assert.equal(R.putEntry(map, 'C:\\a.mp4', NaN, 100, 1), false);
  assert.equal(R.putEntry(map, 'C:\\a.mp4', -5, 100, 1), false);
  assert.equal(R.putEntry(null, 'C:\\a.mp4', 10, 100, 1), false);
  assert.deepEqual(map, {});
});

test('putEntry：超过上限时淘汰最旧的', () => {
  const map = {};
  for (let i = 0; i < R.MAX_ENTRIES + 5; i++) {
    R.putEntry(map, `C:\\V\\v${i}.mp4`, 10, 100, 1000 + i);
  }
  assert.equal(Object.keys(map).length, R.MAX_ENTRIES);
  // 最早的 5 条被淘汰
  assert.equal(map['c:\\v\\v0.mp4'], undefined);
  assert.equal(map['c:\\v\\v4.mp4'], undefined);
  // 最新的一定在
  assert.ok(map[`c:\\v\\v${R.MAX_ENTRIES + 4}.mp4`]);
});

// ---------------------------------------------------------------- 读取

test('getEntry：大小写不同也能取到', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 42, 600, 1000);
  assert.deepEqual(R.getEntry(map, 'c:\\v\\A.MP4'), { t: 42, dur: 600, at: 1000 });
});

test('getEntry：找不到返回 null', () => {
  assert.equal(R.getEntry({}, 'C:\\x.mp4'), null);
  assert.equal(R.getEntry(null, 'C:\\x.mp4'), null);
});

// ---------------------------------------------------------------- 是否续播

test('resumeAt：正常位置返回该秒数', () => {
  assert.equal(R.resumeAt({ t: 120, dur: 600, at: 1 }), 120);
});

test('resumeAt：太靠前（< MIN_SECONDS）不续播', () => {
  assert.equal(R.resumeAt({ t: 3, dur: 600, at: 1 }), 0);
  assert.equal(R.resumeAt({ t: R.MIN_SECONDS - 0.1, dur: 600, at: 1 }), 0);
});

test('resumeAt：正好等于 MIN_SECONDS 可以续播', () => {
  assert.equal(R.resumeAt({ t: R.MIN_SECONDS, dur: 600, at: 1 }), R.MIN_SECONDS);
});

test('resumeAt：已在结尾附近不续播（已经看完了）', () => {
  assert.equal(R.resumeAt({ t: 597, dur: 600, at: 1 }), 0);
  assert.equal(R.resumeAt({ t: 600, dur: 600, at: 1 }), 0);
});

test('resumeAt：总长未知时只看下限', () => {
  assert.equal(R.resumeAt({ t: 500, dur: 0, at: 1 }), 500);
});

test('resumeAt：坏数据返回 0', () => {
  assert.equal(R.resumeAt(null), 0);
  assert.equal(R.resumeAt({}), 0);
  assert.equal(R.resumeAt({ t: 'x' }), 0);
});

// ---------------------------------------------------------------- 归一化整个表

test('normalizeMap：丢掉坏数据', () => {
  const m = R.normalizeMap({
    'c:\\a.mp4': { t: 10, dur: 100, at: 5 },
    'c:\\b.mp4': { t: 'bad' },
    'c:\\c.mp4': null,
    '': { t: 10 },
  });
  assert.deepEqual(Object.keys(m), ['c:\\a.mp4']);
});

test('normalizeMap：按时间戳倒序并截断到上限', () => {
  const raw = {};
  for (let i = 0; i < R.MAX_ENTRIES + 10; i++) {
    raw[`c:\\v${i}.mp4`] = { t: 10, dur: 100, at: i };
  }
  const m = R.normalizeMap(raw);
  assert.equal(Object.keys(m).length, R.MAX_ENTRIES);
  // 保留时间戳最大的那些
  assert.ok(m[`c:\\v${R.MAX_ENTRIES + 9}.mp4`]);
  assert.equal(m['c:\\v0.mp4'], undefined);
});

test('normalizeMap：非对象输入返回空表', () => {
  assert.deepEqual(R.normalizeMap(null), {});
  assert.deepEqual(R.normalizeMap('x'), {});
  assert.deepEqual(R.normalizeMap([]), {});
});

test('clearEntry：删除存在的条目', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 42, 600, 1000);
  assert.equal(R.clearEntry(map, 'c:\\v\\A.mp4'), true);
  assert.equal(R.getEntry(map, 'C:\\V\\a.mp4'), null);
  assert.equal(R.clearEntry(map, 'C:\\V\\a.mp4'), false);
});

// ---------------------------------------------------------------- 完整流程

test('完整流程：看到一半关掉 -> 下次续播', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 123.4, 600, 1000);
  const at = R.resumeAt(R.getEntry(map, 'C:\\V\\a.mp4'));
  assert.equal(at, 123.4);
});

test('完整流程：看完了关掉 -> 下次从头', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 599, 600, 1000);
  const at = R.resumeAt(R.getEntry(map, 'C:\\V\\a.mp4'));
  assert.equal(at, 0);
});

test('完整流程：选择从头开始 -> 记录被清掉', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 123, 600, 1000);
  R.clearEntry(map, 'C:\\V\\a.mp4');
  assert.equal(R.resumeAt(R.getEntry(map, 'C:\\V\\a.mp4')), 0);
});

// ---------------------------------------------------------------- 回归：这次发现的 bug

test('回归：时长未知时用已有记录的时长判断"已到结尾"', () => {
  // 场景：换片/重开视频时 currentDuration 被提前清 0，
  // 于是 flush 时传进来的是 dur=0。若不兜底，片尾位置会被存成续播点。
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 300, 600, 1000);   // 先有一条正常的
  const wrote = R.putEntry(map, 'C:\\V\\a.mp4', 599, 0, 2000); // 到结尾，但时长没传
  assert.equal(wrote, false, '应判定为已看完，不写入');
  assert.equal(map['c:\\v\\a.mp4'], undefined, '旧记录也应被清掉');
});

test('回归：时长未知时（无历史记录）仍允许写入', () => {
  // 流媒体等情况确实拿不到 duration，不能因此完全不记
  const map = {};
  assert.equal(R.putEntry(map, 'C:\\V\\s.mp4', 120, 0, 1000), true);
  assert.equal(map['c:\\v\\s.mp4'].t, 120);
});

test('回归：写入容差 3 秒、续播容差 15 秒（续播更严格）', () => {
  const map = {};
  // 597/600：距离结尾 3 秒 -> 写入时就当作看完了
  R.putEntry(map, 'C:\\V\\a.mp4', 597, 600, 1000);
  assert.equal(map['c:\\v\\a.mp4'], undefined);

  // 590/600：能写进去（距离 10 秒），但续播时要拒绝（< 15 秒容差）
  const map2 = {};
  assert.equal(R.putEntry(map2, 'C:\\V\\b.mp4', 590, 600, 1000), true);
  assert.equal(R.resumeAt(R.getEntry(map2, 'C:\\V\\b.mp4')), 0, '距结尾 10 秒不该续播');

  // 580/600：距离 20 秒，正常续播
  const map3 = {};
  R.putEntry(map3, 'C:\\V\\c.mp4', 580, 600, 1000);
  assert.equal(R.resumeAt(R.getEntry(map3, 'C:\\V\\c.mp4')), 580);
});

test('回归：恰好落在两个容差边界上', () => {
  // 写入边界：pos = dur - 3 视为看完
  const map = {};
  assert.equal(R.putEntry(map, 'C:\\V\\a.mp4', 597, 600, 1), false);
  assert.equal(R.putEntry(map, 'C:\\V\\a.mp4', 596.9, 600, 1), true);

  // 续播边界：pos = dur - 15 视为到结尾
  assert.equal(R.resumeAt({ t: 585, dur: 600 }), 0);
  assert.equal(R.resumeAt({ t: 584.9, dur: 600 }), 584.9);
});
