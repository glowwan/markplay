'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CG = require('../src/click-gesture');

// ---------------------------------------------------------------- 基本行为

test('默认双击窗口 250ms', () => {
  assert.equal(CG.DEFAULT_DBL_MS, 250);
  assert.equal(CG.createState().dblMs, 250);
});

test('第一次单击：先挂起，不立刻动作', () => {
  const r = CG.resolve(CG.createState(), 1000);
  assert.equal(r.action, 'single');
  assert.equal(r.state.pendingAt, 1000);
  assert.equal(r.token, 1000);
});

test('窗口内第二下：判定为双击，并清掉挂起', () => {
  const s1 = CG.resolve(CG.createState(), 1000);
  const s2 = CG.resolve(s1.state, 1150);   // 间隔 150ms
  assert.equal(s2.action, 'double');
  assert.equal(s2.state.pendingAt, null, '双击后挂起要被清掉');
});

test('超过窗口的第二下：还是两次单击', () => {
  const s1 = CG.resolve(CG.createState(), 1000);
  const s2 = CG.resolve(s1.state, 1400);   // 间隔 400ms > 250ms
  assert.equal(s2.action, 'single');
  assert.equal(s2.state.pendingAt, 1400);
});

test('边界：正好 250ms 算双击', () => {
  const s1 = CG.resolve(CG.createState(), 1000);
  const s2 = CG.resolve(s1.state, 1250);
  assert.equal(s2.action, 'double');
});

test('边界：251ms 算单击', () => {
  const s1 = CG.resolve(CG.createState(), 1000);
  const s2 = CG.resolve(s1.state, 1251);
  assert.equal(s2.action, 'single');
});

test('双击之后再点一下：重新从单击开始（不会连着判成第二次双击）', () => {
  let s = CG.createState();
  let r = CG.resolve(s, 1000);
  s = r.state;
  r = CG.resolve(s, 1100);          // 双击
  assert.equal(r.action, 'double');
  s = r.state;
  r = CG.resolve(s, 1200);          // 紧接着又点一下
  assert.equal(r.action, 'single', '双击后必须重新计时，不能一次连击算两次双击');
  assert.equal(r.state.pendingAt, 1200);
});

// ---------------------------------------------------------------- 定时器回调校验

test('shouldFire：挂起没被改动时才执行单击', () => {
  const r = CG.resolve(CG.createState(), 1000);
  assert.equal(CG.shouldFire(r.state, r.token), true);
});

test('shouldFire：期间来了第二下（双击）就不该再执行那次单击', () => {
  const s1 = CG.resolve(CG.createState(), 1000);
  const s2 = CG.resolve(s1.state, 1100);   // 双击，挂起被清
  assert.equal(CG.shouldFire(s2.state, s1.token), false);
});

test('shouldFire：期间又来了一次单击（新的挂起）也不该执行旧的', () => {
  const s1 = CG.resolve(CG.createState(), 1000);
  const s2 = CG.resolve(s1.state, 1400);   // 超窗口，变成新的挂起
  assert.equal(CG.shouldFire(s2.state, s1.token), false);
});

// ---------------------------------------------------------------- 清理

test('consume：执行完单击后清空挂起', () => {
  const s = CG.consume({ dblMs: 250, pendingAt: 1234 });
  assert.equal(s.pendingAt, null);
  assert.equal(s.dblMs, 250);
});

test('consume：非法输入也给回一个可用状态', () => {
  assert.deepEqual(CG.consume(null), { dblMs: 250, pendingAt: null });
});

test('createState：自定义窗口生效，非法值回落默认', () => {
  assert.equal(CG.createState(400).dblMs, 400);
  assert.equal(CG.createState(0).dblMs, 250);
  assert.equal(CG.createState(-5).dblMs, 250);
  assert.equal(CG.createState('x').dblMs, 250);
});

// ---------------------------------------------------------------- 完整流程

test('完整流程：单击 -> 等窗口过去 -> 执行一次 2x；再双击 -> 执行一次暂停', () => {
  let s = CG.createState();
  const fired = [];

  // 单击
  let r = CG.resolve(s, 0);
  s = r.state;
  // 定时器到点
  if (CG.shouldFire(s, r.token)) { fired.push('single'); s = CG.consume(s); }

  // 双击
  r = CG.resolve(s, 5000);
  s = r.state;
  const firstToken = r.token;
  r = CG.resolve(s, 5100);
  s = r.state;
  if (r.action === 'double') fired.push('double');
  if (CG.shouldFire(s, firstToken)) fired.push('single-after-double');

  assert.deepEqual(fired, ['single', 'double'], '双击不能额外触发一次单击');
});

test('不修改入参', () => {
  const s = CG.createState();
  const snapshot = JSON.stringify(s);
  CG.resolve(s, 1000);
  assert.equal(JSON.stringify(s), snapshot);
});
