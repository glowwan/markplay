'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSceneScores } = require('../src/media-utils');

/** 真实 metadata=print 输出的一个块（两行） */
const BLOCK = (frame, t, score) =>
  `frame:${frame}    pts:${frame * 512}    pts_time:${t}\nlavfi.scene_score=${score}`;

test('parseSceneScores：按块解析出时间与分数', () => {
  // 注意：第一帧 score 为 0 时会被默认 floor(0.01) 丢掉，这里用 0.05 保证三条都保留
  const text = [BLOCK(0, '0', '0.050000'), BLOCK(75, '3', '0.718990'), BLOCK(150, '6', '0.743877')]
    .join('\n');
  const got = parseSceneScores(text);
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((x) => x.t), [0, 3, 6]);
  assert.equal(got[1].score, 0.71899);
  assert.ok(Math.abs(got[2].score - 0.743877) < 1e-9);
});

test('parseSceneScores：score 恰好等于 0 的帧被 floor 丢弃', () => {
  const got = parseSceneScores(BLOCK(0, '0', '0.000000') + '\n' + BLOCK(75, '3', '0.7'));
  assert.equal(got.length, 1);
  assert.equal(got[0].t, 3);
});

test('parseSceneScores：低于 floor 的帧被丢弃（省内存）', () => {
  const text = [BLOCK(0, '0', '0.001000'), BLOCK(10, '0.4', '0.200000')].join('\n');
  assert.equal(parseSceneScores(text, { floor: 0.01 }).length, 1);
  assert.equal(parseSceneScores(text, { floor: 0.5 }).length, 0);
  // 默认 floor 是 0.01，所以 0.001 会被丢掉
  assert.equal(parseSceneScores(text).length, 1);
});

test('parseSceneScores：max 限制条数', () => {
  const text = Array.from({ length: 10 }, (_, i) => BLOCK(i, String(i), '0.5')).join('\n');
  assert.equal(parseSceneScores(text, { max: 3 }).length, 3);
});

test('parseSceneScores：没有配套时间行的分数被忽略', () => {
  const text = 'lavfi.scene_score=0.9\n' + BLOCK(1, '1', '0.5');
  const got = parseSceneScores(text);
  assert.equal(got.length, 1);
  assert.equal(got[0].t, 1);
});

test('parseSceneScores：忽略无关行与负时间', () => {
  const text = [
    'ffmpeg version 9.0.2',
    'frame:0 pts:0 pts_time:-1',
    'lavfi.scene_score=0.9',
    BLOCK(5, '2', '0.3'),
  ].join('\n');
  const got = parseSceneScores(text);
  assert.equal(got.length, 1);
  assert.equal(got[0].t, 2);
});

test('parseSceneScores：空输入与非法输入返回空数组', () => {
  assert.deepEqual(parseSceneScores(''), []);
  assert.deepEqual(parseSceneScores(null), []);
  assert.deepEqual(parseSceneScores(undefined), []);
  assert.deepEqual(parseSceneScores(42), []);
});

test('parseSceneScores：时间保留三位毫秒', () => {
  const got = parseSceneScores(BLOCK(1, '12.345678', '0.5'));
  assert.equal(got[0].t, 12.346);
});

test('parseSceneScores：分成两段解析再合并，不会漏也不会重', () => {
  const a = BLOCK(0, '1', '0.2');
  const b = BLOCK(1, '2', '0.3');
  const part1 = parseSceneScores(a);
  const part2 = parseSceneScores(b);
  const merged = part1.concat(part2).map((x) => x.t);
  assert.deepEqual(merged, [1, 2]);
});

test('parseSceneScores：只在 pts_time 行之后紧跟的分数行才配对', () => {
  // 分数行出现在时间行之前，不应配对
  const text = 'lavfi.scene_score=0.8\nframe:0 pts:0 pts_time:4\n';
  assert.deepEqual(parseSceneScores(text), []);
});
