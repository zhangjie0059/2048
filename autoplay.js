#!/usr/bin/env node
/*
 * 2048 自动玩统一入口（C++ 强 AI 引擎，支持 App 版与网页版）。
 *
 * 用法：
 *   node autoplay.js --target app            # 雷电模拟器 App 版
 *   node autoplay.js --target web --url <URL> # 网页版
 *
 * 其余参数原样透传给对应脚本，例如：
 *   node autoplay.js --target web --url http://localhost:8123/ --budget 2097152 --headed
 *   node autoplay.js --target app --cpp --budget 2097152 --restart-tap 450,1400
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const ti = args.indexOf('--target');
const target = ti >= 0 ? (args[ti + 1] || '').toLowerCase() : (process.env.TARGET || '');
if (!target || (target !== 'app' && target !== 'web')) {
  console.error('请指定 --target app（雷电模拟器 App 版）或 --target web（网页版）。');
  process.exit(1);
}

const passthrough = args.filter((_, i) => i !== ti && i !== ti + 1);
const script = target === 'web' ? 'web-autoplay.js' : 'emulator-autoplay.js';
const node = process.execPath;

console.log(`启动 ${target} 模式: ${node} ${script} ${passthrough.join(' ')}`);
const child = spawn(node, [path.join(__dirname, script), ...passthrough], {
  stdio: 'inherit',
  cwd: __dirname,
});
child.on('exit', (code) => process.exit(code == null ? 1 : code));
