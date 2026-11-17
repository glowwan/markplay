'use strict';

/**
 * 源码契约测试：全屏播放状态栏。
 *
 * 这段同样依赖 Electron 窗口状态，没法用 node:vm 单测
 * （页面本身已经用一个最小 Electron 复现验证过渲染与命令，见 REVIEW）。
 * 这里把"必须怎么接"钉住，防止后续改动悄悄破坏：
 *  - 下边缘热区必须走 PlaylistModel.hitBottomEdge（和右侧热区同一套判定）；
 *  - 状态栏只在全屏出现，退出全屏必须收起；
 *  - 窗口创建必须在 registerIpc 之后（preload 用同步 IPC 取语言）；
 *  - 推快照后要抬高窗口（透明窗口会被视频原生子窗口盖住，踩过一次）；
 *  - 生命周期里要销毁，别留悬挂窗口。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
const CTL_JS = fs.readFileSync(path.join(ROOT, 'src', 'controls', 'controls.js'), 'utf8');
const CTL_HTML = fs.readFileSync(path.join(ROOT, 'src', 'controls', 'index.html'), 'utf8');

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

test('状态栏文件齐全', () => {
  for (const f of ['index.html', 'controls.css', 'controls.js', 'preload.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'controls', f)), `缺少 src/controls/${f}`);
  }
});

test('下边缘热区用模型函数判定', () => {
  const watch = bodyOf('startPlaylistWatch');
  assert.ok(
    watch.includes('PlaylistModel.hitBottomEdge'),
    '下边缘判定应走 PlaylistModel.hitBottomEdge（与右侧热区同一套，且已被单测覆盖）'
  );
  assert.ok(watch.includes('CONTROLS_EDGE_PX'), '应使用 CONTROLS_EDGE_PX 常量');
});

test('状态栏只在全屏出现', () => {
  const show = bodyOf('showControls');
  assert.ok(show.includes('if (!isSurfaceFullscreen) return;'), 'showControls 必须先判断全屏');
  const bounds = bodyOf('controlsBounds');
  assert.ok(bounds.includes('isSurfaceFullscreen'), 'controlsBounds 只在全屏时返回矩形');
});

test('退出全屏必须收起状态栏', () => {
  const exit = bodyOf('exitFullscreen');
  assert.ok(exit.includes('hideControls('), 'exitFullscreen 里要 hideControls');
});

test('进入全屏时摆好位置（但不显示）', () => {
  const enter = bodyOf('toggleFullscreen');
  assert.ok(enter.includes('layoutControls()'), '进入全屏应 layoutControls()');
});

test('推快照后抬高窗口（防被视频原生子窗口盖住）', () => {
  const emit = bodyOf('emitControlsState');
  assert.ok(emit.includes('moveTop()'), 'emitControlsState 应 moveTop()');
});

test('窗口创建在 registerIpc 之后', () => {
  const readyIdx = MAIN.indexOf('createControlsWindow();');
  const ipcIdx = MAIN.indexOf('registerIpc();');
  assert.ok(readyIdx > 0 && ipcIdx > 0, '找不到创建/注册调用');
  assert.ok(readyIdx > ipcIdx, '两个覆盖窗口都要在 registerIpc 之后创建（preload 用同步 IPC 取语言）');
});

test('生命周期里销毁状态栏窗口', () => {
  const quit = MAIN.slice(MAIN.indexOf("app.on('before-quit'"));
  assert.ok(quit.includes('controlsWindow.destroy()'), 'before-quit 要销毁状态栏窗口');
  const closed = MAIN.slice(MAIN.indexOf("mainWindow.on('closed'"));
  assert.ok(
    closed.slice(0, closed.indexOf('});')).includes('controlsWindow')
      || closed.slice(0, 400).includes('controlsWindow'),
    'mainWindow.closed 也要清理'
  );
});

test('状态栏 preload 与主进程通道对齐', () => {
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'controls', 'preload.js'), 'utf8');
  const sent = new Set([...pre.matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)].map((m) => m[1]));
  const registered = new Set([...MAIN.matchAll(/ipcMain\.(?:on|handle)\('([^']+)'/g)].map((m) => m[1]));
  for (const c of sent) {
    assert.ok(registered.has(c), `preload 用了 ${c}，但主进程没注册`);
  }
  for (const c of ['controls-ready', 'controls-state', 'controls-command']) {
    assert.ok(registered.has(c), `主进程应注册 ${c}`);
  }
});

test('渲染进程会按显示状态起停快照推送', () => {
  assert.ok(RENDERER.includes("case 'controls-shown':"), '要处理 controls-shown 事件');
  assert.ok(RENDERER.includes('setControlsPushing'), '要有起停函数');
  assert.ok(RENDERER.includes('setInterval(pushControlsSnapshot'), '显示期间要周期推送');
  assert.ok(RENDERER.includes('clearInterval(controlsTimer)'), '隐藏后要停止推送');
});

test('快照包含状态栏需要的全部字段', () => {
  for (const k of ['markers', 'ranges', 'scenes', 'view', 'duration', 'currentTime', 'paused', 'volume', 'speedMode', 'looping', 'showScenes', 'status']) {
    assert.ok(
      new RegExp(`\\b${k}\\s*:`).test(RENDERER.slice(RENDERER.indexOf('function pushControlsSnapshot'))),
      `快照应包含 ${k}`
    );
  }
});

test('时间轴点击先 seek 再抓指针（抓指针失败不能吞掉跳转）', () => {
  const idx = CTL_JS.indexOf("addEventListener('pointerdown'");
  assert.ok(idx > 0, '找不到 pointerdown 处理');
  // 去掉行注释再判断，否则注释里提到的 setPointerCapture 会干扰顺序比较
  const block = CTL_JS.slice(idx, idx + 500).replace(/\/\/[^\n]*/g, '');
  const seekPos = block.indexOf('seekFromEvent(e)');
  const capturePos = block.indexOf('setPointerCapture');
  assert.ok(seekPos > 0, 'pointerdown 里要调用 seekFromEvent');
  assert.ok(capturePos < 0 || capturePos > seekPos, 'seekFromEvent 要在 setPointerCapture 之前（后者会抛）');
  assert.ok(/try\s*{/.test(block), 'setPointerCapture 要包在 try 里');
});

test('样式复用主窗口的 styles.css（保证与非全屏底部模块一致）', () => {
  assert.ok(CTL_HTML.includes('../renderer/styles.css'), '状态栏页面应引用主窗口样式');
});

test('状态栏内容与非全屏底部模块对应', () => {
  for (const id of ['btn-play', 'btn-fullscreen', 'btn-speed-fwd', 'btn-speed-rev', 'btn-loop', 'btn-scenes', 'timeline', 'time-current', 'time-total', 'volume', 'status', 'marker-ticks', 'range-bars', 'scene-bubbles', 'timeline-playhead']) {
    assert.ok(CTL_HTML.includes(`id="${id}"`), `状态栏应包含 #${id}`);
  }
});
