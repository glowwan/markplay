'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Logger } = require('../src/logger');

function tempLogger(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markplay-log-'));
  return { logger: new Logger(path.join(dir, 'logs'), opts), dir };
}

test('写入日志：带级别与 ISO 时间戳，Error 记录堆栈', () => {
  const { logger } = tempLogger();
  logger.info('hello', { a: 1 });
  logger.error('boom', new Error('bad'));

  const text = fs.readFileSync(logger.getPath(), 'utf8');
  assert.match(text, /\[INFO\] hello \{"a":1\}/);
  assert.match(text, /\[ERROR\] boom Error: bad/);
  assert.match(text, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('超过上限自动轮转为 .1，并保留历史文件', () => {
  const { logger } = tempLogger({ maxBytes: 200, maxFiles: 3 });
  for (let i = 0; i < 40; i++) {
    logger.info('line', i, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  }
  assert.ok(fs.existsSync(logger.getPath()), '当前日志应存在');
  assert.ok(fs.existsSync(`${logger.getPath()}.1`), '应产生 .1 轮转文件');
});

test('写入失败时不抛错（只丢日志）', () => {
  const { logger } = tempLogger();
  logger.file = path.join('Z:', '\\no-such-dir', 'markplay.log');
  assert.doesNotThrow(() => logger.info('should not throw'));
});
