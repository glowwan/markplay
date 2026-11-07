'use strict';

/**
 * 主窗口的 preload 脚本。
 * 通过 contextBridge 向渲染进程暴露一个最小化、类型安全的 API：window.markplay。
 */
const { contextBridge, ipcRenderer } = require('electron');
const config = require('./config');

contextBridge.exposeInMainWorld('markplay', {
  /**
   * 共享配置（只读快照）：SCRUB_SENSITIVITY、MARKER_COLORS 等。
   * 注意：config.js 是纯数据模块，直接暴露整个对象是安全的。
   */
  config,

  /**
   * 发送一条原始 mpv 命令数组，如 ['seek', 5, 'relative']。
   * @param {any[]} cmdArray
   * @returns {Promise<{error: string, data: any}>}
   */
  mpvCommand: (cmdArray) => ipcRenderer.invoke('mpv-command', cmdArray),

  /**
   * 读取一个 mpv 属性，如 'time-pos'。
   * @param {string} prop
   * @returns {Promise<any>}
   */
  mpvGet: (prop) => ipcRenderer.invoke('mpv-get', prop),

  /**
   * 弹出"打开视频文件"对话框。
   * @returns {Promise<string|null>} 选中的文件路径；取消则返回 null
   */
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

  /**
   * 加载视频：会懒启动 mpv 并通过 IPC 发送 loadfile。
   * @param {string} path - 视频文件完整路径
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  loadVideo: (path) => ipcRenderer.invoke('load-video', path),

  /**
   * 弹出"另存为"对话框。
   * @param {string} defaultName - 默认文件名
   * @returns {Promise<string|null>} 目标路径；取消则返回 null
   */
  saveDialog: (defaultName) => ipcRenderer.invoke('save-dialog', defaultName),

  /**
   * 写文本文件（标记导出用）。
   * @param {string} path
   * @param {string} content
   * @returns {Promise<void>}
   */
  writeTextFile: (path, content) => ipcRenderer.invoke('write-text-file', path, content),

  /**
   * 读取 JSON 文件；文件不存在返回 null（不是抛错）。
   * @param {string} path
   * @returns {Promise<any|null>}
   */
  readJsonFile: (path) => ipcRenderer.invoke('read-json-file', path),

  /**
   * 写 JSON 文件（会话/项目持久化用），2 空格缩进。
   * @param {string} path
   * @param {any} obj
   * @returns {Promise<void>}
   */
  writeJsonFile: (path, obj) => ipcRenderer.invoke('write-json-file', path, obj),

  /**
   * 用 ffmpeg 做片段剪辑。进度通过 player-event 的 {type:'clip-progress',percent} 上报。
   * @param {{input: string, ss: number, to: number, output: string, reencode: boolean}} opts
   * @returns {Promise<void>} 只代表任务已开始，实际结果走 player-event
   */
  runClip: (opts) => ipcRenderer.invoke('run-clip', opts),

  /**
   * 批量剪辑并合并成一个文件：主进程逐段裁剪后用 concat 拼接。
   * @param {{input: string, ranges: Array<{ss:number,to:number}>, output: string, reencode: boolean}} opts
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  runMergeClip: (opts) => ipcRenderer.invoke('run-merge-clip', opts),

  /**
   * 通知主进程：视频画面在主窗口内的 CSS 像素矩形（供 frameless 子窗口跟随定位）。
   * @param {{x: number, y: number, w: number, h: number}} rect
   */
  setVideoRect: (rect) => ipcRenderer.send('set-video-rect', rect),

  /**
   * 订阅播放器事件（mpv-time、mpv-paused、clip-progress、wheel 等）。
   * @param {(payload: any) => void} cb
   * @returns {() => void} 取消订阅函数
   */
  onEvent: (cb) => {
    const handler = (event, payload) => cb(payload);
    ipcRenderer.on('player-event', handler);
    return () => ipcRenderer.removeListener('player-event', handler);
  },

  /**
   * 切换视频子窗口全屏。
   * @returns {Promise<{ok: boolean, fullscreen: boolean}>}
   */
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),

  /**
   * 设置 2x 速度模式：'normal' | 'fwd2x'（2x 正放） | 'rev2x'（2x 倒放）。
   * @param {string} mode
   * @returns {Promise<{ok: boolean, mode: string}>}
   */
  setSpeedMode: (mode) => ipcRenderer.invoke('set-speed-mode', mode),

  /**
   * 翻转 2x 速度模式：当前已是该模式则回到 normal，否则进入该模式。
   * @param {'fwd2x'|'rev2x'} mode
   * @returns {Promise<{ok: boolean, mode: string}>}
   */
  toggleSpeedMode: (mode) => ipcRenderer.invoke('toggle-speed-mode', mode),

  /**
   * 返回各组件版本号（关于面板用）。
   * @returns {{app: string, electron: string, node: string, chrome: string}}
   */
  getVersions: () => ({
    app: process.versions['app'] || 'dev',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }),

  /**
   * 加载外挂字幕（拖入 srt/ass/vtt 时调用）。
   * @param {string} path
   * @returns {Promise<{ok: boolean}>}
   */
  addSubtitle: (path) => ipcRenderer.invoke('add-subtitle', path),

  /**
   * 选择输出目录（批量剪辑用）。
   * @returns {Promise<string|null>}
   */
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),

  /**
   * 在资源管理器中定位文件。
   * @param {string} path
   * @returns {Promise<void>}
   */
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),

  /**
   * 应用信息（版本、二进制路径、支持的扩展名）。
   * @returns {Promise<{version: string, mpv: string, ffmpeg: string, userData: string}>}
   */
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  /**
   * 读取全部持久化设置（音量 / 最近文件 / 窗口位置）。
   * @returns {Promise<{volume: number, recentFiles: string[], lastDir: string}>}
   */
  getSettings: () => ipcRenderer.invoke('settings-get'),

  /**
   * 写入一个设置项（仅允许 volume / lastDir / window）。
   * @param {string} key
   * @param {any} value
   * @returns {Promise<boolean>} 是否写入成功
   */
  setSetting: (key, value) => ipcRenderer.invoke('settings-set', key, value),

  /**
   * 最近打开的文件列表。
   * @returns {Promise<string[]>}
   */
  getRecent: () => ipcRenderer.invoke('recent-list'),

  /**
   * 把渲染进程的报错写进主进程日志（window.onerror / unhandledrejection）。
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   */
  log: (level, message) => ipcRenderer.send('log-renderer', level, message),
});
