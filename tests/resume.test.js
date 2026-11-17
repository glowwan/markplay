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

test('putEntry：时长未知时沿用已有记录的时长', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 100, 600, 1000);
  R.putEntry(map, 'C:\\V\\a.mp4', 200, 0, 2000);
  assert.equal(map['c:\\v\\a.mp4'].dur, 600, '不该把已知时长覆盖成 0');
  assert.equal(map['c:\\v\\a.mp4'].t, 200);
});

test('putEntry：非法输入不写', () => {
  const map = {};
  assert.equal(R.putEntry(map, '', 10, 100, 1), false);
  assert.equal(R.putEntry(map, 'C:\\a.mp4', NaN, 100, 1), false);
  assert.equal(R.putEntry(map, 'C:\\a.mp4', -5, 100, 1), false);
  assert.equal(R.putEntry(null, 'C:\\a.mp4', 10, 100, 1), false);
  assert.deepEqual(map, {});
});

test('putEntry：停在片尾前几秒也会照常记录（不猜测"看完了"）', () => {
  const map = {};
  assert.equal(R.putEntry(map, 'C:\\V\\a.mp4', 598, 600, 1000), true);
  assert.equal(map['c:\\v\\a.mp4'].t, 598);
  assert.equal(R.putEntry(map, 'C:\\V\\a.mp4', 600, 600, 2000), true);
  assert.equal(map['c:\\v\\a.mp4'].t, 600);
});

test('putEntry：超过上限时淘汰最旧的', () => {
  const map = {};
  for (let i = 0; i < R.MAX_ENTRIES + 5; i++) {
    R.putEntry(map, `C:\\V\\v${i}.mp4`, 10, 100, 1000 + i);
  }
  assert.equal(Object.keys(map).length, R.MAX_ENTRIES);
  assert.equal(map['c:\\v\\v0.mp4'], undefined);
  assert.equal(map['c:\\v\\v4.mp4'], undefined);
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

test('resumeAt：停在片尾附近照样续播（只有 EOF 才算看完）', () => {
  assert.equal(R.resumeAt({ t: 598, dur: 600, at: 1 }), 598);
  assert.equal(R.resumeAt({ t: 599.9, dur: 600, at: 1 }), 599.9);
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
  assert.equal(R.resumeAt(R.getEntry(map, 'C:\\V\\a.mp4')), 123.4);
});

test('完整流程：停在片尾前 10 秒关掉 -> 下次从那里继续（用户要求）', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 590, 600, 1000);
  assert.equal(R.resumeAt(R.getEntry(map, 'C:\\V\\a.mp4')), 590);
});

test('完整流程：播完（EOF）由主进程清记录 -> 下次从头', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 588, 600, 1000);
  // 播到结尾触发 EOF：主进程调用 clearEntry
  R.clearEntry(map, 'C:\\V\\a.mp4');
  assert.equal(R.resumeAt(R.getEntry(map, 'C:\\V\\a.mp4')), 0);
});

test('完整流程：选择从头开始 -> 记录被清掉', () => {
  const map = {};
  R.putEntry(map, 'C:\\V\\a.mp4', 123, 600, 1000);
  R.clearEntry(map, 'C:\\V\\a.mp4');
  assert.equal(R.resumeAt(R.getEntry(map, 'C:\\V\\a.mp4')), 0);
});
