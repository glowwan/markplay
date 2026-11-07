'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeMarkersContext } = require('./helpers');

test('打点：同一类型序号递增、时间来自播放位置', async () => {
  const { ctx } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 12.5 });
  await M.loadSidecar('C:\\v\\a.mp4');

  const a1 = M.add('A');
  const a2 = M.add('A');
  const b1 = M.add('B');

  assert.equal(a1.label, 'A1');
  assert.equal(a2.label, 'A2');
  assert.equal(b1.label, 'B1');
  assert.equal(a1.time, 12.5);
  assert.equal(M.count(), 3);
});

test('打点：时间被钳制在 [0, duration]', async () => {
  const { ctx } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 500 });
  await M.loadSidecar('C:\\v\\a.mp4');
  M.setDuration(100);

  const m = M.add('C');
  assert.equal(m.time, 100);
});

test('未打开视频时拒绝打点', () => {
  const { ctx } = makeMarkersContext();
  assert.equal(ctx.Markers.add('A'), null);
});

test('撤销 / 重做：新增、删除、重命名都可回退', async () => {
  const { ctx } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 1 });
  await M.loadSidecar('C:\\v\\a.mp4');

  const a1 = M.add('A');
  assert.equal(M.count(), 1);

  M.remove(a1.id);
  assert.equal(M.count(), 0);

  assert.equal(M.undo(), true); // 撤销删除
  assert.equal(M.count(), 1);

  assert.equal(M.undo(), true); // 撤销新增
  assert.equal(M.count(), 0);

  assert.equal(M.redo(), true); // 重做新增
  assert.equal(M.count(), 1);

  assert.equal(M.redo(), true); // 重做删除
  assert.equal(M.count(), 0);
});

test('撤销：重命名也能回退', async () => {
  const { ctx } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 1 });
  await M.loadSidecar('C:\\v\\a.mp4');

  const m = M.add('A');
  M.rename(m.id, '开场');
  assert.equal(M.getById(m.id).label, '开场');

  M.undo();
  assert.equal(M.getById(m.id).label, 'A1');
});

test('sidecar：追加在视频文件名后，内容含标记数组', async () => {
  const { ctx, writes } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 3 });
  await M.loadSidecar('C:\\v\\旅行.mp4');
  M.add('A');

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, 'C:\\v\\旅行.mp4.markplay.json');
  assert.equal(writes[0].payload.version, 2);
  assert.equal(writes[0].payload.video, '旅行.mp4');
  assert.equal(writes[0].payload.markers.length, 1);
  assert.equal(writes[0].payload.markers[0].kind, 'A');
  assert.equal(writes[0].payload.ranges.length, 0);
});

test('sidecar：读取时恢复标记并从标签数字续号', async () => {
  const { ctx, setSidecar } = makeMarkersContext();
  setSidecar({
    version: 1,
    video: 'a.mp4',
    markers: [
      { id: 'x1', label: 'A7', time: 1, kind: 'A', color: '#ff5252' },
      { id: 'x2', label: 'B2', time: 4, kind: 'B', color: '#69f0ae' },
    ],
  });
  const M = ctx.Markers;
  M.init({ timeProvider: () => 9 });
  const n = await M.loadSidecar('C:\\v\\a.mp4');

  assert.equal(n, 2);
  assert.equal(M.count(), 2);
  assert.equal(M.add('A').label, 'A8');
  assert.equal(M.add('B').label, 'B3');
});

test('sidecar：坏数据静默忽略，不影响启动', async () => {
  const { ctx, setSidecar } = makeMarkersContext();
  setSidecar({ version: 1, markers: [{ label: 'no-time' }, null, { time: 2, kind: 'Z' }] });
  const M = ctx.Markers;
  M.init({ timeProvider: () => 0 });
  const n = await M.loadSidecar('C:\\v\\a.mp4');

  assert.equal(n, 1);
  assert.equal(M.getSorted()[0].kind, 'A'); // 未知 kind 归一为 A
});

test('拖动改时间：setTime 钳制并可在不重绘时只改数据', async () => {
  const { ctx } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 1 });
  await M.loadSidecar('C:\\v\\a.mp4');
  M.setDuration(60);
  const m = M.add('A');

  M.setTime(m.id, 20, { render: false });
  assert.equal(M.getById(m.id).time, 20);

  M.setTime(m.id, 999);
  assert.equal(M.getById(m.id).time, 60);

  M.setTime(m.id, -5);
  assert.equal(M.getById(m.id).time, 0);
});

test('区间：新建、参数校验、删除与撤销', async () => {
  const { ctx, writes } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 1 });
  await M.loadSidecar('C:\\v\\a.mp4');
  M.setDuration(100);

  const r = M.addRange(10, 20, '开场');
  assert.equal(r.name, '开场');
  assert.equal(r.in, 10);
  assert.equal(r.out, 20);
  assert.equal(M.getRanges().length, 1);

  // 出点必须大于入点；非法参数不入库
  assert.equal(M.addRange(20, 10), null);
  assert.equal(M.addRange(5, 5), null);
  assert.equal(M.getRanges().length, 1);

  // 时间被钳制在 [0, duration]
  const capped = M.addRange(90, 500);
  assert.equal(capped.out, 100);
  M.removeRange(capped.id);

  // sidecar v2 里带 ranges
  assert.equal(writes[writes.length - 1].payload.version, 2);
  assert.equal(writes[writes.length - 1].payload.ranges[0].name, '开场');

  M.removeRange(r.id);
  assert.equal(M.getRanges().length, 0);
  assert.equal(M.undo(), true);
  assert.equal(M.getRanges().length, 1);
});

test('sidecar：v2 区间可读回，v1 老文件没有区间也能用', async () => {
  const { ctx, setSidecar } = makeMarkersContext();
  setSidecar({
    version: 2,
    markers: [{ id: 'm1', label: 'A1', time: 1, kind: 'A' }],
    ranges: [
      { id: 'r1', name: '段一', in: 2, out: 5 },
      { id: 'r2', name: '坏数据', in: 9, out: 3 },
    ],
  });
  const M = ctx.Markers;
  M.init({ timeProvider: () => 0 });
  await M.loadSidecar('C:\\v\\a.mp4');

  const ranges = M.getRanges();
  assert.equal(ranges.length, 1); // out<=in 的那条被丢弃
  assert.equal(ranges[0].name, '段一');
  assert.equal(ranges[0].in, 2);
});

test('区间边界：拖动改 in/out，夹住另一端并可撤销', async () => {
  const { ctx } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: () => 1 });
  await M.loadSidecar('C:\\v\\a.mp4');
  M.setDuration(100);
  const r = M.addRange(10, 20, '段');

  M.setRangeBoundary(r.id, 'in', 15);
  assert.equal(M.getRangeById(r.id).in, 15);

  // 入点不能越过出点（保留 0.05s 最小宽度）
  M.setRangeBoundary(r.id, 'in', 30);
  assert.ok(M.getRangeById(r.id).in <= 20 - 0.05 + 1e-9);

  // 出点不能越过入点，也不能超过时长
  M.setRangeBoundary(r.id, 'out', 5);
  assert.ok(M.getRangeById(r.id).out >= M.getRangeById(r.id).in + 0.05 - 1e-9);
  M.setRangeBoundary(r.id, 'out', 200);
  assert.equal(M.getRangeById(r.id).out, 100);

  // 拖动是连续操作：手动压撤销点后，一次 undo 回到拖动前
  M.beginEdit();
  M.setRangeBoundary(r.id, 'in', 12);
  assert.equal(M.undo(), true);
  assert.ok(Math.abs(M.getRangeById(r.id).in - 19.95) < 1e-6);
});

test('区间：相邻标记配对支持任意类型（C/D 也能用）', async () => {
  const { ctx, setSidecar } = makeMarkersContext();
  setSidecar({
    version: 1,
    markers: [
      { id: 'm1', label: 'A1', time: 1, kind: 'A' },
      { id: 'm2', label: 'B1', time: 3, kind: 'B' },
      { id: 'm3', label: 'C1', time: 5, kind: 'C' },
      { id: 'm4', label: 'D1', time: 8, kind: 'D' },
    ],
  });
  const M = ctx.Markers;
  M.init({ timeProvider: () => 0 });
  await M.loadSidecar('C:\\v\\a.mp4');

  assert.equal(M.addRangesFromAdjacentMarkers(), 2);
  const ranges = M.getRanges();
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].in, 1);
  assert.equal(ranges[0].out, 3);
  assert.equal(ranges[1].in, 5);
  assert.equal(ranges[1].out, 8);

  // 再点一次：与已有区间完全重复，应该生成 0 个且不留下撤销点
  assert.equal(M.addRangesFromAdjacentMarkers(), 0);
  assert.equal(M.undo(), true);
  assert.equal(M.getRanges().length, 0);
});

test('sidecar：重复 id 的标记/区间只保留一份，并回写清理后的文件', async () => {
  const { ctx, setSidecar, writes } = makeMarkersContext();
  setSidecar({
    version: 2,
    markers: [
      { id: 'm1', label: 'A1', time: 1, kind: 'A' },
      { id: 'm1', label: 'A1', time: 1, kind: 'A' },
      { id: 'm2', label: 'B1', time: 2, kind: 'B' },
      { id: 'm2', label: 'B1', time: 2, kind: 'B' },
    ],
    ranges: [
      { id: 'r1', name: '段', in: 1, out: 2 },
      { id: 'r1', name: '段', in: 1, out: 2 },
    ],
  });
  const M = ctx.Markers;
  M.init({ timeProvider: () => 0 });
  await M.loadSidecar('C:\\v\\a.mp4');

  assert.equal(M.count(), 2);
  assert.equal(M.getRanges().length, 1);
  // 读到重复项后应自动写回一份干净的 sidecar
  assert.ok(writes.length >= 1);
  const cleaned = writes[writes.length - 1].payload;
  assert.equal(cleaned.markers.length, 2);
  assert.equal(cleaned.ranges.length, 1);
});

test('sidecar：并发加载同一文件只落一份（防止重复追加）', async () => {
  const { ctx, setSidecar } = makeMarkersContext();
  setSidecar({
    version: 2,
    markers: [
      { id: 'm1', label: 'A1', time: 1, kind: 'A' },
      { id: 'm2', label: 'B1', time: 2, kind: 'B' },
    ],
    ranges: [{ id: 'r1', name: '段', in: 1, out: 2 }],
  });
  const M = ctx.Markers;
  M.init({ timeProvider: () => 0 });

  // 同时发起两次加载，模拟"主进程事件 + IPC 返回"同时触发
  await Promise.all([
    M.loadSidecar('C:\\v\\a.mp4'),
    M.loadSidecar('C:\\v\\a.mp4'),
  ]);

  assert.equal(M.count(), 2);
  assert.equal(M.getRanges().length, 1);
});

test('区间：从 A/B 标记批量迁移', async () => {
  const { ctx, setSidecar } = makeMarkersContext();
  setSidecar({
    version: 1,
    markers: [
      { id: 'm1', label: 'A1', time: 1, kind: 'A' },
      { id: 'm2', label: 'B1', time: 3, kind: 'B' },
      { id: 'm3', label: 'A2', time: 5, kind: 'A' },
      { id: 'm4', label: 'B2', time: 8, kind: 'B' },
    ],
  });
  const M = ctx.Markers;
  M.init({ timeProvider: () => 0 });
  await M.loadSidecar('C:\\v\\a.mp4');

  assert.equal(M.addRangesFromMarkers(), 2);
  const ranges = M.getRanges();
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].in, 1);
  assert.equal(ranges[0].out, 3);
  assert.equal(ranges[1].in, 5);
  assert.equal(ranges[1].out, 8);

  // 撤销整批迁移
  M.undo();
  assert.equal(M.getRanges().length, 0);
});
