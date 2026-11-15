'use strict';

/**
 * 悬浮控件层（overlay）的 preload。
 *
 * 只暴露 4 个能力，够 overlay.js 用：
 *  - setInteractive(bool)  切换鼠标穿透
 *  - command(name, arg)    发播放控制命令
 *  - forwardKey(evt)       把按键转回主窗口，避免快捷键失灵
 *  - onState(cb)           订阅播放状态变化
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  /**
   * 请求主进程切换本窗口的鼠标穿透。
   * @param {boolean} interactive true = 可点击，false = 穿透
   */
  setInteractive: (interactive) => {
    ipcRenderer.send('overlay-interactive', interactive === true);
  },

  /**
   * 发一条播放控制命令。
   * @param {'toggle-play'|'seek-ratio'|'volume'|'toggle-mute'|'toggle-fullscreen'} name
   * @param {any} [arg]
   * @returns {Promise<any>}
   */
  command: (name, arg) => ipcRenderer.invoke('overlay-command', name, arg),

  /**
   * 把按键转回主窗口。overlay 拿到焦点时用它兜底，
   * 否则 Space / A–G / Ctrl+Z 会全部失效。
   * @param {KeyboardEvent 的快照} evt
   */
  forwardKey: (evt) => {
    ipcRenderer.send('overlay-key', evt);
  },

  /**
   * 订阅播放状态。回调收到增量补丁，如 { currentTime: 12.3 }。
   * @param {(patch: object) => void} cb
   * @returns {() => void} 取消订阅
   */
  onState: (cb) => {
    const handler = (event, patch) => cb(patch);
    ipcRenderer.on('overlay-state', handler);
    return () => ipcRenderer.removeListener('overlay-state', handler);
  },
});
