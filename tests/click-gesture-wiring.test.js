'use strict';

/**
 * 源码契约测试：左键双击播放/暂停。
 *
 * 手势判定本身在 src/click-gesture.js（tests/click-gesture.test.js 已覆盖），
 * 这里钉住接线：mpv 绑定、去重窗口、单击延迟、双击清理、退出清理。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

function bodyOf(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js 里找不到 ${name}`);
  const braceStart = MAIN.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++;
    else if (MAIN[i] === '}') {
      depth--;
      if (depth === 0) return MAIN.slice(braceStart, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没闭合`);
}

test('mpv 绑定：保留左键单击，不声明双击绑定', () => {
  assert.ok(MAIN.includes("'MBTN_LEFT script-message markplay-click left'"), '要有左键单击绑定');
  // 只看真正的绑定行（以引号开头的数组元素），别被解释性注释误伤
  const bindingLines = MAIN.split('\n').filter((l) => /^\s*'MBTN_/.test(l));
  assert.ok(
    !bindingLines.some((l) => l.includes('MBTN_LEFT_DBL')),
    '不要声明 MBTN_LEFT_DBL：双击判定由我们自己做（mpv 那套无法验证）'
  );
});

test('主进程引入手势模块并使用它', () => {
  assert.ok(MAIN.includes("require('./click-gesture')"), '要 require click-gesture');
  const h = bodyOf('handleSurfaceClick');
  assert.ok(h.includes('ClickGesture.resolve'), '要用 resolve 判定单击/双击');
  assert.ok(h.includes('ClickGesture.shouldFire'), '单击定时器回调要有守卫');
  assert.ok(h.includes('ClickGesture.consume'), '执行完单击要 consume');
});

test('单击动作被推迟到双击窗口之后', () => {
  const h = bodyOf('handleSurfaceClick');
  assert.ok(/setTimeout\(/.test(h), '单击必须用定时器推迟');
  assert.ok(h.includes('dblMs'), '推迟时长取手势状态的 dblMs');
  assert.ok(h.includes('onLeftSingleClick()'), '定时器里执行单击动作');
});

test('双击动作是播放/暂停，且先退出倒放模拟', () => {
  const dbl = bodyOf('onLeftDoubleClick');
  assert.ok(dbl.includes('stopReverseSilently'), '倒放会强制 pause，双击前要先退出它');
  assert.ok(dbl.includes('togglePause'), '双击应切换播放/暂停');
  const rev = bodyOf('stopReverseSilently');
  assert.ok(rev.includes('rev2x'), '只应处理 rev2x');
  assert.ok(rev.includes('stopRevTimer'), '要停掉倒放定时器');
});

test('togglePause 用 get/set pause 实现', () => {
  const f = bodyOf('togglePause');
  assert.ok(f.includes("'pause'"), '要操作 pause 属性');
  assert.ok(f.includes('set_property'), '要 set_property');
});

test('双击到来时取消挂起的单击定时器', () => {
  const h = bodyOf('handleSurfaceClick');
  const idx = h.indexOf('onLeftDoubleClick');
  const before = h.slice(0, idx);
  assert.ok(/clearTimeout\(clickTimer\)/.test(before), '双击分支要先 clearTimeout，否则单击还会补一次');
});

test('去重窗口必须很小，否则会把双击的第二下吃掉', () => {
  const h = bodyOf('handleSurfaceClick');
  const m = /now - lastSurfaceClickAt < (\d+)/.exec(h);
  assert.ok(m, '应保留双路径去重');
  assert.ok(Number(m[1]) <= 100, `去重窗口 ${m[1]}ms 太大，会吃掉双击的第二下`);
});

test('右键仍是 2x 倒放、中键仍是 2x 正放（没被改动）', () => {
  const h = bodyOf('handleSurfaceClick');
  assert.ok(/which === 'right'/.test(h), '右键分支要在');
  assert.ok(/which === 'mid'/.test(h), '中键分支要在');
  assert.ok(h.includes("'rev2x'"), '右键应走倒放');
});

test('退出前清掉挂起的单击定时器', () => {
  const quit = MAIN.slice(MAIN.indexOf("app.on('before-quit'"));
  assert.ok(quit.slice(0, 400).includes('clearTimeout(clickTimer)'), 'before-quit 要清掉 clickTimer');
});
