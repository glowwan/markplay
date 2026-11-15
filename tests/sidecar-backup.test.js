'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BAK_MARK,
  backupPathFor,
  basename,
  formatStamp,
  isBackupOf,
  pickBackupsToDelete,
} = require('../src/sidecar-backup');

test('formatStamp：固定宽度，便于按字符串排序', () => {
  const d = new Date(2026, 0, 5, 9, 3, 7); // 2026-01-05 09:03:07
  assert.equal(formatStamp(d), '20260105-090307');
  const d2 = new Date(2026, 10, 15, 12, 2, 33);
  assert.equal(formatStamp(d2), '20261115-120233');
  assert.equal(formatStamp(d).length, 15, '宽度必须固定，否则排序会错');
});

test('backupPathFor：在 sidecar 后追加时间戳', () => {
  const p = backupPathFor('C:\\v\\a.mp4.markplay.json', new Date(2026, 10, 15, 12, 2, 33));
  assert.equal(p, 'C:\\v\\a.mp4.markplay.json.bak-20261115-120233');
  assert.ok(p.includes(BAK_MARK));
});

test('backupPathFor：不同秒产生不同文件名', () => {
  const a = backupPathFor('a.json', new Date(2026, 10, 15, 12, 2, 33));
  const b = backupPathFor('a.json', new Date(2026, 10, 15, 12, 2, 34));
  assert.notEqual(a, b);
});

test('isBackupOf：只认同一 sidecar 的备份，不误伤其它文件', () => {
  const sidecar = 'C:\\v\\a.mp4.markplay.json';
  assert.equal(isBackupOf('a.mp4.markplay.json.bak-20261115-120233', sidecar), true);
  assert.equal(isBackupOf('a.mp4.markplay.json', sidecar), false, '本体不算备份');
  assert.equal(isBackupOf('b.mp4.markplay.json.bak-20261115-120233', sidecar), false);
  assert.equal(isBackupOf('a.mp4', sidecar), false);
});

test('isBackupOf：前缀相同但视频名更长的不能误判', () => {
  const sidecar = 'C:\\v\\a.mp4.markplay.json';
  // a.mp4.markplay.json.bak- 是前缀；aa.mp4... 不应匹配
  assert.equal(isBackupOf('aa.mp4.markplay.json.bak-20261115-120233', sidecar), false);
});

test('basename：兼容两种分隔符', () => {
  assert.equal(basename('C:\\v\\a.mp4.markplay.json'), 'a.mp4.markplay.json');
  assert.equal(basename('/tmp/a.mp4.markplay.json'), 'a.mp4.markplay.json');
  assert.equal(basename('a.json'), 'a.json');
  assert.equal(basename(''), '');
});

test('pickBackupsToDelete：未超上限时什么都不删', () => {
  const names = ['x.bak-20260101-000001', 'x.bak-20260101-000002'];
  assert.deepEqual(pickBackupsToDelete(names, 5), []);
  assert.deepEqual(pickBackupsToDelete(names, 2), []);
});

test('pickBackupsToDelete：超出时删最旧的，保留最新 keep 个', () => {
  const names = [
    'x.bak-20260101-000003',
    'x.bak-20260101-000001',
    'x.bak-20260101-000004',
    'x.bak-20260101-000002',
  ];
  // 保留 2 个 → 删掉最旧的两个（000001、000002）
  assert.deepEqual(pickBackupsToDelete(names, 2), [
    'x.bak-20260101-000001',
    'x.bak-20260101-000002',
  ]);
});

test('pickBackupsToDelete：keep=0 时全删；异常输入走默认值', () => {
  const names = ['x.bak-20260101-000001', 'x.bak-20260101-000002'];
  assert.deepEqual(pickBackupsToDelete(names, 0), names);
  assert.deepEqual(pickBackupsToDelete([], 5), []);
  assert.deepEqual(pickBackupsToDelete(null, 5), []);
  // keep 非法 → 默认 10，两条都不删
  assert.deepEqual(pickBackupsToDelete(names, NaN), []);
});

test('pickBackupsToDelete：不修改传入数组', () => {
  const names = ['x.bak-20260101-000002', 'x.bak-20260101-000001'];
  const copy = names.slice();
  pickBackupsToDelete(names, 1);
  assert.deepEqual(names, copy);
});
