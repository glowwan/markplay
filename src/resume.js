'use strict';

/**
 * 续播记忆点的纯逻辑（不依赖 Electron，便于单测）。
 *
 * 设计取舍：
 *  - 以**绝对路径**（小写归一）为键，存"上次看到哪儿"；
 *  - 只记秒数 + 视频总长 + 时间戳，不记别的，条目很小；
 *  - 有上限、按时间戳淘汰，避免 settings.json 越滚越大；
 *  - "看到结尾"的不记（下次打开应当从头看，而不是停在最后一秒）。
 */

/** 低于这个秒数不记（刚打开就关掉，没必要） */
const MIN_SECONDS = 8;
/** 写入时：距离结尾不足这个秒数就不记（视为已看完） */
const WRITE_END_MARGIN = 3;
/** 续播时：距离结尾不足这个秒数就不续播（比写入更严格，容忍几秒误差） */
const RESUME_END_MARGIN = 15;
/** 兼容旧名字（= 写入容差） */
const END_MARGIN = WRITE_END_MARGIN;
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
  const dur = Number(raw.dur);
  const at = Number(raw.at);
  if (!Number.isFinite(t) || t < 0) return null;
  return {
    t: Math.max(0, Math.round(t * 100) / 100),
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
 * 写到表里（就地修改并返回），顺手按时间淘汰。
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

  const total = Number(dur);
  const key = pathKey(filePath);

  // 时长未知时的兜底：如果之前记过这支视频的时长，就拿它来做"是否到结尾"的判断。
  // 否则调用方一旦漏传 dur（比如换片时先清了时长），片尾位置就会被存成续播点，
  // 下次打开直接停在最后一秒。这条防御让模块不再依赖调用顺序。
  const prev = map[key];
  const prevDur = prev && Number.isFinite(prev.dur) && prev.dur > 0 ? prev.dur : 0;
  const effectiveDur = (Number.isFinite(total) && total > 0) ? total : prevDur;

  // 看到结尾（或更后）不记：下次打开应该从头看
  if (effectiveDur > 0 && pos >= effectiveDur - WRITE_END_MARGIN) {
    delete map[key];
    return false;
  }

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
  const raw = map[pathKey(filePath)];
  return normalizeEntry(raw);
}

/**
 * 是否值得续播。
 *
 * 不满足下面任一条就返回 0（从头播）：
 *  - 有记录且位置 > MIN_SECONDS；
 *  - 没有总长信息，或位置明确还没到结尾附近（RESUME_END_MARGIN 比写入更严格）。
 *
 * @param {any} entry
 * @returns {number} 要跳到的秒数；0 表示不续播
 */
function resumeAt(entry) {
  const e = normalizeEntry(entry);
  if (!e) return 0;
  if (e.t < MIN_SECONDS) return 0;
  if (e.dur > 0 && e.t >= e.dur - RESUME_END_MARGIN) return 0;
  return e.t;
}

/** 删除某条（用户选择"从头开始"时） */
function clearEntry(map, filePath) {
  if (!map || typeof map !== 'object') return false;
  const k = pathKey(filePath);
  if (!(k in map)) return false;
  delete map[k];
  return true;
}

module.exports = {
  END_MARGIN,
  MAX_ENTRIES,
  MIN_SECONDS,
  RESUME_END_MARGIN,
  WRITE_END_MARGIN,
  clearEntry,
  getEntry,
  normalizeEntry,
  normalizeMap,
  pathKey,
  putEntry,
  resumeAt,
};
