'use strict';

/**
 * 用 node:vm 在沙盒里加载渲染进程脚本。
 * 这些脚本是普通 <script>（不是 ESM），顶层 var 会挂到沙盒全局上，
 * 因此可以直接取到 Exporter / Markers，无需引入 jsdom。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

const MARKER_COLORS = {
  A: '#ff5252',
  B: '#69f0ae',
  C: '#40c4ff',
  D: '#ffd740',
  F: '#ea80fc',
  G: '#8c9eff',
};

function loadRendererScript(fileName, sandbox) {
  const code = fs.readFileSync(path.join(SRC, 'renderer', fileName), 'utf8');
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: fileName });
  return context;
}

/**
 * 构造 export.js 的运行环境。
 * @returns {{ctx: object, writes: Array, win: object, uiToasts: Array}}
 */
function makeExportContext() {
  const writes = [];
  const uiToasts = [];
  const win = {
    markplay: {
      config: { MARKER_COLORS },
      onEvent: () => () => {},
      saveDialog: async () => 'C:\\out\\markers.csv',
      writeTextFile: async (p, content) => { writes.push({ path: p, content }); },
      showItemInFolder: () => {},
      runClip: async () => ({ ok: true }),
      pickDirectory: async () => 'C:\\out',
    },
  };
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
 * @returns {{ctx: object, writes: Array, setSidecar: (v:any)=>void}}
 */
function makeMarkersContext() {
  const writes = [];
  let sidecar = null;
  const win = {
    markplay: {
      config: { MARKER_COLORS, HISTORY_LIMIT: 50 },
      writeJsonFile: async (p, obj) => { writes.push({ path: p, payload: obj }); },
      readJsonFile: async () => sidecar,
    },
  };
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

module.exports = { loadRendererScript, makeExportContext, makeMarkersContext, MARKER_COLORS };
