'use strict';

/**
 * 源码健全性：不许有重复的顶层函数定义。
 *
 * 背景（v1.14.1 的教训）：加"左键双击播放/暂停"时，替换旧 `handleSurfaceClick`
 * 的补丁只换掉了文件开头那一段，旧函数的函数体残留在了后面。
 * JavaScript 的函数声明会被后者覆盖，于是**新实现静默失效**，
 * 双击完全没反应——而单测、语法检查、契约测试全都通过。
 *
 * 所以这里做一个最朴素的检查：同一个文件里，顶层 `function 同名(` 只能出现一次。
 * 这类检查成本极低，却能挡住"改动没落到位"的整类问题。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 要检查的文件（模块级 function 声明） */
const FILES = [
  'src/main.js',
  'src/preload.js',
  'src/mpv.js',
  'src/settings.js',
  'src/media-utils.js',
  'src/sidecar-backup.js',
  'src/resume.js',
  'src/rev-step.js',
  'src/remux.js',
  'src/click-gesture.js',
  'src/playlist-model.js',
  'src/logger.js',
  'src/i18n.js',
];

test('模块级 function 声明不重复', () => {
  const problems = [];
  for (const rel of FILES) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 允许 async function：漏掉它会让 async 函数逃过检查
    const names = [...text.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)].map((m) => m[1]);
    const counts = new Map();
    for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
    for (const [n, c] of counts) {
      if (c > 1) problems.push(`${rel}: ${n} 定义了 ${c} 次`);
    }
  }
  assert.deepEqual(problems, [], '重复定义会让后者覆盖前者，等于新代码没生效：\n' + problems.join('\n'));
});

test('画面点击的各个动作各自只定义一次', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  for (const fn of ['handleSurfaceClick', 'onLeftSingleClick', 'onLeftDoubleClick', 'togglePause', 'stopReverseSilently', 'focusMainWindow']) {
    const c = (main.match(new RegExp(`^(?:async\\s+)?function ${fn}\\s*\\(`, 'gm')) || []).length;
    assert.equal(c, 1, `${fn} 应恰好定义 1 次，实际 ${c} 次`);
  }
});

test('handleSurfaceClick 用的是手势判定（不是被旧实现覆盖）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const idx = main.indexOf('function handleSurfaceClick(');
  assert.ok(idx > 0, '找不到 handleSurfaceClick');
  // 取到下一个顶层 function 之前的内容
  const next = main.indexOf('\nfunction ', idx + 10);
  const body = next > 0 ? main.slice(idx, next) : main.slice(idx);
  assert.ok(body.includes('ClickGesture.resolve'), '函数体里应调用 ClickGesture.resolve');
  assert.ok(body.includes('onLeftDoubleClick'), '应处理双击');
  assert.ok(!/lastSurfaceClickAt < 300/.test(body), '不应残留旧的 300ms 去重逻辑');
});
