'use strict';

/**
 * 开发自检：
 *  1. 每个页面里引用的 DOM id 都在对应 HTML 中定义；
 *  2. HTML 引用的脚本 / 样式文件都存在；
 *  3. HTML 里 data-i18n* 标注引用的字典键都存在。
 *
 * 覆盖三个渲染页面：主窗口、文件列表窗口。
 * 用法：npm run check:dom
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/** 每个页面的目录、HTML、脚本清单 */
const PAGES = [
  {
    dir: path.join(root, 'src/renderer'),
    label: 'main',
    html: 'index.html',
    scripts: ['renderer.js', 'scrub.js', 'markers.js', 'export.js', 'ui.js', 'timeline-view.js', 'scenes.js', 'i18n-apply.js'],
  },
  {
    dir: path.join(root, 'src/playlist'),
    label: 'playlist',
    html: 'index.html',
    scripts: ['playlist.js'],
  },

  {
    dir: path.join(root, 'src/controls'),
    label: 'controls',
    html: 'index.html',
    scripts: ['controls.js'],
  },
];

/** 字典（用于校验 data-i18n 引用的键） */
const dictZh = require(path.join(root, 'src', 'locales', 'zh-CN.js'));
const dictEn = require(path.join(root, 'src', 'locales', 'en-US.js'));
const { lookup } = require(path.join(root, 'src', 'i18n.js'));

let allOk = true;

for (const page of PAGES) {
  const htmlPath = path.join(page.dir, page.html);
  if (!fs.existsSync(htmlPath)) {
    console.log(`[${page.label}] ${page.html} 不存在`);
    allOk = false;
    continue;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  const refs = new Map();
  for (const f of page.scripts) {
    const fp = path.join(page.dir, f);
    if (!fs.existsSync(fp)) {
      console.log(`  [${page.label}] script ${f} 文件不存在`);
      allOk = false;
      continue;
    }
    const text = fs.readFileSync(fp, 'utf8');
    for (const m of text.matchAll(/(?:getElementById\(|\$\()\s*'([^']+)'/g)) {
      refs.set(m[1], f);
    }
  }

  const missing = [...refs.keys()].filter((id) => !defined.has(id));
  console.log(`[${page.label}] defined: ${defined.size}, referenced: ${refs.size}`);
  if (missing.length) {
    console.log('  missing:', missing.map((id) => `${id} <- ${refs.get(id)}`).join(', '));
    allOk = false;
  }

  // 脚本与样式引用
  for (const m of html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)) {
    const p = path.join(page.dir, m[1]);
    const ok = fs.existsSync(p);
    if (!ok) allOk = false;
    console.log(`  asset ${m[1]} ${ok ? 'OK' : 'MISSING'}`);
  }

  // data-i18n* 引用的键
  const i18nKeys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) i18nKeys.add(m[1]);
  const badKeys = [...i18nKeys].filter(
    (k) => typeof lookup(dictZh, k) !== 'string' || typeof lookup(dictEn, k) !== 'string'
  );
  console.log(`  i18n keys: ${i18nKeys.size}, missing: ${badKeys.length ? badKeys.join(', ') : '(none)'}`);
  if (badKeys.length) allOk = false;
}

process.exit(allOk ? 0 : 1);
