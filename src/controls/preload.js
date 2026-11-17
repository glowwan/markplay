'use strict';

/**
 * 全屏播放状态栏窗口的 preload。
 *
 * 与列表窗口同样的做法：暴露 t / getLanguage / setLanguage 供 i18n-apply.js 使用，
 * 另外加"订阅状态 + 发命令"两个通道。
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
  t: (key, params) => translator(key, params),
  getLanguage: () => currentLang,
  setLanguage: (lang) => {
    const next = normalize(lang);
    if (next === currentLang) return;
    currentLang = next;
    translator = createTranslator(currentLang, DICTS[currentLang], dictZh);
  },

  /**
   * 订阅播放状态快照（由主窗口渲染进程推送，主进程转发）。
   * @param {(snapshot: object) => void} cb
   */
  onState: (cb) => {
    const handler = (event, data) => cb(data);
    ipcRenderer.on('controls-state', handler);
    return () => ipcRenderer.removeListener('controls-state', handler);
  },

  /**
   * 订阅语言变化。
   * @param {(lang: string) => void} cb
   */
  onLanguage: (cb) => {
    const handler = (event, lang) => cb(lang);
    ipcRenderer.on('controls-language', handler);
    return () => ipcRenderer.removeListener('controls-language', handler);
  },

  /**
   * 发一条控制命令，交给主窗口渲染进程执行（它才有完整状态）。
   * @param {'toggle-play'|'seek'|'volume'|'toggle-fullscreen'|'speed-fwd'|'speed-rev'|'toggle-loop'|'toggle-scenes'|'zoom-in'|'zoom-out'|'zoom-fit'|'open'|'playlist'} name
   * @param {any} [arg]
   */
  command: (name, arg) => ipcRenderer.send('controls-command', name, arg),

  /** 告诉主进程"我这边动画就绪了"（用于首帧淡入） */
  ready: () => ipcRenderer.send('controls-ready'),
});
