'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUDIO_BPS,
  MAX_VIDEO_BPS,
  estimateVideoBitrate,
  extensionOf,
  findMediaArg,
  isMediaPath,
  isSubtitlePath,
  reencodeArgs,
  toConcatLine,
} = require('../src/media-utils');

// ---------- 扩展名判定 ----------

test('extensionOf：取小写扩展名，无扩展名返回空串', () => {
  assert.equal(extensionOf('C:\\v\\a.MP4'), 'mp4');
  assert.equal(extensionOf('a.mkv'), 'mkv');
  assert.equal(extensionOf('C:\\v\\noext'), '');
  assert.equal(extensionOf(''), '');
  assert.equal(extensionOf(null), '');
});

test('isMediaPath：常见视频/音频都算，字幕和图片不算', () => {
  for (const f of ['a.mp4', 'a.MKV', 'a.ts', 'a.m2ts', 'a.flac', 'a.opus']) {
    assert.equal(isMediaPath(f), true, f + ' 应为媒体');
  }
  for (const f of ['a.srt', 'a.jpg', 'a.txt', 'noext']) {
    assert.equal(isMediaPath(f), false, f + ' 不应为媒体');
  }
});

test('isSubtitlePath：字幕扩展名全部识别', () => {
  for (const f of ['a.srt', 'a.ASS', 'a.ssa', 'a.vtt', 'a.sub', 'a.idx', 'a.sup']) {
    assert.equal(isSubtitlePath(f), true, f + ' 应为字幕');
  }
  assert.equal(isSubtitlePath('a.mp4'), false);
  assert.equal(isSubtitlePath(''), false);
});

// ---------- 命令行参数解析 ----------

test('findMediaArg：跳过开关参数与不存在的路径，取最后一个媒体文件', () => {
  const exists = (p) => ['C:\\v\\a.mp4', 'C:\\v\\b.mkv', 'C:\\v\\c.srt'].includes(p);
  const argv = ['electron.exe', '.', '--flag', 'C:\\v\\a.mp4', 'C:\\v\\b.mkv'];
  const got = findMediaArg(argv, { resolve: (p) => p, exists });
  assert.equal(got, 'C:\\v\\b.mkv');
});

test('findMediaArg：字幕文件不会被当成要打开的视频', () => {
  const exists = () => true;
  const argv = ['electron.exe', 'C:\\v\\c.srt'];
  assert.equal(findMediaArg(argv, { resolve: (p) => p, exists }), '');
});

test('findMediaArg：没有可用文件时返回空串', () => {
  assert.equal(findMediaArg([], { resolve: (p) => p, exists: () => true }), '');
  assert.equal(findMediaArg(null, { resolve: (p) => p, exists: () => true }), '');
  assert.equal(
    findMediaArg(['electron.exe', '--only-flags'], { resolve: (p) => p, exists: () => true }),
    ''
  );
});

test('findMediaArg：resolve 抛错时跳过该参数，不中断', () => {
  const resolve = (p) => {
    if (p === 'bad') throw new Error('boom');
    return p;
  };
  const got = findMediaArg(['electron.exe', 'bad', 'C:\\v\\a.mp4'], { resolve, exists: () => true });
  assert.equal(got, 'C:\\v\\a.mp4');
});

// ---------- 码率估算 ----------

test('estimateVideoBitrate：正常文件按体积/时长扣掉音轨', () => {
  // 165 MB / 37 分钟 ≈ 594 kbps，扣掉 96k 音轨 ≈ 498 kbps
  const bytes = 165 * 1024 * 1024;
  const sec = 37 * 60;
  const bps = estimateVideoBitrate(bytes, sec);
  const expected = Math.round((bytes * 8) / sec) - AUDIO_BPS;
  assert.equal(bps, expected);
  assert.ok(bps > 400000 && bps < 600000, '实际 ' + bps);
});

test('estimateVideoBitrate：码率过低时按 70% 兜底，不会出现负值', () => {
  // 总码率 150kbps：扣掉 96k 音轨只剩 54k，触发 70% 兜底
  const bytes = 11_250_000; // 8 * 150000 * 600 / 8
  const sec = 600;
  const totalBps = (bytes * 8) / sec;
  assert.equal(totalBps, 150000, '前置条件：总码率应为 150kbps');

  const bps = estimateVideoBitrate(bytes, sec);
  assert.ok(bps > 0, '不应为负或 0，实际 ' + bps);
  assert.equal(bps, Math.max(80000, Math.round(totalBps * 0.7)));
  assert.ok(bps < totalBps, '兜底后仍应小于总码率');
});

test('estimateVideoBitrate：异常输入一律返回 0（调用方回退 CRF）', () => {
  assert.equal(estimateVideoBitrate(0, 100), 0);
  assert.equal(estimateVideoBitrate(1000, 100), 0, '小于 1KB 视为无效');
  assert.equal(estimateVideoBitrate(10 * 1024 * 1024, 1), 0, '时长小于 2 秒无法估算');
  assert.equal(estimateVideoBitrate(NaN, 100), 0);
  assert.equal(estimateVideoBitrate(10 * 1024 * 1024, NaN), 0);
  assert.equal(estimateVideoBitrate(10 * 1024 * 1024, 0), 0);
});

test('estimateVideoBitrate：上限封顶', () => {
  const bps = estimateVideoBitrate(Number.MAX_SAFE_INTEGER, 3);
  assert.equal(bps, MAX_VIDEO_BPS);
});

// ---------- ffmpeg 参数 ----------

test('reencodeArgs：有目标码率时用 ABR 参数', () => {
  const args = reencodeArgs(500000);
  assert.ok(args.includes('-b:v'));
  assert.equal(args[args.indexOf('-b:v') + 1], '500000');
  assert.equal(args[args.indexOf('-maxrate') + 1], '600000');
  assert.equal(args[args.indexOf('-bufsize') + 1], '1000000');
  assert.equal(args[args.indexOf('-b:a') + 1], '96k');
  assert.ok(!args.includes('-crf'), '不该同时出现 crf');
});

test('reencodeArgs：码率为 0 时回退 CRF 23', () => {
  for (const v of [0, -1, NaN, undefined]) {
    const args = reencodeArgs(v);
    assert.equal(args[args.indexOf('-crf') + 1], '23');
    assert.ok(!args.includes('-b:v'));
  }
});

test('reencodeArgs：两次调用互不影响（无共享状态）', () => {
  const a = reencodeArgs(300000);
  const b = reencodeArgs(0);
  assert.notDeepEqual(a, b);
  assert.equal(reencodeArgs(300000).indexOf('-b:v'), a.indexOf('-b:v'));
});

// ---------- concat 列表 ----------

test('toConcatLine：反斜杠转正斜杠并加引号', () => {
  assert.equal(
    toConcatLine('C:\\Users\\a\\part_01.mp4'),
    "file 'C:/Users/a/part_01.mp4'"
  );
});

test('toConcatLine：路径含单引号时按 ffmpeg 规则转义', () => {
  const line = toConcatLine("C:\\v\\it's.mp4");
  assert.equal(line, "file 'C:/v/it'\\''s.mp4'");
});
