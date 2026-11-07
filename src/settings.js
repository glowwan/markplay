'use strict';

/**
 * 轻量设置存储（<userData>/settings.json）。
 *
 * 纯 Node 实现，不依赖 Electron，便于在单元测试里注入临时目录。
 * 目前持久化的内容：音量、最近打开的文件、上次打开目录、主窗口几何。
 */
const fs = require('fs');
const path = require('path');

/** 最近文件保留数量 */
const MAX_RECENT = 12;

/** 默认设置（每次读取都返回副本，避免调用方改到内部状态） */
const DEFAULTS = Object.freeze({
  volume: 100,
  recentFiles: [],
  lastDir: '',
  window: null, // { x, y, width, height, maximized }
});

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 校验并归一化窗口几何，坏数据一律丢弃 */
function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  if (width < 400 || height < 300) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized: raw.maximized === true,
  };
}

class SettingsStore {
  /**
   * @param {string} filePath - settings.json 的完整路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = clone(DEFAULTS);
  }

  /** 从磁盘读取；文件不存在或损坏时安静地回退到默认值 */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const merged = Object.assign({}, clone(DEFAULTS), raw);
        this.data = {
          volume: isFiniteNumber(merged.volume) ? Math.min(100, Math.max(0, merged.volume)) : 100,
          recentFiles: Array.isArray(merged.recentFiles)
            ? merged.recentFiles.filter((p) => typeof p === 'string' && p.length > 0).slice(0, MAX_RECENT)
            : [],
          lastDir: typeof merged.lastDir === 'string' ? merged.lastDir : '',
          window: normalizeWindow(merged.window),
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[settings] 读取失败，使用默认值:', err.message);
      }
    }
    return this.data;
  }

  /** 写回磁盘（同步，文件很小） */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[settings] 写入失败:', err.message);
    }
  }

  /** 读取单个键（无参数时返回整个对象副本） */
  get(key) {
    return key === undefined ? clone(this.data) : clone(this.data[key]);
  }

  /** 设置单个键并立即落盘；未知键忽略，避免被渲染进程塞垃圾 */
  set(key, value) {
    switch (key) {
      case 'volume':
        if (!isFiniteNumber(value)) return false;
        this.data.volume = Math.min(100, Math.max(0, Math.round(value)));
        break;
      case 'lastDir':
        if (typeof value !== 'string') return false;
        this.data.lastDir = value;
        break;
      case 'window':
        this.data.window = normalizeWindow(value);
        break;
      default:
        return false;
    }
    this.save();
    return true;
  }

  /** 把文件置顶到最近列表（去重），并更新 lastDir */
  addRecent(filePath) {
    if (typeof filePath !== 'string' || !filePath) return this.data.recentFiles.slice();
    const list = this.data.recentFiles.filter((p) => p !== filePath);
    list.unshift(filePath);
    this.data.recentFiles = list.slice(0, MAX_RECENT);
    this.data.lastDir = path.dirname(filePath);
    this.save();
    return this.data.recentFiles.slice();
  }

  /** 从最近列表里移除（文件被删除时用） */
  removeRecent(filePath) {
    this.data.recentFiles = this.data.recentFiles.filter((p) => p !== filePath);
    this.save();
    return this.data.recentFiles.slice();
  }

  /** 清空最近记录 */
  clearRecent() {
    this.data.recentFiles = [];
    this.save();
    return [];
  }
}

module.exports = { SettingsStore, DEFAULTS, MAX_RECENT };
