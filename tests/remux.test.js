'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RM = require('../src/remux');

// ---------------------------------------------------------------- 扩展名判断

test('needsIndex：常见无索引容器都算', () => {
  for (const f of ['a.ts', 'a.TS', 'b.m2ts', 'c.mts', 'd.vob', 'e.mpg', 'f.mpeg', 'g.flv']) {
    assert.equal(RM.needsIndex(f), true, f);
  }
});

test('needsIndex：有索引的容器不算', () => {
  for (const f of ['a.mp4', 'a.mkv', 'a.mov', 'a.webm', 'a.mp3', 'a.wav']) {
    assert.equal(RM.needsIndex(f), false, f);
  }
});

test('needsIndex：没有扩展名 / 非法输入不算', () => {
  assert.equal(RM.needsIndex('C:\\V\\noext'), false);
  assert.equal(RM.needsIndex(''), false);
  assert.equal(RM.needsIndex(null), false);
});

test('extOf：取小写扩展名', () => {
  assert.equal(RM.extOf('C:\\V\\A.MP4'), 'mp4');
  assert.equal(RM.extOf('x.tar.gz'), 'gz');
  assert.equal(RM.extOf('noext'), '');
});

// ---------------------------------------------------------------- 输出路径

test('buildOutputPath：同目录、同基名 + .indexed.mp4', () => {
  assert.equal(
    RM.buildOutputPath('C:\\Videos\\trip.ts'),
    'C:\\Videos\\trip.indexed.mp4'
  );
});

test('buildOutputPath：正斜杠路径也支持', () => {
  assert.equal(RM.buildOutputPath('/home/u/trip.ts'), '/home/u/trip.indexed.mp4');
});

test('buildOutputPath：不覆盖已存在的文件，自动加序号', () => {
  const existing = new Set(['C:\\V\\a.indexed.mp4']);
  assert.equal(
    RM.buildOutputPath('C:\\V\\a.ts', (p) => existing.has(p)),
    'C:\\V\\a.indexed-2.mp4'
  );
});

test('buildOutputPath：序号用完后仍然不覆盖（退到时间戳）', () => {
  const always = () => true;
  const out = RM.buildOutputPath('C:\\V\\a.ts', always);
  assert.ok(/a\.indexed-\d{6,}\.mp4$/.test(out), out);
});

test('buildOutputPath：基名里有多个点也能处理', () => {
  assert.equal(
    RM.buildOutputPath('C:\\V\\my.trip.2026.ts'),
    'C:\\V\\my.trip.2026.indexed.mp4'
  );
});

test('buildOutputPath：空输入返回空串', () => {
  assert.equal(RM.buildOutputPath(''), '');
  assert.equal(RM.buildOutputPath(null), '');
});

// ---------------------------------------------------------------- ffmpeg 参数

test('remuxArgs：流拷贝 + faststart，绝不重编码', () => {
  const a = RM.remuxArgs('in.ts', 'out.mp4');
  assert.ok(a.includes('-c'));
  assert.equal(a[a.indexOf('-c') + 1], 'copy', '必须是 -c copy');
  assert.equal(a[a.indexOf('-movflags') + 1], '+faststart');
  assert.ok(!a.includes('-crf'), '不能出现质量参数');
  assert.ok(!a.some((x) => /libx264|libx265|aac|libmp3lame/.test(x)), '不能出现编码器');
  assert.equal(a[a.length - 1], 'out.mp4', '输出路径在最后');
  assert.ok(a.includes('in.ts'));
});

// ---------------------------------------------------------------- 进度解析

test('parseProgressPercent：按 out_time_ms 换算百分比', () => {
  assert.equal(RM.parseProgressPercent('out_time_ms=5000000', 20), 25);
  assert.equal(RM.parseProgressPercent('out_time_ms=20000000', 20), 100);
  assert.equal(RM.parseProgressPercent('out_time_ms=0', 20), 0);
});

test('parseProgressPercent：百分数夹在 0-100', () => {
  assert.equal(RM.parseProgressPercent('out_time_ms=60000000', 20), 100);
});

test('parseProgressPercent：无关行 / 缺时长返回 null', () => {
  assert.equal(RM.parseProgressPercent('frame=100', 20), null);
  assert.equal(RM.parseProgressPercent('out_time_ms=5000000', 0), null);
  assert.equal(RM.parseProgressPercent('', 20), null);
  assert.equal(RM.parseProgressPercent(null, 20), null);
});
