'use strict';

/**
 * 语言解析与取词（主进程与渲染进程共用）。
 *
 * 设计要点：
 *  - 不依赖 Electron，主进程和渲染进程都能 require / import；
 *  - 走纯数据字典，不引入 i18n 库（项目至今零运行时依赖）；
 *  - 取不到词条时回退到 zh-CN，再回退到 key 本身，绝不抛错——
 *    界面缺一句翻译不应该让播放器崩掉。
 */

const SUPPORTED = ['zh-CN', 'en-US'];

/** 点号路径取值：'menu.file.open' → dict.menu.file.open */
function lookup(dict, key) {
  if (!dict || typeof key !== 'string') return undefined;
  const parts = key.split('.');
  let cur = dict;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * 把系统语言归一到支持的语言。
 * @param {string} tag 形如 'zh-Hans-CN' / 'en-GB' / 'zh'
 * @returns {'zh-CN'|'en-US'}
 */
function normalize(tag) {
  const s = String(tag || '').toLowerCase();
  if (!s) return 'zh-CN';
  // 英文优先判断，避免 'zh' 误伤（zh 里不含 'en'）
  if (s.startsWith('en')) return 'en-US';
  if (s.startsWith('zh')) return 'zh-CN';
  return 'zh-CN';
}

/**
 * 参数插值：把 {name} 换成 params.name。
 * 缺参数时保留占位符原样，方便一眼看出漏传。
 */
function interpolate(text, params) {
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
  ));
}

/**
 * 创建一个翻译函数。
 *
 * @param {'zh-CN'|'en-US'} lang
 * @param {Record<string, any>} dict 当前语言字典
 * @param {Record<string, any>} [fallbackDict] 回退字典（默认中文）
 * @returns {(key: string, params?: object) => string}
 */
function createTranslator(lang, dict, fallbackDict) {
  return function t(key, params) {
    let v = lookup(dict, key);
    if (v === undefined && fallbackDict) v = lookup(fallbackDict, key);
    if (v === undefined) return key;
    if (typeof v !== 'string') return key;
    return interpolate(v, params);
  };
}

// ---------- 全局当前语言 ----------
// 供 mpv.js 这类低层模块使用：它们没有自己的语言状态，
// 但抛出的错误消息可能被直接显示给用户，所以需要共享一个"当前语言"。

/** @type {'zh-CN'|'en-US'} */
let activeLang = 'zh-CN';
/** @type {Record<string, any>|null} */
let activeDict = null;
/** @type {Record<string, any>|null} */
let fallbackDict = null;

/**
 * 设置全局语言（主进程切换语言时调用）。
 * @param {'zh-CN'|'en-US'} lang
 * @param {Record<string, any>} dict 该语言的字典
 * @param {Record<string, any>} [fallback] 回退字典
 */
function setActiveLanguage(lang, dict, fallback) {
  activeLang = normalize(lang);
  activeDict = dict || null;
  fallbackDict = fallback || null;
}

/** @returns {'zh-CN'|'en-US'} */
function getActiveLanguage() {
  return activeLang;
}

/**
 * 用全局语言取词。字典未初始化时直接返回 key，不抛错。
 * @param {string} key
 * @param {object} [params]
 * @returns {string}
 */
function t(key, params) {
  if (!activeDict) return key;
  return createTranslator(activeLang, activeDict, fallbackDict || activeDict)(key, params);
}

module.exports = {
  SUPPORTED,
  createTranslator,
  getActiveLanguage,
  interpolate,
  lookup,
  normalize,
  setActiveLanguage,
  t,
};
