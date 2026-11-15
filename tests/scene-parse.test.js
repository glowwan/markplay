'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseShowinfoTimes } = require('../src/media-utils');

/** 真实 ffmpeg 输出的一行（节选，字段与实机一致） */
const LINE = (n, t) =>
  `[Parsed_showinfo_1 @ 0000022cad145980] n:   ${n} pts:  76800 pts_time:${t}       ` +
  `duration:    512 duration_time:0.04    fmt:yuv420p cl:left sar:1/1 s:640x360 i:P iskey:1`;

test('parseShowinfoTimes：从真实格式的 showinfo 行里取出时间', () => {
  const text = [LINE(0, '3'), LINE(1, '6')].join('\n');
  assert.deepEqual(parseShowinfoTimes(text), [3, 6]);
});

test('parseShowinfoTimes：小数与乱序输入都能处理，结果升序', () => {
  const text = [LINE(0, '6.5'), LINE(1, '1.25'), LINE(2, '3')].join('\n');
  assert.deepEqual(parseShowinfoTimes(text), [1.25, 3, 6.5]);
});

test('parseShowinfoTimes：重复行去重', () => {
  const text = [LINE(0, '3'), LINE(0, '3'), LINE(1, '6')].join('\n');
  assert.deepEqual(parseShowinfoTimes(text), [3, 6]);
});

test('parseShowinfoTimes：忽略非 showinfo 行与负值', () => {
  const text = [
    'ffmpeg version 9.0.2 Copyright (c) 2000-2026',
    '[in#0 @ 0x1] Duration: 00:00:09.00',
    LINE(0, '3'),
    '[Parsed_showinfo_1 @ 0x2] n:   1 pts: -10 pts_time:-0.4',
    'frame=   10 fps=0.0',
  ].join('\n');
  assert.deepEqual(parseShowinfoTimes(text), [3]);
});

test('parseShowinfoTimes：空输入与非法输入返回空数组', () => {
  assert.deepEqual(parseShowinfoTimes(''), []);
  assert.deepEqual(parseShowinfoTimes(null), []);
  assert.deepEqual(parseShowinfoTimes(undefined), []);
  assert.deepEqual(parseShowinfoTimes(123), []);
});

test('parseShowinfoTimes：max 限制条数', () => {
  const text = Array.from({ length: 20 }, (_, i) => LINE(i, String(i + 1))).join('\n');
  const got = parseShowinfoTimes(text, 5);
  assert.equal(got.length, 5);
  // 因为是在解析过程中 break，保留的是先出现的 5 个
  assert.deepEqual(got, [1, 2, 3, 4, 5]);
});

test('parseShowinfoTimes：按行切分的流式喂入能拼出完整结果', () => {
  const lines = [LINE(0, '3'), LINE(1, '6'), LINE(2, '9')];
  const text = lines.join('\n');
  // 主进程按 \n 切行后再喂给解析器，这里模拟同样的切法
  const boundary = text.indexOf('\n') + 1;
  const a = parseShowinfoTimes(text.slice(0, boundary));
  const b = parseShowinfoTimes(text.slice(boundary));
  const merged = Array.from(new Set([...a, ...b])).sort((x, y) => x - y);
  assert.deepEqual(merged, [3, 6, 9]);
});

test('parseShowinfoTimes：半行（缺结尾）不会被误解析——调用方负责按行缓冲', () => {
  const full = LINE(0, '3');
  const half = full.slice(0, full.indexOf('pts_time:') + 5);
  assert.deepEqual(parseShowinfoTimes(half), [], '不完整的行不应产生数据');
  assert.deepEqual(parseShowinfoTimes(full), [3], '完整的行才解析');
});

test('parseShowinfoTimes：毫秒精度保留三位', () => {
  const text = LINE(0, '12.345678');
  assert.deepEqual(parseShowinfoTimes(text), [12.346]);
});
