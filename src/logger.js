'use strict';

/**
 * 极简文件日志：写到 <userData>/logs/markplay.log，超过上限自动轮转。
 *
 * 目标不是做日志框架，而是让"用户说有问题"时有东西可查：
 * 主进程异常、渲染进程报错、mpv 的 stderr、ffmpeg 失败原因都汇总到同一个文件。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  maxBytes: 2 * 1024 * 1024, // 单文件上限 2MB
  maxFiles: 5,               // 最多保留 5 个历史文件
};

function formatArg(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

class Logger {
  /**
   * @param {string} dir 日志目录
   * @param {{maxBytes?: number, maxFiles?: number}} [opts]
   */
  constructor(dir, opts) {
    this.dir = dir;
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this.file = path.join(dir, 'markplay.log');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 目录不可写时退化为"只输出到控制台"
    }
  }

  /** 当前日志文件路径（菜单"打开日志文件夹"用） */
  getPath() {
    return this.file;
  }

  /**
   * 写入一行。
   * @param {'INFO'|'WARN'|'ERROR'} level
   * @param {any[]} args
   */
  write(level, args) {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatArg).join(' ')}\n`;
    // 控制台始终输出，开发时能直接看到
    if (level === 'ERROR') console.error(line.trimEnd());
    else if (level === 'WARN') console.warn(line.trimEnd());
    else console.log(line.trimEnd());

    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.file, line, 'utf8');
    } catch {
      // 日志失败不能影响主流程
    }
  }

  info(...args) { this.write('INFO', args); }
  warn(...args) { this.write('WARN', args); }
  error(...args) { this.write('ERROR', args); }

  /** 超过 maxBytes 就把当前文件改名成 .1，旧的依次后移 */
  _rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // 文件还不存在
    }
    if (size < this.opts.maxBytes) return;

    const max = Math.max(1, this.opts.maxFiles - 1);
    try {
      // 删最老的
      const oldest = `${this.file}.${max}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let i = max - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // 轮转失败就继续往当前文件写
    }
  }
}

module.exports = { Logger, DEFAULTS };
