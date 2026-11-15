/* i18n-apply.js —— 把字典应用到 DOM，并支持运行时切换语言
 *
 * 工作方式：
 *  - HTML 里用 data-i18n / data-i18n-title / data-i18n-placeholder 标注要翻译的属性；
 *  - applyI18n() 遍历这些标注，用 window.markplay.t() 填入当前语言文案；
 *  - 切换语言时主进程发 language-changed，这里重新应用一遍并通知调用方重绘动态内容。
 *
 * 不重载页面：正在播的视频、已打的标记都不会丢。
 */

var I18n = (function () {
  'use strict';

  /** 语言变化时通知外部（renderer.js 注册） */
  var listeners = [];

  function t(key, params) {
    if (window.markplay && typeof window.markplay.t === 'function') {
      return window.markplay.t(key, params);
    }
    return key;
  }

  /**
   * 解析 data-i18n-params（JSON 字符串）。
   * @param {string} raw
   * @returns {object|undefined}
   */
  function parseParams(raw) {
    if (!raw) return undefined;
    try {
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /** 把字典里的文案写进 DOM */
  function applyI18n(root) {
    var scope = root || document;

    // 文本内容
    var nodes = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-i18n');
      if (!key) continue;
      var params = parseParams(el.getAttribute('data-i18n-params'));
      el.textContent = t(key, params);
    }

    // title 属性
    var titled = scope.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titled.length; j++) {
      var k2 = titled[j].getAttribute('data-i18n-title');
      if (k2) titled[j].title = t(k2);
    }

    // placeholder 属性
    var phs = scope.querySelectorAll('[data-i18n-placeholder]');
    for (var k = 0; k < phs.length; k++) {
      var k3 = phs[k].getAttribute('data-i18n-placeholder');
      if (k3) phs[k].placeholder = t(k3);
    }

    // <html lang> 也跟着变，影响系统字体回退与无障碍朗读
    document.documentElement.lang = currentLanguage();
  }

  /** 当前语言 */
  function currentLanguage() {
    if (window.markplay && typeof window.markplay.getLanguage === 'function') {
      return window.markplay.getLanguage();
    }
    return 'zh-CN';
  }

  /**
   * 切换语言。主进程已经把 preload 里的翻译函数换掉了，这里只需重刷 DOM。
   * @param {'zh-CN'|'en-US'} lang
   */
  function setLanguage(lang) {
    if (window.markplay && typeof window.markplay.setLanguage === 'function') {
      window.markplay.setLanguage(lang);
    }
    applyI18n();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](currentLanguage()); } catch (e) { /* 单个监听器失败不影响其它 */ }
    }
  }

  /**
   * 注册"语言已切换"回调，用于重绘 JS 动态生成的文案。
   * @param {(lang: string) => void} fn
   */
  function onLanguageChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  return {
    applyI18n: applyI18n,
    currentLanguage: currentLanguage,
    onLanguageChange: onLanguageChange,
    setLanguage: setLanguage,
    t: t,
  };
})();