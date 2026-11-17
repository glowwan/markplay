'use strict';

/**
 * 源码契约测试：文件列表的全屏悬停检测（playlist watch）。
 *
 * 这段逻辑依赖 Electron 的窗口状态，没法用 node:vm 单测。
 * v1.11.1 曾经在这里加了一个"真·全屏"校验（表面是防御，实际是回归）：
 * 项目全屏有降级路径（setFullScreen 失败后 setBounds 铺满屏幕），
 * 这种模式下 isFullScreen() 返回 false，校验直接把轮询表停掉，
 * 全屏下的右侧悬停弹出彻底失效。
 *
 * 所以这里用几条源码断言把"不许再这么写"箍住。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

/** 取某个函数体（从 function 名开始到下一个顶层 function 之前） */
function bodyOf(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js 里找不到 ${name}`);
  // 用大括号配平截取
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

test('进入全屏时启动悬停检测、退出时停止', () => {
  const enter = bodyOf('toggleFullscreen');
  assert.ok(enter.includes('startPlaylistWatch()'), 'toggleFullscreen 里应调用 startPlaylistWatch()');

  const exit = bodyOf('exitFullscreen');
  assert.ok(exit.includes('stopPlaylistWatch()'), 'exitFullscreen 里应调用 stopPlaylistWatch()');
});

test('悬停检测体内不允许改写 isSurfaceFullscreen（回归防护）', () => {
  const watch = bodyOf('startPlaylistWatch');
  assert.ok(
    !/isSurfaceFullscreen\s*=/.test(watch),
    'watch 里不得给 isSurfaceFullscreen 赋值：全屏状态由 toggleFullscreen/exitFullscreen 维护，' +
    '在这里改写会让后续的 F11/ESC 判定错乱'
  );
});

test('悬停检测不得依据 isFullScreen() 停表（回归防护）', () => {
  const watch = bodyOf('startPlaylistWatch');
  // 允许调用 isFullScreen() 仅用于诊断日志；不允许据此 stopPlaylistWatch()
  if (watch.includes('isFullScreen()')) {
    assert.ok(
      /logWarn\([^)]*isFullScreen|isFullScreen[\s\S]{0,400}?logWarn/.test(watch),
      'isFullScreen() 只能用于记日志：它在"铺满式全屏"降级路径下返回 false，据此停表会误伤正常全屏'
    );
    assert.ok(
      !/if\s*\(\s*!?\s*reallyFullscreen/.test(watch),
      '不要再引入 reallyFullscreen 之类的变量来决定是否停表'
    );
  }
});

test('悬停检测只在"我们认为是全屏"时才工作', () => {
  const watch = bodyOf('startPlaylistWatch');
  assert.ok(watch.includes('if (!isSurfaceFullscreen)'), '第一层判断应是 isSurfaceFullscreen');
});

test('right-edge 弹窗与离开收起都用模型函数判定', () => {
  const watch = bodyOf('startPlaylistWatch');
  assert.ok(watch.includes('PlaylistModel.hitRightEdge'), '弹出判定应走 PlaylistModel.hitRightEdge');
  assert.ok(watch.includes('PlaylistModel.insideList'), '收起判定应走 PlaylistModel.insideList');
});

test('文件对话框期间暂停自动收起', () => {
  const watch = bodyOf('startPlaylistWatch');
  assert.ok(watch.includes('playlistDialogOpen'), 'watch 里应检查 playlistDialogOpen');
});

test('隐藏窗口必须带原因（便于排查）', () => {
  const hide = bodyOf('hidePlaylist');
  assert.ok(/function hidePlaylist\(reason\)/.test(MAIN), 'hidePlaylist 应接收 reason 参数');
  assert.ok(hide.includes('logInfo'), 'hidePlaylist 应记录原因');
});

test('推数据后会把列表窗口抬回顶层（防被视频窗口盖住）', () => {
  const emit = bodyOf('emitPlaylist');
  assert.ok(emit.includes('raisePlaylist()'), 'emitPlaylist 里应调用 raisePlaylist()');
  const raise = bodyOf('raisePlaylist');
  assert.ok(raise.includes('moveTop()'), 'raisePlaylist 应使用 moveTop()');
  assert.ok(!/setAlwaysOnTop\(true/.test(raise), '不应无脑 setAlwaysOnTop：那会让列表压住其它应用');
});
