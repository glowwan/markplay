'use strict';

/**
 * 翻译覆盖率回归测试。
 *
 * 这组测试针对"改完就漏"的典型场景：
 *  - 新加的界面文字忘了打 data-i18n
 *  - 文案写进 CSS content（运行时语言切换根本管不到）
 *  - 代码里硬编码中文
 *  - 英文字典里粘了中文
 *
 * 任何一条失败都说明有用户可见的中文会漏到英文界面里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CJK = /[\u4e00-\u9fa5]/;

const zh = require('../src/locales/zh-CN');
const en = require('../src/locales/en-US');

/** 有意保留中文的键：双语并列的标签 */
const BILINGUAL_ALLOWED = new Set([
  'menu.language',
  'ui.langSwitchDesc',
  'locale.chinese',
]);

function flatten(obj, prefix, out) {
  const acc = out || [];
  const pre = prefix ? prefix + '.' : '';
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, pre + k, acc);
    else acc.push([pre + k, v]);
  }
  return acc;
}

test('英文字典里没有残留中文（双语标签除外）', () => {
  const bad = [];
  for (const [k, v] of flatten(en)) {
    if (CJK.test(String(v)) && !BILINGUAL_ALLOWED.has(k)) bad.push(`${k} = ${JSON.stringify(v)}`);
  }
  assert.deepEqual(bad, [], '这些英文条目还含中文：\n' + bad.join('\n'));
});

test('中文字典里没有残留英文整句（排除技术名词与快捷键）', () => {
  // 允许：纯技术词、含字母的快捷键说明、URL、占位符，以及语言名（用母语写法）
  const allow = /^(MarkPlay|CSV|JSON|EDL|A–B|mpv|ffmpeg|Electron|English|Chinese)/;
  const allowKeys = new Set(['locale.chinese', 'locale.english']);
  const bad = [];
  for (const [k, v] of flatten(zh)) {
    const s = String(v);
    if (CJK.test(s)) continue;           // 含中文，正常
    if (s.trim().length <= 6) continue;   // 短标签（A、▶、×{n}）无需翻译
    if (!/[A-Za-z]{4,}/.test(s)) continue; // 没成词
    if (allow.test(s.trim())) continue;
    if (allowKeys.has(k)) continue;
    bad.push(`${k} = ${JSON.stringify(v)}`);
  }
  // 这条只做提示性断言：中文字典里出现纯英文长句通常是漏写
  assert.deepEqual(bad, [], '这些中文条目看起来是英文：\n' + bad.join('\n'));
});

test('index.html 里没有未接 i18n 的中文文本节点', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

  /** 精确判断属性存在，避免 data-i18n 误匹配 data-i18n-title */
  const hasAttr = (tag, name) => new RegExp(`\\s${name}\\s*=`).test(tag);

  const bad = [];
  const TEXT = />([^<>]+)</g;
  let m;
  while ((m = TEXT.exec(html)) !== null) {
    const body = m[1];
    if (!CJK.test(body)) continue;
    if (/^\s*<!--/.test(body)) continue;

    const lastOpen = html.lastIndexOf('<', m.index);
    const close = html.indexOf('>', lastOpen);
    const tag = html.slice(lastOpen, close + 1);

    if (hasAttr(tag, 'data-i18n')) continue;
    // 语言切换按钮本身写「中/EN」是有意的
    if (hasAttr(tag, 'id') && /id="btn-lang"/.test(tag)) continue;

    const ln = html.slice(0, m.index).split('\n').length;
    bad.push(`index.html:${ln}  ${body.trim().slice(0, 50)}`);
  }
  assert.deepEqual(bad, [], '这些中文文本节点缺 data-i18n：\n' + bad.join('\n'));
});

test('index.html 里没有未接 i18n 的中文 title / placeholder', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const hasAttr = (tag, name) => new RegExp(`\\s${name}\\s*=`).test(tag);

  const bad = [];
  for (const [attr, marker] of [['title', 'data-i18n-title'], ['placeholder', 'data-i18n-placeholder']]) {
    const re = new RegExp(`\\s${attr}="([^"]*)"`, 'g');
    let m;
    while ((m = re.exec(html)) !== null) {
      const value = m[1];
      if (!CJK.test(value)) continue;
      const lastOpen = html.lastIndexOf('<', m.index);
      const close = html.indexOf('>', m.index);
      const tag = html.slice(lastOpen, close + 1);
      if (hasAttr(tag, marker)) continue;
      // 双语并列的说明性 title 可接受
      if (/[A-Za-z]/.test(value) && (value.includes('/') || /\bor\b/.test(value))) continue;
      const ln = html.slice(0, m.index).split('\n').length;
      bad.push(`index.html:${ln}  ${attr}="${value.slice(0, 40)}"`);
    }
  }
  assert.deepEqual(bad, [], '这些属性缺对应 data-i18n-*：\n' + bad.join('\n'));
});

test('CSS 里没有写中文到 content 属性', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  const bad = [];
  for (const m of css.matchAll(/content:\s*([^;]+);/g)) {
    if (CJK.test(m[1])) {
      const ln = css.slice(0, m.index).split('\n').length;
      bad.push(`styles.css:${ln}  ${m[1].trim().slice(0, 50)}`);
    }
  }
  assert.deepEqual(bad, [], 'CSS content 无法跟随语言切换，应改由 JS 渲染：\n' + bad.join('\n'));
});

test('渲染进程与主进程源码里没有硬编码中文文案', () => {
  const FILES = [
    'src/main.js', 'src/preload.js', 'src/mpv.js',
    'src/renderer/renderer.js', 'src/renderer/export.js', 'src/renderer/markers.js',
    'src/renderer/scrub.js', 'src/renderer/ui.js', 'src/renderer/scenes.js',
    'src/renderer/timeline-view.js', 'src/renderer/i18n-apply.js',
  ];

  /** 允许保留：日志、IME 键位别名、语言菜单里的母语标签 */
  const ALLOW_LINE = [
    /^\s*(console\.|logInfo|logWarn|logError)/,   // 日志不进界面
    /case '【'/,                                   // 输入法下的方括号别名
    /case '】'/,
    /label: '中文'/,                               // 语言菜单：各语言用母语写法
    /next === 'zh-CN' \? '中文'/,
  ];

  const bad = [];
  for (const rel of FILES) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split('\n');
    // 剥掉注释，保留行结构以便回推行号
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

    const STR = /(['"`])((?:[^'"`\\\n]|\\.)*)\1/g;
    let m;
    while ((m = STR.exec(stripped)) !== null) {
      if (!CJK.test(m[2])) continue;
      const ln = stripped.slice(0, m.index).split('\n').length;
      const src = (lines[ln - 1] || '').trim();
      if (ALLOW_LINE.some((re) => re.test(src))) continue;
      bad.push(`${rel}:${ln}  ${src.slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, [], '这些中文硬编码在源码里，英文界面会漏出来：\n' + bad.join('\n'));
});

test('区间默认名（存的是中文）在英文界面会按当前语言重算', () => {
  // 区间名是创建时按当时语言写进 sidecar 的，切语言后必须重新生成，
  // 否则英文界面里会一直显示「区间 1」。用 vm 真跑一遍 markers.js。
  const vm = require('node:vm');
  const { createTranslator, normalize } = require('../src/i18n.js');
  const dictZh = require('../src/locales/zh-CN.js');
  const dictEn = require('../src/locales/en-US.js');
  const DICTS = { 'zh-CN': dictZh, 'en-US': dictEn };

  const mkEl = () => ({
    className: '', textContent: '', title: '', style: {}, dataset: {}, value: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, querySelectorAll: () => [],
    set innerHTML(v) { this.children.length = 0; },
    get innerHTML() { return ''; },
  });

  function loadMarkers(lang) {
    const code = normalize(lang);
    const translator = createTranslator(code, DICTS[code], dictZh);
    const sandbox = {
      window: {
        markplay: {
          t: (k, p) => translator(k, p),
          getLanguage: () => code,
          config: { MARKER_COLORS: { A: '#f00' }, HISTORY_LIMIT: 50 },
          writeJsonFile: async () => {},
          readJsonFile: async () => null,
        },
      },
      document: {
        documentElement: { lang: '' },
        getElementById: () => null,
        createElement: mkEl,
        querySelectorAll: () => [],
      },
      console,
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/i18n-apply.js'), 'utf8'), ctx, { filename: 'i18n-apply.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/markers.js'), 'utf8'), ctx, { filename: 'markers.js' });
    return ctx.Markers;
  }

  const zhM = loadMarkers('zh-CN');
  const enM = loadMarkers('en-US');

  assert.equal(typeof enM.displayRangeName, 'function', 'markers.js 应导出 displayRangeName');

  // 中文存的默认名 -> 英文界面显示英文
  assert.equal(enM.displayRangeName({ name: '区间 1' }), 'Range 1');
  assert.equal(enM.displayRangeName({ name: '区间 12' }), 'Range 12');
  assert.equal(zhM.displayRangeName({ name: 'Range 3' }), '区间 3');

  // 用户手改的名字原样保留
  assert.equal(enM.displayRangeName({ name: '开场' }), '开场');
  assert.equal(enM.displayRangeName({ name: 'Intro' }), 'Intro');

  // 空名按序号兜底
  assert.equal(enM.displayRangeName({ name: '' }, 4), 'Range 4');
});
