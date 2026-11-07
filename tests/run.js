'use strict';

/**
 * 测试入口：顺序 require 各测试文件。
 *
 * 为什么要这个文件：Windows 沙箱环境下 `node --test <目录>` 会为每个文件
 * 启动子进程（stdio 管道），在受限环境里可能直接 EPERM；
 * 普通进程里 require 'node:test' 同样会执行并输出结果，且不需要 spawn。
 *
 * 用法：npm test
 */

require('./settings.test.js');
require('./logger.test.js');
require('./timeline-view.test.js');
require('./export.test.js');
require('./markers.test.js');
