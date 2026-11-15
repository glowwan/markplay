'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const zh = require('../src/locales/zh-CN');
const en = require('../src/locales/en-US');
const { SUPPORTED, createTranslator, interpolate, lookup, normalize } = require('../src/i18n');

/** 把嵌套字典拍平成 'a.b.c' 路径集合 */
function flatten(obj, prefix, out) {
  const acc = out || [];
  const pre = prefix ? prefix + '.' : '';
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, pre + k, acc);
    } else {
      acc.push(pre + k);
    }
  }
  return acc;
}

test('中英字典的键完全一致', () => {
  const zhKeys = flatten(zh).sort();
  const enKeys = flatten(en).sort();

  const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
  const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));

  assert.deepEqual(missingInEn, [], 'en-US 缺少这些键：' + missingInEn.join(', '));
  assert.deepEqual(missingInZh, [], 'zh-CN 缺少这些键：' + missingInZh.join(', '));
});

test('字典里没有空字符串（空值通常是漏写）', () => {
  for (const [name, dict] of [['zh-CN', zh], ['en-US', en]]) {
    for (const key of flatten(dict)) {
      const v = lookup(dict, key);
      assert.equal(typeof v, 'string', `${name}.${key} 不是字符串`);
      assert.ok(v.length > 0, `${name}.${key} 是空字符串`);
    }
  }
});

test('同一 key 在两种语言里的占位符集合一致', () => {
  const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
  for (const key of flatten(zh)) {
    const a = placeholders(lookup(zh, key));
    const b = placeholders(lookup(en, key));
    assert.deepEqual(b, a, `${key} 的占位符不一致：zh=${a.join(',')} en=${b.join(',')}`);
  }
});

test('normalize：把各种语言标签归一到两种支持的语言', () => {
  assert.equal(normalize('zh-CN'), 'zh-CN');
  assert.equal(normalize('zh'), 'zh-CN');
  assert.equal(normalize('zh-Hans-CN'), 'zh-CN');
  assert.equal(normalize('zh-TW'), 'zh-CN');
  assert.equal(normalize('en-US'), 'en-US');
  assert.equal(normalize('en'), 'en-US');
  assert.equal(normalize('en-GB'), 'en-US');
  // 不支持的语言回退中文
  assert.equal(normalize('ja-JP'), 'zh-CN');
  assert.equal(normalize(''), 'zh-CN');
  assert.equal(normalize(null), 'zh-CN');
});

test('SUPPORTED 正好是两种语言', () => {
  assert.deepEqual(SUPPORTED.slice().sort(), ['en-US', 'zh-CN']);
});

test('lookup：点号路径取值，缺路径返回 undefined', () => {
  assert.equal(lookup(zh, 'menu.file'), '文件');
  assert.equal(lookup(zh, 'menu.not.exists'), undefined);
  assert.equal(lookup(zh, ''), undefined);
  assert.equal(lookup(null, 'a'), undefined);
});

test('interpolate：替换占位符，缺参数保留原样', () => {
  assert.equal(interpolate('a {x} b', { x: 1 }), 'a 1 b');
  assert.equal(interpolate('a {x} b', {}), 'a {x} b');
  assert.equal(interpolate('a {x} b'), 'a {x} b');
  assert.equal(interpolate('no placeholders', { x: 1 }), 'no placeholders');
  // 多个占位符
  assert.equal(interpolate('{a}-{b}', { a: 'x', b: 'y' }), 'x-y');
});

test('createTranslator：按语言取词并插值', () => {
  const tZh = createTranslator('zh-CN', zh, zh);
  const tEn = createTranslator('en-US', en, zh);
  assert.equal(tZh('menu.file'), '文件');
  assert.equal(tEn('menu.file'), 'File');
  assert.equal(tEn('status.opened', { name: 'a.mp4' }), 'Opened: a.mp4');
});

test('createTranslator：缺词时回退中文，再缺则返回 key', () => {
  const sparse = { menu: { file: 'File' } };
  const t = createTranslator('en-US', sparse, zh);
  // sparse 里没有 menu.help，回退到中文
  assert.equal(t('menu.help'), '帮助');
  // 两边都没有，返回 key 本身，不抛错
  assert.equal(t('nope.nothing'), 'nope.nothing');
});

test('createTranslator：非字符串值不当作文案返回', () => {
  const weird = { a: { b: { c: 123 } } };
  const t = createTranslator('zh-CN', weird, weird);
  assert.equal(t('a.b.c'), 'a.b.c');
});

test('关键 UI 文案在两种语言下都非空且互不相同', () => {
  const keys = ['ui.markers', 'ui.ranges', 'ui.clip', 'ui.export', 'menu.file', 'menu.help'];
  for (const k of keys) {
    const a = lookup(zh, k);
    const b = lookup(en, k);
    assert.ok(a && b, `${k} 缺失`);
    assert.notEqual(a, b, `${k} 中英文案相同，可能忘了翻译`);
  }
});
