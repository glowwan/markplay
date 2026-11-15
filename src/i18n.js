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

module.exports = {
  SUPPORTED,
  createTranslator,
  interpolate,
  lookup,
  normalize,
};
