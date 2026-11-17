'use strict';

/**
 * 主窗口的 preload 脚本。
 * 通过 contextBridge 向渲染进程暴露一个最小化、类型安全的 API：window.markplay。
 */
const { contextBridge, ipcRenderer } = require('electron');
const config = require('./config');
const { createTranslator, normalize } = require('./i18n');
const dictZh = require('./locales/zh-CN');
const dictEn = require('./locales/en-US');

const DICTS = { 'zh-CN': dictZh, 'en-US': dictEn };

/**
 * 渲染进程侧的翻译函数。
 *
 * 语言由主进程通过同步 IPC 直接注入到这里，所以页面首帧就是正确语言，
 * 不会出现"先闪一下中文再变英文"。切换语言时主进程发 language-changed，
 * 渲染进程改用 window.markplay.setLanguage() 替换。
 */
let currentLang = 'zh-CN';
try {
  // 同步取值：preload 在页面脚本之前执行，这一步开销极小（读内存里的变量）
  const injected = ipcRenderer.sendSync('get-language');
  currentLang = normalize(injected);
} catch {
  // sendSync 不可用（理论上不会），退回中文，不影响启动
  currentLang = 'zh-CN';
}

let translator = createTranslator(currentLang, DICTS[currentLang], dictZh);

contextBridge.exposeInMainWorld('markplay', {
  /**
   * 共享配置（只读快照）：SCRUB_SENSITIVITY、MARKER_COLORS 等。
   * 注意：config.js 是纯数据模块，直接暴露整个对象是安全的。
   */
  config,

  /**
   * 当前界面语言。
   * @returns {'zh-CN'|'en-US'}
   */
  getLanguage: () => currentLang,

  /**
   * 取一条翻译。渲染进程里可以直接用 window.markplay.t('ui.markers')。
   * @param {string} key 点号路径
   * @param {object} [params] 插值参数
   * @returns {string}
   */
  t: (key, params) => translator(key, params),

  /**
   * 切换语言（仅渲染进程内部使用；真正的切换由主进程发起的 language-changed 驱动）。
   * @param {'zh-CN'|'en-US'} lang
   */
  setLanguage: (lang) => {
    const next = normalize(lang);
    if (next === currentLang) return;
    currentLang = next;
    translator = createTranslator(currentLang, DICTS[currentLang], dictZh);
  },

  /**
   * 请求主进程切换语言（设置落盘 + 菜单重建 + 通知渲染进程重刷）。
   * @param {'zh-CN'|'en-US'} lang
   * @returns {Promise<{ok: boolean, language: string}>}
   */
  switchLanguage: (lang) => ipcRenderer.invoke('set-language', lang),

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
   * 弹出"打开视频文件"对话框（支持多选）。
   *
   * 多选时主进程会直接建好文件列表并打开第一个文件，
   * 渲染进程只需要知道这次选了几个（用来决定要不要提示）。
   *
   * @returns {Promise<{canceled: boolean, count: number, paths?: string[]}>}
   */
  openVideos: () => ipcRenderer.invoke('open-videos'),

  /**
   * 拖入多个本地文件时调用：主进程建文件列表并打开第一个。
   * @param {string[]} paths
   * @returns {Promise<{ok: boolean, count: number}>}
   */
  openVideosFromPaths: (paths) => ipcRenderer.invoke('open-videos-from-paths', paths),

  /**
   * 推送全屏播放状态栏的状态快照（标记 / 区间 / 转场 / 视图范围等）。
   * 状态栏窗口没有 Markers / TimelineView，这些数据只能由这里提供。
   * @param {object} snapshot
   * @returns {Promise<{ok: boolean}>}
   */
  controlsState: (snapshot) => ipcRenderer.invoke('controls-state', snapshot),

  /**
   * 告诉主进程"这个文件已经载入成功"，文件列表据此移动高亮。
   * 对话框 / 拖放 / 最近打开 / 列表点击 / 启动参数都会走到这里。
   * @param {string} filePath
   * @returns {Promise<{ok: boolean}>}
   */
  notePlaylistCurrent: (filePath) => ipcRenderer.invoke('playlist-note-current', filePath),

  /**
   * 清掉某个视频的续播记忆点（用户点"从头开始"时调用）。
   * @param {string} filePath
   * @returns {Promise<{ok: boolean}>}
   */
  clearResumePoint: (filePath) => ipcRenderer.invoke('clear-resume-point', filePath),

  /**
   * 切换文件列表显示。
   * @returns {Promise<{ok: boolean, visible: boolean}>}
   */
  togglePlaylist: () => ipcRenderer.invoke('toggle-playlist'),

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
   * 把标记文件复制一份带时间戳的备份（`<视频>.markplay.json.bak-YYYYMMDD-HHmmss`），
   * 并自动清理超出保留数量的旧备份。
   * @param {string} sidecarPath 标记文件的完整路径
   * @returns {Promise<{ok: boolean, path?: string, removed?: number, error?: string}>}
   */
  backupSidecar: (sidecarPath) => ipcRenderer.invoke('backup-sidecar', sidecarPath),

  /**
   * 识别画面转场（只用于时间轴上的提示浮标，不写入标记）。
   * 进度与结果通过 player-event 的 scene-progress / scene-detected / scene-error 上报。
   * @param {{threshold?: number}} [opts] 0.05–0.95，越小越敏感
   * @returns {Promise<{ok: boolean, threshold?: number, cached?: boolean, error?: string}>}
   */
  detectScenes: (opts) => ipcRenderer.invoke('detect-scenes', opts),

  /**
   * 取消正在进行的转场识别。
   * @returns {Promise<{ok: boolean, running: boolean}>}
   */
  cancelScenes: () => ipcRenderer.invoke('cancel-scenes'),

  /**
   * 把渲染进程的报错写进主进程日志（window.onerror / unhandledrejection）。
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   */
  log: (level, message) => ipcRenderer.send('log-renderer', level, message),
});
