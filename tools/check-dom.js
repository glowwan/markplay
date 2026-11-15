'use strict';

/**
 * 开发自检：检查渲染进程里引用的 DOM id 是否都在 index.html 中定义，
 * 以及 index.html 引用的脚本文件是否存在。
 *
 * 覆盖两个渲染页面：主窗口（src/renderer）与悬浮控件层（src/overlay）。
 * 用法：npm run check:dom
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/** 每个页面的目录、HTML 文件、脚本文件清单 */
const PAGES = [
  {
    dir: path.join(root, 'src/renderer'),
    html: 'index.html',
    scripts: ['renderer.js', 'scrub.js', 'markers.js', 'export.js', 'ui.js', 'timeline-view.js'],
  },
  {
    dir: path.join(root, 'src/overlay'),
    html: 'index.html',
    scripts: ['overlay.js'],
  },
];

let allOk = true;

for (const page of PAGES) {
  const htmlPath = path.join(page.dir, page.html);
  if (!fs.existsSync(htmlPath)) {
    console.log(`[overlay] ${page.html} 不存在`);
    allOk = false;
    continue;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  const refs = new Map();
  for (const f of page.scripts) {
    const fp = path.join(page.dir, f);
    if (!fs.existsSync(fp)) {
      console.log(`  script ${f} 文件不存在`);
      allOk = false;
      continue;
    }
    const text = fs.readFileSync(fp, 'utf8');
    for (const m of text.matchAll(/(?:getElementById\(|\$\()\s*'([^']+)'/g)) {
      refs.set(m[1], f);
    }
  }

  const missing = [...refs.keys()].filter((id) => !defined.has(id));
  console.log(`[${page.html.split('.')[0] || 'page'}] defined: ${defined.size}, referenced: ${refs.size}`);
  if (missing.length) {
    console.log('  missing:', missing.map((id) => `${id} <- ${refs.get(id)}`).join(', '));
    allOk = false;
  }

  for (const m of html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)) {
    const p = path.join(page.dir, m[1]);
    const ok = fs.existsSync(p);
    if (!ok) allOk = false;
    console.log('  asset', m[1], ok ? 'OK' : 'MISSING');
  }
}

process.exit(allOk ? 0 : 1);
