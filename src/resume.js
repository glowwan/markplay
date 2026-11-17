'use strict';

/**
 * 续播记忆点的纯逻辑（不依赖 Electron，便于单测）。
 *
 * 设计取舍：
 *  - 以**绝对路径**（小写归一）为键，存"上次看到哪儿"；
 *  - 只记秒数 + 视频总长 + 时间戳，条目很小；
 *  - 有上限、按时间戳淘汰，避免 settings.json 越滚越大；
 *  - **"看完了"只由真实播放结束（EOF）决定**，本模块不做任何"离结尾多少秒算看完"
 *    的猜测——用户停在片尾前几秒也是"看到这里了"，下次就该从那里继续。
 *    EOF 时由主进程调用 clearEntry 清掉记录。
 */

/** 低于这个秒数不记（刚打开就关掉，没必要续播） */
const MIN_SECONDS = 8;
/** 最多保留多少条记录 */
const MAX_ENTRIES = 300;

/** 路径归一：Windows 大小写不敏感 */
function pathKey(p) {
  return String(p || '').toLowerCase();
}

/**
 * 校验并归一化一条记录。
 * @param {any} raw
 * @returns {{t: number, dur: number, at: number}|null}
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = Number(raw.t);
  if (!Number.isFinite(t) || t < 0) return null;
  const dur = Number(raw.dur);
  const at = Number(raw.at);
  return {
    t: Math.round(t * 100) / 100,
    dur: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 100) / 100 : 0,
    at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0,
  };
}

/**
 * 归一化整个记录表（读取 settings.json 时用）。
 * 丢掉坏数据，并按时间戳倒序只留 MAX_ENTRIES 条。
 * @param {any} raw
 * @returns {Record<string, {t:number,dur:number,at:number}>}
 */
function normalizeMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  const entries = [];
  for (const k of Object.keys(raw)) {
    if (typeof k !== 'string' || !k) continue;
    const e = normalizeEntry(raw[k]);
    if (!e) continue;
    entries.push([k, e]);
  }

  entries.sort((a, b) => b[1].at - a[1].at);
  for (const [k, e] of entries.slice(0, MAX_ENTRIES)) out[k] = e;
  return out;
}

/**
 * 写到表里（就地修改），顺手按时间淘汰。
 *
 * 注意：这里**不做**"快到结尾就不记"的判断——那属于播放语义，
 * 由主进程在收到 EOF 时清记录。
 *
 * @param {Record<string, any>} map
 * @param {string} filePath
 * @param {number} t 当前播放位置（秒）
 * @param {number} dur 视频总长（秒，未知传 0）
 * @param {number} now 时间戳（毫秒）
 * @returns {boolean} 是否真的写了
 */
function putEntry(map, filePath, t, dur, now) {
  if (!map || typeof map !== 'object') return false;
  if (typeof filePath !== 'string' || !filePath) return false;
  const pos = Number(t);
  if (!Number.isFinite(pos) || pos < 0) return false;

  const key = pathKey(filePath);
  const total = Number(dur);
  // 时长未知时沿用已有记录的时长，避免把有用的信息覆盖成 0
  const prev = map[key];
  const prevDur = prev && Number.isFinite(prev.dur) && prev.dur > 0 ? prev.dur : 0;
  const effectiveDur = (Number.isFinite(total) && total > 0) ? total : prevDur;

  map[key] = {
    t: Math.round(pos * 100) / 100,
    dur: Math.round(effectiveDur * 100) / 100,
    at: Number.isFinite(now) ? Math.round(now) : Date.now(),
  };

  // 超额淘汰最旧的
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
  }
  return true;
}

/**
 * 取某个文件的记忆点。
 * @param {Record<string, any>} map
 * @param {string} filePath
 * @returns {{t:number,dur:number,at:number}|null}
 */
function getEntry(map, filePath) {
  if (!map || typeof map !== 'object') return null;
  return normalizeEntry(map[pathKey(filePath)]);
}

/**
 * 是否值得续播。
 *
 * 只有一条否决条件：位置太靠前（刚打开就关掉，续播没有意义）。
 * 其余一律按记录的位置续播——包括停在片尾前几秒的情况。
 *
 * @param {any} entry
 * @returns {number} 要跳到的秒数；0 表示不续播
 */
function resumeAt(entry) {
  const e = normalizeEntry(entry);
  if (!e) return 0;
  if (e.t < MIN_SECONDS) return 0;
  return e.t;
}

/**
 * 删除某条。
 * 主进程在两个时机调用：播到结尾（EOF），用户点"从头开始"。
 * @returns {boolean} 是否真的删了
 */
function clearEntry(map, filePath) {
  if (!map || typeof map !== 'object') return false;
  const k = pathKey(filePath);
  if (!(k in map)) return false;
  delete map[k];
  return true;
}

module.exports = {
  MAX_ENTRIES,
  MIN_SECONDS,
  clearEntry,
  getEntry,
  normalizeEntry,
  normalizeMap,
  pathKey,
  putEntry,
  resumeAt,
};
