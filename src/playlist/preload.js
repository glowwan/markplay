'use strict';

/**
 * 文件列表窗口（播放列表）的 preload。
 *
 * 除了列表相关能力，还暴露 t / getLanguage / setLanguage 三个函数——
 * 因为 ../renderer/i18n-apply.js 依赖 window.markplay 上的这套接口。
 */
const { contextBridge, ipcRenderer } = require('electron');
const { createTranslator, normalize } = require('../i18n');
const dictZh = require('../locales/zh-CN');
const dictEn = require('../locales/en-US');

const DICTS = { 'zh-CN': dictZh, 'en-US': dictEn };

let currentLang = 'zh-CN';
try {
  currentLang = normalize(ipcRenderer.sendSync('get-language'));
} catch {
  currentLang = 'zh-CN';
}

let translator = createTranslator(currentLang, DICTS[currentLang], dictZh);

contextBridge.exposeInMainWorld('markplay', {
  /** i18n-apply.js 需要的三个接口 */
  t: (key, params) => translator(key, params),
  getLanguage: () => currentLang,
  setLanguage: (lang) => {
    const next = normalize(lang);
    if (next === currentLang) return;
    currentLang = next;
    translator = createTranslator(currentLang, DICTS[currentLang], dictZh);
  },

  /**
   * 订阅列表数据。回调收到 { items: [{path,name,dir}], index }。
   * @param {(data: object) => void} cb
   */
  onData: (cb) => {
    const handler = (event, data) => cb(data);
    ipcRenderer.on('playlist-data', handler);
    return () => ipcRenderer.removeListener('playlist-data', handler);
  },

  /**
   * 订阅语言变化。
   * @param {(lang: string) => void} cb
   */
  onLanguage: (cb) => {
    const handler = (event, lang) => cb(lang);
    ipcRenderer.on('playlist-language', handler);
    return () => ipcRenderer.removeListener('playlist-language', handler);
  },

  /**
   * 请求打开第 index 个文件。
   * @param {number} index
   */
  openItem: (index) => ipcRenderer.send('playlist-open', index),

  /** 关闭列表（用户点了 ✕） */
  close: () => ipcRenderer.send('playlist-close'),

  /** 退出视频全屏（全屏时才显示这个按钮） */
  exitFullscreen: () => ipcRenderer.send('playlist-exit-fullscreen'),

  /**
   * 把第 index 条从列表里移除（不删文件）。
   * @param {number} index
   */
  remove: (index) => ipcRenderer.send('playlist-remove', index),

  /**
   * 打开多选对话框，把选中的文件追加到列表（不自动播放）。
   * @returns {Promise<{ok: boolean, canceled?: boolean, added: number, total: number}>}
   */
  add: () => ipcRenderer.invoke('playlist-add'),

  /** 告诉主进程"我已经就绪，给我数据" */
  ready: () => ipcRenderer.send('playlist-ready'),
});
