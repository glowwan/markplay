'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeExportContext, MARKER_COLORS } = require('./helpers');

function marker(label, kind, time) {
  return { label, kind, time, color: MARKER_COLORS[kind] };
}

test('时间码：毫秒补零、整秒不带小数', () => {
  const { ctx } = makeExportContext();
  const tc = ctx.Exporter.tc;
  assert.equal(tc(0), '00:00:00.000');
  assert.equal(tc(3661.5), '01:01:01.500');
  assert.equal(tc(59.999), '00:00:59.999');
  assert.equal(tc(-3), '00:00:00.000');
});

test('EDL 帧时间码：25fps 非丢帧', () => {
  const { ctx } = makeExportContext();
  const f = ctx.Exporter.tcFrames;
  assert.equal(f(0), '00:00:00:00');
  assert.equal(f(1), '00:00:01:00');
  assert.equal(f(1.04), '00:00:01:01');
  assert.equal(f(3600), '01:00:00:00');
  assert.equal(f(3603), '01:00:03:00');
});

test('帧率换算：23.976/29.97/59.94 取整数名义帧率', () => {
  const { ctx } = makeExportContext();
  const N = ctx.Exporter.nominalFps;
  assert.equal(N(23.976), 24);
  assert.equal(N(24), 24);
  assert.equal(N(29.97), 30);
  assert.equal(N(59.94), 60);
  assert.equal(N(0), 25); // 未知时回退 25
  assert.equal(ctx.Exporter.tcFrames(1.5, 24), '00:00:01:12');
  assert.equal(ctx.Exporter.tcFrames(1.5, 30), '00:00:01:15');
});

test('segments：每段终点是下一个标记，最后一段 +10s 且不超过时长', () => {
  const { ctx } = makeExportContext();
  const segs = ctx.Exporter.segments(
    [marker('A1', 'A', 2), marker('B1', 'B', 5)],
    10
  );
  // 注意：脚本在 vm 沙盒里执行，返回的是另一个 realm 的数组，
  // 直接 deepStrictEqual 会因原型不同而失败，这里比较序列化结果。
  assert.equal(JSON.stringify(segs), JSON.stringify([
    { start: 2, end: 5 },
    { start: 5, end: 10 },
  ]));
});

test('CSV：表头、序号、秒数、帧号与时间码、标签转义', () => {
  const { ctx } = makeExportContext();
  const csv = ctx.Exporter.toCSV(
    [marker('A,1', 'A', 2), marker('B1', 'B', 5)],
    10
  );
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'index,label,kind,time_seconds,timecode,frame,end_seconds,end_tc');
  assert.equal(lines[1], '1,"A,1",A,2.000,00:00:02.000,50,5.000,00:00:05.000');
  assert.equal(lines[2], '2,B1,B,5.000,00:00:05.000,125,10.000,00:00:10.000');
});

test('CSV：帧号跟随素材帧率（24fps 时 2 秒 = 48 帧）', () => {
  const { ctx } = makeExportContext();
  const lines = ctx.Exporter.toCSV([marker('A1', 'A', 2)], 10, 23.976)
    .trimEnd().split('\n');
  assert.equal(lines[1].split(',')[5], '48');
});

test('EDL：CMX3600 头、帧率注释、事件行、FROM CLIP NAME', () => {
  const { ctx } = makeExportContext();
  const edl = ctx.Exporter.toEDL(
    [marker('A1', 'A', 2), marker('B1', 'B', 5)],
    10,
    'demo'
  );
  const lines = edl.trimEnd().split('\n');
  assert.equal(lines[0], 'TITLE: demo');
  assert.equal(lines[1], 'FCM: NON-DROP FRAME');
  assert.equal(lines[2], '* MARKPLAY FPS: 25');
  assert.equal(
    lines[4],
    '001  AX       V     C        00:00:02:00 00:00:05:00 01:00:00:00 01:00:03:00'
  );
  assert.equal(lines[5], '* FROM CLIP NAME: A1');
  assert.ok(lines[6].startsWith('002  AX       V     C        '));
});

test('JSON：结构稳定、可被 JSON.parse 还原', () => {
  const { ctx } = makeExportContext();
  const text = ctx.Exporter.toJSON([marker('A1', 'A', 2)], 10, 'demo');
  const data = JSON.parse(text);
  assert.equal(data.version, 2);
  assert.equal(data.video, 'demo');
  assert.equal(data.duration, 10);
  assert.equal(data.edlFps, 25);
  assert.equal(data.markers.length, 1);
  assert.equal(data.markers[0].startTc, '00:00:02.000');
  assert.equal(data.ranges.length, 0);
});

test('区间 CSV：in/out 秒数、时间码、帧号与时长', () => {
  const { ctx } = makeExportContext();
  const csv = ctx.Exporter.toRangesCSV([
    { name: '段,1', in: 2, out: 5 },
  ], 25);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'index,name,in_seconds,in_tc,in_frame,out_seconds,out_tc,out_frame,duration_seconds');
  assert.equal(lines[1], '1,"段,1",2.000,00:00:02.000,50,5.000,00:00:05.000,125,3.000');
});

test('区间 EDL：按显式区间生成事件行', () => {
  const { ctx } = makeExportContext();
  const edl = ctx.Exporter.toEDLRanges([
    { name: '段一', in: 2, out: 5 },
    { name: '段二', in: 6, out: 9 },
  ], 'demo');
  const lines = edl.trimEnd().split('\n');
  assert.equal(lines[0], 'TITLE: demo');
  assert.equal(lines[1], 'FCM: NON-DROP FRAME');
  assert.equal(lines[2], '* MARKPLAY FPS: 25');
  assert.equal(
    lines[4],
    '001  AX       V     C        00:00:02:00 00:00:05:00 01:00:00:00 01:00:03:00'
  );
  assert.equal(lines[5], '* FROM CLIP NAME: 段一');
  assert.equal(
    lines[6],
    '002  AX       V     C        00:00:06:00 00:00:09:00 01:00:03:00 01:00:06:00'
  );
});

test('JSON：标记与区间一起导出', () => {
  const { ctx } = makeExportContext();
  const data = JSON.parse(ctx.Exporter.toJSON(
    [marker('A1', 'A', 2)],
    10,
    'demo',
    25,
    [{ name: '段一', in: 2, out: 5 }]
  ));
  assert.equal(data.ranges.length, 1);
  assert.equal(data.ranges[0].name, '段一');
  assert.equal(data.ranges[0].inTc, '00:00:02.000');
  assert.equal(data.ranges[0].duration, 3);
});

test('pairRegions：A 配后续最近的 B', () => {
  const { ctx } = makeExportContext();
  const regions = ctx.Exporter.pairRegions([
    marker('A1', 'A', 1),
    marker('B1', 'B', 2),
    marker('A2', 'A', 4),
    marker('B2', 'B', 6),
  ]);
  assert.equal(regions.length, 2);
  assert.equal(JSON.stringify(regions.map((r) => [r.in.label, r.out.label])), JSON.stringify([
    ['A1', 'B1'],
    ['A2', 'B2'],
  ]));
});

test('pairRegions：没有 B 标记时按相邻两个分组', () => {
  const { ctx } = makeExportContext();
  const regions = ctx.Exporter.pairRegions([
    marker('C1', 'C', 1),
    marker('D1', 'D', 2),
    marker('F1', 'F', 3),
  ]);
  assert.equal(regions.length, 1);
  assert.equal(JSON.stringify([regions[0].in.label, regions[0].out.label]),
    JSON.stringify(['C1', 'D1']));
});

test('pairRegions：少于两个标记返回空数组', () => {
  const { ctx } = makeExportContext();
  assert.equal(ctx.Exporter.pairRegions([]).length, 0);
  assert.equal(ctx.Exporter.pairRegions([marker('A1', 'A', 1)]).length, 0);
});
