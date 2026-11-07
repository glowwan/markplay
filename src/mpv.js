'use strict';

const net = require('net');
const EventEmitter = require('events');

/** IPC 命令超时（毫秒） */
const COMMAND_TIMEOUT_MS = 5000;

/**
 * mpv 命名管道 JSON IPC 客户端。
 *
 * - 通过 Windows 命名管道连接（`\\\\.\\pipe\\<name>`）。
 * - mpv 的 JSON IPC 是行分隔协议：每条请求/响应/事件以 `\n` 结尾。
 * - 请求带自增 request_id，响应里回带 request_id 以做配对。
 * - 主动发送命令：`send(commandArray)`；订阅属性：`observe(id, name)`。
 * - 事件：
 *   - 'property-change'  { id, name, data }   // 属性值变化
 *   - 'event'            mpv 原生事件对象     // 如 end-file、file-loaded 等
 *   - 'close'            管道断开
 *   - 'error'            socket 错误
 */
class MpvClient extends EventEmitter {
  constructor() {
    super();
    /** @type {net.Socket|null} */
    this.socket = null;
    /** 半包缓冲 */
    this.buffer = '';
    /** 自增请求 id */
    this.requestId = 0;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
  }

  /**
   * 连接到 mpv 的 IPC 管道。
   * @param {string} pipePath - 形如 `\\\\.\\pipe\\markplay-1234` 的管道路径
   * @returns {Promise<void>} 连接成功 resolve，失败 reject
   */
  connect(pipePath) {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        reject(new Error('已经连接，不要重复调用 connect'));
        return;
      }
      const socket = net.createConnection(pipePath);
      socket.setEncoding('utf8');

      // 失败的尝试绝不能向外 emit 'error'：
      // MpvClient 在连接成功前还没有挂 'error' 监听器，直接 emit 会变成主进程的
      // Uncaught Exception 弹窗（曾导致 "connect ENOENT \\.\pipe\markplay-xxx" 报错框）。
      let settled = false;
      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };
      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.socket = socket;
        // 只有连接成功后才挂载常驻的 data/close/error 处理
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => {
          this._failAllPending(new Error('mpv 管道已断开'));
          this.socket = null;
          this.buffer = '';
          this.emit('close');
        });
        socket.on('error', (err) => {
          this.emit('error', err);
        });
        resolve();
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        // 彻底销毁失败的 socket，防止它稍后再次触发事件
        try { socket.destroy(); } catch { /* 忽略 */ }
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  /**
   * 发送一条 JSON IPC 命令。
   * @param {any[]} commandArray - mpv 命令数组，如 ['get_property', 'time-pos']
   * @returns {Promise<{error: string, data: any}>} 响应对象
   */
  send(commandArray) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('mpv 未连接，无法发送命令'));
        return;
      }
      const id = ++this.requestId;
      const payload = JSON.stringify({ command: commandArray, request_id: id }) + '\n';

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv 命令超时: ${JSON.stringify(commandArray)}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      this.socket.write(payload, (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(err);
          }
        }
      });
    });
  }

  /**
   * 订阅 mpv 属性变化。属性变化会触发 'property-change' 事件。
   * @param {number} id - 观察 id（由调用方自定，用于事件里区分属性）
   * @param {string} name - mpv 属性名，如 'time-pos'
   * @returns {Promise<any>}
   */
  observe(id, name) {
    return this.send(['observe_property', id, name]);
  }

  /**
   * 关闭管道连接。会 reject 所有未响应的 pending 命令。
   */
  close() {
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.end();
    }
    this._failAllPending(new Error('MpvClient 已关闭'));
    this.buffer = '';
  }

  /** 管道是否仍处于连接状态 */
  get connected() {
    return !!this.socket;
  }

  // ---------- 内部实现 ----------

  /**
   * 处理 socket 数据：按 `\n` 切分行，容忍半包。
   * @private
   */
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      this._onLine(line);
    }
  }

  /**
   * 处理单行 JSON 消息。
   * @private
   */
  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // mpv 偶尔会输出非 JSON 行（如警告），忽略即可
      return;
    }

    // 1) 命令响应：带 request_id
    if (msg.request_id !== undefined) {
      const p = this.pending.get(msg.request_id);
      if (p) {
        this.pending.delete(msg.request_id);
        clearTimeout(p.timer);
        if (msg.error !== 'success') {
          p.reject(new Error(`mpv 命令失败: ${msg.error} (命令=${JSON.stringify(msg.command || '')})`));
        } else {
          p.resolve({ error: msg.error, data: msg.data });
        }
      }
      return;
    }

    // 2) 属性变化事件
    if (msg.event === 'property-change') {
      this.emit('property-change', { id: msg.id, name: msg.name, data: msg.data });
      return;
    }

    // 3) mpv 原生事件（如 end-file、file-loaded）
    if (msg.event) {
      this.emit('event', msg);
      return;
    }

    // 4) 其他未知消息，忽略
  }

  /**
   * 用给定错误 reject 所有 pending 命令。
   * @private
   */
  _failAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

module.exports = { MpvClient };
