'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore, MAX_RECENT } = require('../src/settings');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markplay-settings-'));
  return { store: new SettingsStore(path.join(dir, 'settings.json')), dir };
}

test('文件不存在时返回默认值', () => {
  const { store } = tempStore();
  const data = store.load();
  assert.equal(data.volume, 100);
  assert.deepEqual(data.recentFiles, []);
  assert.equal(data.lastDir, '');
});

test('写入音量后重新加载仍生效，并夹在 0–100', () => {
  const { store, dir } = tempStore();
  store.load();
  assert.equal(store.set('volume', 42), true);
  assert.equal(store.set('volume', 999), true);

  const again = new SettingsStore(path.join(dir, 'settings.json')).load();
  assert.equal(again.volume, 100);

  store.set('volume', -5);
  assert.equal(store.get('volume'), 0);
});

test('未知键被拒绝，避免被写入垃圾字段', () => {
  const { store } = tempStore();
  store.load();
  assert.equal(store.set('evil', 'x'), false);
  assert.equal(store.get('evil'), undefined);
});

test('最近文件：去重置顶、限制数量、更新 lastDir', () => {
  const { store } = tempStore();
  store.load();
  for (let i = 0; i < MAX_RECENT + 3; i++) {
    store.addRecent(`C:\\v\\f${i}.mp4`);
  }
  const list = store.get('recentFiles');
  assert.equal(list.length, MAX_RECENT);
  assert.equal(list[0], `C:\\v\\f${MAX_RECENT + 2}.mp4`);

  // 重复打开已有的文件：顶到最前，不产生重复项
  store.addRecent('C:\\v\\f5.mp4');
  const again = store.get('recentFiles');
  assert.equal(again[0], 'C:\\v\\f5.mp4');
  assert.equal(new Set(again).size, again.length);
  assert.equal(store.get('lastDir'), 'C:\\v');
});

test('窗口几何：尺寸过小的记录直接丢弃', () => {
  const { store } = tempStore();
  store.load();
  store.set('window', { x: 10, y: 10, width: 100, height: 100 });
  assert.equal(store.get('window'), null);

  store.set('window', { x: 10, y: 20, width: 1280, height: 800, maximized: true });
  assert.deepEqual(store.get('window'), {
    x: 10, y: 20, width: 1280, height: 800, maximized: true,
  });
});

test('损坏的 JSON 不抛错，回退默认值', () => {
  const { store, dir } = tempStore();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json', 'utf8');
  const data = store.load();
  assert.equal(data.volume, 100);
});

test('clearRecent 清空列表', () => {
  const { store } = tempStore();
  store.load();
  store.addRecent('C:\\v\\a.mp4');
  assert.deepEqual(store.clearRecent(), []);
  assert.deepEqual(store.get('recentFiles'), []);
});
