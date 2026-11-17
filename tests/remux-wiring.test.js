'use strict';

/**
 * 源码契约测试：为无索引容器建立索引（转封装）。
 *
 * 纯逻辑在 src/remux.js（已有 tests/remux.test.js 覆盖），
 * 这里钉住"接线"部分——它跨 main / preload / renderer 三处，
 * 少接一根线就会表现为"点了没反应"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

function bodyOf(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js 里找不到 ${name}`);
  const braceStart = MAIN.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++;
    else if (MAIN[i] === '}') {
      depth--;
      if (depth === 0) return MAIN.slice(braceStart, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没闭合`);
}

test('主进程实现了转封装并注册 IPC', () => {
  assert.ok(/function remuxForIndex\s*\(/.test(MAIN), '应有 remuxForIndex()');
  const channels = new Set([...MAIN.matchAll(/ipcMain\.(?:on|handle)\('([^']+)'/g)].map((m) => m[1]));
  assert.ok(channels.has('remux-index'), '应注册 remux-index');
});

test('转封装走 remux.js 的纯逻辑（不自己拼路径/参数）', () => {
  const f = bodyOf('remuxForIndex');
  assert.ok(f.includes('Remux.needsIndex'), '应先用 needsIndex 判断要不要做');
  assert.ok(f.includes('Remux.buildOutputPath'), '输出路径应走 buildOutputPath（不覆盖已有文件）');
  const runner = bodyOf('runFfmpegRemux');
  assert.ok(runner.includes('Remux.remuxArgs'), '参数应走 remuxArgs（-c copy）');
  assert.ok(runner.includes('Remux.parseProgressPercent'), '进度应走 parseProgressPercent');
  assert.ok(runner.includes('-progress'), '应让 ffmpeg 输出机器可读进度');
});

test('转封装必须流拷贝，不能悄悄重编码', () => {
  const runner = bodyOf('runFfmpegRemux');
  assert.ok(!/libx264|libx265|-crf/.test(runner), '转封装路径不许出现编码/质量参数');
});

test('转封装期间有并发保护', () => {
  const f = bodyOf('remuxForIndex');
  assert.ok(f.includes('remuxing'), '应有 remuxing 标志');
  assert.ok(f.includes("t('remux.busy')"), '并发时应给出提示');
});

test('成功后把标记文件复制给新文件', () => {
  const f = bodyOf('remuxForIndex');
  assert.ok(f.includes('sidecarPathFor'), '应使用 sidecarPathFor');
  assert.ok(f.includes('copyFile'), '应复制 sidecar');
});

test('失败时清理半成品文件', () => {
  const f = bodyOf('remuxForIndex');
  assert.ok(/unlinkSync\(output\)/.test(f), '失败应删掉写了一半的输出');
});

test('菜单里有入口，且未打开视频时置灰', () => {
  assert.ok(MAIN.includes("t('menu.remuxIndex')"), '菜单项文案');
  assert.ok(/enabled:\s*!!currentVideoPath/.test(MAIN), '没有当前视频时应禁用');
  assert.ok(/remuxForIndex\(\)/.test(MAIN), '菜单点击应调用 remuxForIndex');
});

test('preload 暴露 remuxIndex 且通道对得上', () => {
  assert.ok(/remuxIndex:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\('remux-index'/.test(PRELOAD),
    'preload 应暴露 remuxIndex 调用 remux-index');
});

test('渲染进程处理转封装的四类事件', () => {
  for (const ev of ['remux-start', 'remux-progress', 'remux-done', 'remux-error']) {
    assert.ok(RENDERER.includes(`case '${ev}':`), `应处理 ${ev}`);
  }
});

test('转封装完成后会自动切到新文件', () => {
  const idx = RENDERER.indexOf('function remuxForIndex');
  assert.ok(idx > 0, '渲染进程应有 remuxForIndex()');
  const block = RENDERER.slice(idx, idx + 700);
  assert.ok(block.includes('loadVideo(r.output)'), '成功后应 loadVideo 新文件');
});

test('倒放退化时的提示带一键建立索引入口', () => {
  const idx = RENDERER.indexOf("case 'rev-coarse':");
  assert.ok(idx > 0);
  const block = RENDERER.slice(idx, idx + 900);
  assert.ok(block.includes("ui.buildIndex"), 'toast 应带「建立索引」按钮');
  assert.ok(block.includes('remuxForIndex()'), '按钮应触发转封装');
});
