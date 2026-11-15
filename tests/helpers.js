'use strict';

/**
 * 用 node:vm 在沙盒里加载渲染进程脚本。
 * 这些脚本是普通 <script>（不是 ESM），顶层 var 会挂到沙盒全局上，
 * 因此可以直接取到 Exporter / Markers，无需引入 jsdom。
 *
 * 渲染脚本现在会用 I18n.t() 取文案，所以沙盒里要先加载 i18n-apply.js，
 * 并注入一个与运行时一致的 window.markplay.t（走真实的中文字典）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

const dictZh = require(path.join(SRC, 'locales', 'zh-CN.js'));
const dictEn = require(path.join(SRC, 'locales', 'en-US.js'));
const { createTranslator, normalize } = require(path.join(SRC, 'i18n.js'));

const DICTS = { 'zh-CN': dictZh, 'en-US': dictEn };

/** 按语言造一个与 preload 相同的翻译函数 */
function makeTranslator(lang) {
  const code = normalize(lang);
  return createTranslator(code, DICTS[code], dictZh);
}

const MARKER_COLORS = {
  A: '#ff5252',
  B: '#69f0ae',
  C: '#40c4ff',
  D: '#ffd740',
  F: '#ea80fc',
  G: '#8c9eff',
};

/** 在同一个 context 里依次执行多个渲染脚本（模拟 index.html 的加载顺序） */
function loadRendererScripts(fileNames, sandbox) {
  const context = vm.createContext(sandbox);
  for (const fileName of fileNames) {
    const code = fs.readFileSync(path.join(SRC, 'renderer', fileName), 'utf8');
    vm.runInContext(code, context, { filename: fileName });
  }
  return context;
}

/** 兼容旧用法：只加载一个脚本（仍会先加载 i18n-apply.js） */
function loadRendererScript(fileName, sandbox) {
  return loadRendererScripts(['i18n-apply.js', fileName], sandbox);
}

/**
 * 给沙盒补上 I18n 依赖的 window.markplay.t / getLanguage / setLanguage。
 * @param {object} win
 * @param {'zh-CN'|'en-US'} [lang]
 */
function attachI18n(win, lang) {
  let current = normalize(lang || 'zh-CN');
  let translator = makeTranslator(current);
  win.markplay = win.markplay || {};
  win.markplay.t = (key, params) => translator(key, params);
  win.markplay.getLanguage = () => current;
  win.markplay.setLanguage = (next) => {
    current = normalize(next);
    translator = makeTranslator(current);
  };
  return win;
}

/**
 * 构造 export.js 的运行环境。
 * @param {'zh-CN'|'en-US'} [lang]
 * @returns {{ctx: object, writes: Array, win: object, uiToasts: Array}}
 */
function makeExportContext(lang) {
  const writes = [];
  const uiToasts = [];
  const win = attachI18n({
    markplay: {
      config: { MARKER_COLORS },
      onEvent: () => () => {},
      saveDialog: async () => 'C:\\out\\markers.csv',
      writeTextFile: async (p, content) => { writes.push({ path: p, content }); },
      showItemInFolder: () => {},
      runClip: async () => ({ ok: true }),
      pickDirectory: async () => 'C:\\out',
    },
  }, lang);
  const sandbox = {
    window: win,
    document: { getElementById: () => null },
    console,
    UI: { toast: (msg, opts) => uiToasts.push({ msg, opts }) },
  };
  const ctx = loadRendererScript('export.js', sandbox);
  return { ctx, writes, win, uiToasts };
}

/**
 * 构造 markers.js 的运行环境。
 * @param {'zh-CN'|'en-US'} [lang]
 * @returns {{ctx: object, writes: Array, setSidecar: (v:any)=>void}}
 */
function makeMarkersContext(lang) {
  const writes = [];
  let sidecar = null;
  const win = attachI18n({
    markplay: {
      config: { MARKER_COLORS, HISTORY_LIMIT: 50 },
      writeJsonFile: async (p, obj) => { writes.push({ path: p, payload: obj }); },
      readJsonFile: async () => sidecar,
    },
  }, lang);
  const sandbox = {
    window: win,
    document: { getElementById: () => null },
    console,
  };
  const ctx = loadRendererScript('markers.js', sandbox);
  return {
    ctx,
    writes,
    setSidecar: (value) => { sidecar = value; },
  };
}

module.exports = {
  loadRendererScript,
  loadRendererScripts,
  makeExportContext,
  makeMarkersContext,
  makeTranslator,
  attachI18n,
  MARKER_COLORS,
};
