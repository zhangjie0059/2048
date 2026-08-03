#!/usr/bin/env node
/*
 * 共享的 2048 AI 引擎封装。
 *
 * bestMoveCpp(values, budget) 调用 2048ai.exe（C++ Expectimax 强 AI）：
 *   输入 4x4 棋盘数字数组，输出 'up' | 'down' | 'left' | 'right'。
 * 该引擎与载体无关：App 版（雷电模拟器）与网页版共用同一个决策核心。
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = process.env.AI_EXE || path.join(__dirname, '2048ai.exe');
const DIRS = ['up', 'down', 'left', 'right'];

/**
 * 调用 C++ 引擎计算最佳方向。
 * @param {number[][]} values 4x4 棋盘（0 表示空格）
 * @param {number} budget 单步搜索节点预算；0 = 无限（不推荐），越大越强越慢
 * @returns {string|null} 方向名，引擎不可用时返回 null
 */
function bestMoveCpp(values, budget) {
  if (!fs.existsSync(EXE)) return null;
  const input = values.flat().join(' ') + '\n';
  const args = ['move'];
  if (budget > 0) args.push('--budget', String(budget));
  let out;
  try {
    out = execFileSync(EXE, args, {
      input,
      encoding: 'utf8',
      timeout: 120000, // 210 万预算单步可能到 1 秒以上，放宽超时
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    return null;
  }
  const code = parseInt(out.trim(), 10);
  if (!Number.isFinite(code) || code < 0 || code > 3) return null;
  return DIRS[code];
}

module.exports = { bestMoveCpp };
