'use strict';

/**
 * 开发自检：检查渲染进程里引用的 DOM id 是否都在 index.html 中定义，
 * 以及 index.html 引用的脚本文件是否存在。
 *
 * 用法：npm run check:dom
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const files = ['renderer.js', 'scrub.js', 'markers.js', 'export.js', 'ui.js', 'timeline-view.js'];
const refs = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8');
  for (const m of text.matchAll(/(?:getElementById\(|\$\()\s*'([^']+)'/g)) {
    refs.set(m[1], f);
  }
}
const missing = [...refs.keys()].filter((id) => !defined.has(id));
console.log('defined:', defined.size, 'referenced:', refs.size);
console.log('missing:', missing.length ? missing.map((id) => `${id} <- ${refs.get(id)}`).join('\n') : '(none)');

let scriptsOk = true;
for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const p = path.join(root, 'src/renderer', m[1]);
  const ok = fs.existsSync(p);
  if (!ok) scriptsOk = false;
  console.log('script', m[1], ok ? 'OK' : 'MISSING');
}

if (missing.length || !scriptsOk) process.exit(1);
