'use strict';

/**
 * 视频渲染子窗口的 preload 脚本。
 *
 * 这个窗口只是一个原生"容器"（frameless + 透明），加载 about:blank。
 * mpv 的画面通过 --wid 嵌入到该窗口的 HWND 上。
 * 触摸板横滑手势的 wheel 事件发生在该窗口上，因此在这里监听并转发给主进程，
 * 主进程再转交给主窗口的渲染进程处理（scrub 逻辑）。
 */
const { ipcRenderer } = require('electron');

/**
 * 把 wheel 事件的核心字段发给主进程。
 * passive:true 保证滚动不阻塞浏览器合成线程。
 */
window.addEventListener(
  'wheel',
  (e) => {
    ipcRenderer.send('surface-wheel', {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
  },
  { passive: true }
);

/**
 * 鼠标点击转发（左/中/右键）：主进程据此切换 2x 播放 / 2x 倒放。
 * 与 mpv input.conf 的 script-message 形成双路径（mpv 原生窗口和页面谁先收到不确定），
 * 主进程对 300ms 内的重复点击做去重。
 */
window.addEventListener('mousedown', (e) => {
  ipcRenderer.send('surface-mousedown', { button: e.button });
});
window.addEventListener('contextmenu', (e) => { e.preventDefault(); });

/**
 * 文件拖放：把视频文件拖到视频画面上也能打开。
 * （控制条窗口的拖放由主窗口渲染进程处理。）
 */
var dragOverSent = false;
window.addEventListener('dragover', function (e) {
  e.preventDefault();
  // 悬停反馈（节流）：主进程转给控制条状态栏提示"松开以打开"
  if (!dragOverSent) {
    dragOverSent = true;
    ipcRenderer.send('surface-dragover');
    setTimeout(function () { dragOverSent = false; }, 1500);
  }
});
window.addEventListener('dragleave', function () { dragOverSent = false; });

/** 从 DataTransfer 里抠文件路径：优先 files[0].path，兜底 text/uri-list */
function extractDropPath(dt) {
  if (!dt) return null;
  if (dt.files && dt.files[0] && dt.files[0].path) return dt.files[0].path;
  try {
    var uri = dt.getData('text/uri-list') || '';
    var first = uri.split('\n').map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.charAt(0) !== '#'; })[0];
    if (first && first.indexOf('file://') === 0) {
      var p = decodeURIComponent(new URL(first).pathname);
      if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1); // /C:/… → C:/…
      return p;
    }
    return first || null;
  } catch (_) { return null; }
}

window.addEventListener('drop', function (e) {
  e.preventDefault();
  dragOverSent = false;
  var p = extractDropPath(e.dataTransfer);
  // 即使没抠到路径也上报（主进程记日志），方便排查"拖了没反应"
  ipcRenderer.send('surface-drop-file', p);
});
