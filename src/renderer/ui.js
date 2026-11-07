/* ui.js —— 通用界面反馈：右下角 toast（可带"在文件夹中显示"这类操作按钮）
 *
 * 独立成模块，避免 renderer.js / export.js 互相依赖。
 */

var UI = (function () {
  'use strict';

  var DEFAULT_DURATION = 4200;

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /**
   * 弹出一条 toast。
   * @param {string} message
   * @param {{kind?: 'info'|'error'|'success', actionLabel?: string, onAction?: Function, duration?: number}} [opts]
   */
  function toast(message, opts) {
    opts = opts || {};
    var stack = document.getElementById('toast-stack');
    if (!stack) return;

    var el = document.createElement('div');
    el.className = 'toast' + (opts.kind ? ' toast-' + opts.kind : '');

    var text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = String(message);
    el.appendChild(text);

    if (opts.actionLabel && typeof opts.onAction === 'function') {
      var action = document.createElement('button');
      action.className = 'toast-action';
      action.type = 'button';
      action.textContent = opts.actionLabel;
      action.addEventListener('click', function () {
        try {
          opts.onAction();
        } finally {
          removeEl(el);
        }
      });
      el.appendChild(action);
    }

    var close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.textContent = '✕';
    close.title = '关闭';
    close.addEventListener('click', function () { removeEl(el); });
    el.appendChild(close);

    stack.appendChild(el);
    // 最多同时保留 4 条，超出的从最旧的开始移除
    while (stack.children.length > 4) {
      removeEl(stack.firstElementChild);
    }

    var timer = setTimeout(function () { removeEl(el); }, opts.duration || DEFAULT_DURATION);
    el.addEventListener('mouseenter', function () { clearTimeout(timer); });
    el.addEventListener('mouseleave', function () {
      timer = setTimeout(function () { removeEl(el); }, 1200);
    });
  }

  return { toast: toast };
})();
