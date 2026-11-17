'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/playlist-model');

// ---------------------------------------------------------------- 列表数据

test('dedupePaths：去重、保序、忽略空值', () => {
  assert.deepEqual(
    M.dedupePaths(['a.mp4', 'b.mp4', 'a.mp4', '', null, 'c.mp4']),
    ['a.mp4', 'b.mp4', 'c.mp4']
  );
  assert.deepEqual(M.dedupePaths([]), []);
  assert.deepEqual(M.dedupePaths(null), []);
});

test('dedupePaths：Windows 路径大小写不敏感', () => {
  assert.deepEqual(
    M.dedupePaths(['C:\\V\\A.mp4', 'c:\\v\\a.mp4']),
    ['C:\\V\\A.mp4']
  );
});

test('buildItems：拆出文件名与所在目录', () => {
  const items = M.buildItems(['C:\\Videos\\trip.mp4']);
  assert.equal(items.length, 1);
  assert.equal(items[0].path, 'C:\\Videos\\trip.mp4');
  assert.equal(items[0].name, 'trip.mp4');
  assert.equal(items[0].dir, 'C:\\Videos');
});

test('indexOfPath：找得到、大小写不敏感、找不到返回 -1', () => {
  const items = M.buildItems(['C:\\A\\1.mp4', 'C:\\A\\2.mp4']);
  assert.equal(M.indexOfPath(items, 'C:\\A\\2.mp4'), 1);
  assert.equal(M.indexOfPath(items, 'c:\\a\\2.MP4'), 1);
  assert.equal(M.indexOfPath(items, 'C:\\A\\9.mp4'), -1);
  assert.equal(M.indexOfPath(items, ''), -1);
  assert.equal(M.indexOfPath(null, 'x'), -1);
});

test('noteCurrent：已在列表里只移动高亮，不重复添加', () => {
  const items = M.buildItems(['C:\\A\\1.mp4', 'C:\\A\\2.mp4']);
  const r = M.noteCurrent(items, 'C:\\A\\2.mp4');
  assert.equal(r.items.length, 2);
  assert.equal(r.index, 1);
});

test('noteCurrent：不在列表里就追加到末尾', () => {
  const items = M.buildItems(['C:\\A\\1.mp4']);
  const r = M.noteCurrent(items, 'C:\\A\\9.mp4');
  assert.equal(r.items.length, 2);
  assert.equal(r.index, 1);
  assert.equal(r.items[1].name, '9.mp4');
});

test('noteCurrent：空列表 + 空路径时下标为 -1', () => {
  assert.deepEqual(M.noteCurrent([], ''), { items: [], index: -1 });
});

test('noteCurrent：不修改传入数组（便于撤销/测试）', () => {
  const items = M.buildItems(['C:\\A\\1.mp4']);
  M.noteCurrent(items, 'C:\\A\\2.mp4');
  assert.equal(items.length, 1);
});

// ---------------------------------------------------------------- 全屏悬浮判定

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };

test('hitRightEdge：光标在右缘热区内算命中', () => {
  assert.equal(M.hitRightEdge({ x: 1919, y: 500 }, DISPLAY, 26), true);
  assert.equal(M.hitRightEdge({ x: 1900, y: 500 }, DISPLAY, 26), true); // 1900 >= 1894
  assert.equal(M.hitRightEdge({ x: 1894, y: 500 }, DISPLAY, 26), true); // 边界含
});

test('hitRightEdge：离开热区就不命中', () => {
  assert.equal(M.hitRightEdge({ x: 1893, y: 500 }, DISPLAY, 26), false);
  assert.equal(M.hitRightEdge({ x: 960, y: 500 }, DISPLAY, 26), false);
  assert.equal(M.hitRightEdge({ x: 0, y: 0 }, DISPLAY, 26), false);
});

test('hitRightEdge：多显示器时按各自显示器坐标算', () => {
  const second = { x: 1920, y: 0, width: 1920, height: 1080 };
  // 第二块屏的右缘在 3840
  assert.equal(M.hitRightEdge({ x: 3835, y: 300 }, second, 26), true);
  // 这里在第一块屏的右缘，属于第二块屏的左边界，不该命中第二块屏的右缘热区
  assert.equal(M.hitRightEdge({ x: 1919, y: 300 }, second, 26), false);
});

test('hitRightEdge：非法输入安全返回 false', () => {
  assert.equal(M.hitRightEdge(null, DISPLAY, 26), false);
  assert.equal(M.hitRightEdge({ x: 1, y: 1 }, null, 26), false);
});

test('hitRightEdge：热区宽度至少 1 像素（避免除零导致永远 false）', () => {
  assert.equal(M.hitRightEdge({ x: 1919, y: 10 }, DISPLAY, 0), true);
});

// ---------------------------------------------------------------- 停留判定

const LIST = { x: 1598, y: 0, width: 322, height: 1080 };

test('insideList：在列表内命中', () => {
  assert.equal(M.insideList({ x: 1700, y: 500 }, LIST, 16), true);
  assert.equal(M.insideList({ x: 1598, y: 0 }, LIST, 16), true);
});

test('insideList：外扩容差内仍算命中（避免手抖一下就消失）', () => {
  assert.equal(M.insideList({ x: 1598 - 10, y: 500 }, LIST, 16), true);
  assert.equal(M.insideList({ x: 1598 - 17, y: 500 }, LIST, 16), false);
});

test('insideList：向左移出列表就离开', () => {
  assert.equal(M.insideList({ x: 1000, y: 500 }, LIST, 16), false);
});

test('insideList：上下移出也离开', () => {
  assert.equal(M.insideList({ x: 1700, y: -30 }, LIST, 16), false);
  assert.equal(M.insideList({ x: 1700, y: 1200 }, LIST, 16), false);
});

test('insideList：margin 为 0 / 负数都不崩', () => {
  assert.equal(M.insideList({ x: 1700, y: 500 }, LIST, 0), true);
  assert.equal(M.insideList({ x: 1700, y: 500 }, LIST, -50), true);
});

// ---------------------------------------------------------------- 窗口定位

test('computeBounds：全屏时贴屏幕右缘、整屏高', () => {
  const b = M.computeBounds({ width: 322, fullscreen: true, display: DISPLAY });
  assert.deepEqual(b, { x: 1920 - 322, y: 0, width: 322, height: 1080 });
});

test('computeBounds：多显示器全屏时用那块屏的坐标', () => {
  const second = { x: 1920, y: -200, width: 1600, height: 900 };
  const b = M.computeBounds({ width: 300, fullscreen: true, display: second });
  assert.deepEqual(b, { x: 1920 + 1600 - 300, y: -200, width: 300, height: 900 });
});

test('computeBounds：窗口模式贴视频区右缘（不遮侧栏）', () => {
  const b = M.computeBounds({
    width: 322,
    fullscreen: false,
    content: { x: 100, y: 100, width: 1280, height: 800 },
    videoRect: { x: 0, y: 0, w: 980, h: 676 },
  });
  // 客户区 x=100 起，视频区右缘在 100+980
  assert.deepEqual(b, { x: 100 + 980 - 322, y: 100, width: 322, height: 676 });
});

test('computeBounds：视频区比列表还窄时退回整窗右缘', () => {
  const b = M.computeBounds({
    width: 322,
    fullscreen: false,
    content: { x: 0, y: 0, width: 800, height: 600 },
    videoRect: { x: 0, y: 0, w: 200, h: 300 },
  });
  assert.deepEqual(b, { x: 800 - 322, y: 0, width: 322, height: 600 });
});

test('computeBounds：没有视频时贴客户区右缘', () => {
  const b = M.computeBounds({
    width: 320,
    fullscreen: false,
    content: { x: 50, y: 60, width: 1000, height: 700 },
  });
  assert.deepEqual(b, { x: 50 + 1000 - 320, y: 60, width: 320, height: 700 });
});

test('computeBounds：完全没信息时返回 null', () => {
  assert.equal(M.computeBounds({ width: 300 }), null);
  assert.equal(M.computeBounds({}), null);
});

test('computeBounds：高度不会小于 120（防止窗口被压成一条线）', () => {
  const b = M.computeBounds({
    width: 300,
    fullscreen: false,
    content: { x: 0, y: 0, width: 1000, height: 20 },
  });
  assert.equal(b.height, 120);
});
