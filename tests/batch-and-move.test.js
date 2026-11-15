'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeMarkersContext } = require('./helpers');

async function setup(opts) {
  const { ctx, writes } = makeMarkersContext();
  const M = ctx.Markers;
  M.init({ timeProvider: (opts && opts.time) || (() => 0) });
  await M.loadSidecar('C:\\v\\a.mp4');
  M.setDuration((opts && opts.duration) != null ? opts.duration : 100);
  if (opts && opts.fps) M.setFpsProvider(() => opts.fps);
  return { ctx, M, writes };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---------- 整段平移 ----------

test('moveRangeTo：宽度保持不变，两端一起平移', async () => {
  const { M } = await setup();
  const r = M.addRange(10, 20, '段');
  M.moveRangeTo(r.id, 50);
  const g = M.getRangeById(r.id);
  assert.equal(g.in, 50);
  assert.equal(g.out, 60);
  assert.ok(near(g.out - g.in, 10), '宽度必须守恒');
});

test('moveRangeTo：往前拖到头时贴在 0，宽度仍不变', async () => {
  const { M } = await setup();
  const r = M.addRange(30, 40, '段');
  M.moveRangeTo(r.id, -100);
  const g = M.getRangeById(r.id);
  assert.equal(g.in, 0);
  assert.equal(g.out, 10);
});

test('moveRangeTo：往后拖到尾时出点贴住时长，宽度仍不变', async () => {
  const { M } = await setup({ duration: 100 });
  const r = M.addRange(10, 20, '段');
  M.moveRangeTo(r.id, 999);
  const g = M.getRangeById(r.id);
  assert.equal(g.out, 100);
  assert.equal(g.in, 90);
});

test('moveRangeTo：有帧率时入点吸附到帧', async () => {
  const { M } = await setup({ fps: 30 });
  const r = M.addRange(10, 20, '段');
  M.moveRangeTo(r.id, 12.017);
  const g = M.getRangeById(r.id);
  assert.ok(near(g.in, Math.round(12.017 * 30) / 30), '实际 ' + g.in);
  assert.ok(near(g.out - g.in, 10));
});

test('moveRangeTo：render=false 不抛错，数据仍然更新', async () => {
  const { M } = await setup();
  const r = M.addRange(10, 20, '段');
  assert.equal(M.moveRangeTo(r.id, 40, { render: false }), true);
  assert.equal(M.getRangeById(r.id).in, 40);
});

test('moveRangeTo：非法 id / 非法时间返回 false', async () => {
  const { M } = await setup();
  const r = M.addRange(10, 20, '段');
  assert.equal(M.moveRangeTo('nope', 30), false);
  assert.equal(M.moveRangeTo(r.id, NaN), false);
  assert.equal(M.moveRangeTo(r.id, 'abc'), false);
});

test('moveRangeTo：可撤销', async () => {
  const { M } = await setup();
  const r = M.addRange(10, 20, '段');
  M.beginEdit();          // 模拟拖拽开始时压的撤销点
  M.moveRangeTo(r.id, 50, { render: false });
  assert.equal(M.undo(), true);
  assert.equal(M.getRangeById(r.id).in, 10);
});

// ---------- 名称拼装 ----------

test('composeBatchLabel：只加前后缀', async () => {
  const { M } = await setup();
  assert.equal(
    M.composeBatchLabel('A1', 'A', 0, { prefix: '开场-', suffix: '-待定' }),
    '开场-A1-待定'
  );
});

test('composeBatchLabel：重新编号时用「类型 + 两位序号」', async () => {
  const { M } = await setup();
  assert.equal(M.composeBatchLabel('A7', 'A', 1, { renumber: true }), 'A1');
  assert.equal(M.composeBatchLabel('随便', 'B', 12, { renumber: true }), 'B12');
  // 序号非法时按 1 处理
  assert.equal(M.composeBatchLabel('x', 'C', 0, { renumber: true }), 'C1');
  assert.equal(M.composeBatchLabel('x', 'C', NaN, { renumber: true }), 'C1');
});

test('composeBatchLabel：前后缀与编号同时生效', async () => {
  const { M } = await setup();
  assert.equal(
    M.composeBatchLabel('old', 'A', 3, { prefix: 'P-', suffix: '-S', renumber: true }),
    'P-A3-S'
  );
});

test('composeBatchLabel：结果截断到 40 字符', async () => {
  const { M } = await setup();
  const long = M.composeBatchLabel('x', 'A', 1, { prefix: 'x'.repeat(50) });
  assert.equal(long.length, 40);
});

test('composeBatchLabel：空选项时原样返回原名', async () => {
  const { M } = await setup();
  assert.equal(M.composeBatchLabel('A1', 'A', 0, {}), 'A1');
  assert.equal(M.composeBatchLabel('A1', 'A', 0, null), 'A1');
});

// ---------- 批量重命名 ----------

test('batchRename：给所有标记加前缀', async () => {
  const { M } = await setup({ time: () => 5 });
  M.add('A');
  M.add('B');
  const n = M.batchRename({ prefix: 'v2-' });
  assert.equal(n, 2);
  assert.equal(JSON.stringify(M.getSorted().map((m) => m.label)), JSON.stringify(['v2-A1', 'v2-B1']));
});

test('batchRename：scope 只影响指定类型', async () => {
  const { M } = await setup({ time: () => 5 });
  M.add('A');
  M.add('B');
  const n = M.batchRename({ scope: 'A', prefix: 'onlyA-' });
  assert.equal(n, 1);
  const byKind = {};
  M.getAll().forEach((m) => { byKind[m.kind] = m.label; });
  assert.equal(byKind.A, 'onlyA-A1');
  assert.equal(byKind.B, 'B1', 'B 不应被改动');
});

test('batchRename：重新编号按类型内部的时间顺序，不混排', async () => {
  const { M } = await setup({ time: () => 1 });
  // 造乱序数据：B 时间最早，然后 A(2)、A(5)
  const a1 = M.add('A');
  const b1 = M.add('B');
  const a2 = M.add('A');
  M.setTime(a1.id, 5);
  M.setTime(b1.id, 1);
  M.setTime(a2.id, 2);

  const n = M.batchRename({ renumber: true });
  // A 的两条互换了序号（A1↔A2），B1 本来就在正确位置，所以只有 2 条真正变化
  assert.equal(n, 2);

  const labels = {};
  M.getAll().forEach((m) => { labels[m.id] = m.label; });
  assert.equal(labels[b1.id], 'B1', 'B 时间最早 → B1');
  assert.equal(labels[a2.id], 'A1', 'A 里时间早的先编号');
  assert.equal(labels[a1.id], 'A2');
});

test('batchRename：重编号后计数器推进，后续打点接着编', async () => {
  const { M } = await setup({ time: () => 50 });
  M.add('A');
  M.add('A');
  M.add('A');
  M.batchRename({ renumber: true });
  const next = M.add('A');
  assert.equal(next.label, 'A4', '实际 ' + next.label);
});

test('batchRename：什么都没填时不做任何事，也不留撤销点', async () => {
  const { M } = await setup({ time: () => 5 });
  M.add('A');
  const before = M.canUndo();
  assert.equal(M.batchRename({}), 0);
  assert.equal(M.batchRename({ prefix: '', suffix: '', renumber: false }), 0);
  assert.equal(M.canUndo(), before, '不应新增撤销点');
});

test('batchRename：名称本来就没变时返回 0 且不新增撤销点', async () => {
  const { M } = await setup({ time: () => 5 });
  M.add('A');
  M.batchRename({ prefix: 'x-' });
  const undoDepth = M.canUndo();
  // 再套一次同样的前缀，名称会再变（x-x-A1），所以改用空操作
  assert.equal(M.batchRename({ scope: 'G' }), 0, '范围内没有 G 标记');
  assert.equal(M.canUndo(), undoDepth);
});

test('batchRename：可撤销', async () => {
  const { M } = await setup({ time: () => 5 });
  M.add('A');
  const original = M.getSorted()[0].label;
  M.batchRename({ prefix: 'zz-' });
  assert.equal(M.getSorted()[0].label, 'zz-' + original);
  assert.equal(M.undo(), true);
  assert.equal(M.getSorted()[0].label, original);
});

test('batchRename：非法 scope 返回 0', async () => {
  const { M } = await setup({ time: () => 5 });
  M.add('A');
  assert.equal(M.batchRename({ scope: 'Z', prefix: 'x' }), 0);
});

test('batchRename：没有打开视频时返回 0', async () => {
  const { ctx } = makeMarkersContext();
  ctx.Markers.init({ timeProvider: () => 0 });
  assert.equal(ctx.Markers.batchRename({ prefix: 'x' }), 0);
});
