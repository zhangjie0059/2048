'use strict';

const assert = require('assert');
const setupDomStub = require('./dom-stub');

// 保存原生 Math.random，供 playGame 基准测试使用
const nativeRandom = Math.random;

const ai = require('../ai.js');
const { queueRands, loadScript } = setupDomStub();

// 让真实游戏的动画计时器同步执行，加快模糊测试
global.setTimeout = (fn) => { fn(); return 0; };
global.clearTimeout = () => {};
loadScript('game.js');
const game = window.__game2048;

// 可复现的伪随机数生成器
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomBoard(rng) {
  const board = Array.from({ length: 4 }, () => Array(4).fill(0));
  const values = [2, 4, 8, 16, 32, 64, 128];
  const tiles = 4 + Math.floor(rng() * 9); // 4~12 个方块
  let placed = 0;
  let guard = 0;
  while (placed < tiles && guard++ < 500) {
    const r = Math.floor(rng() * 4);
    const c = Math.floor(rng() * 4);
    if (!board[r][c]) {
      board[r][c] = values[Math.floor(rng() * values.length)];
      placed++;
    }
  }
  return board;
}

// ---------- 一致性模糊测试：AI 模拟 == 真实游戏行为 ----------
let comparisons = 0;
for (let seed = 1; seed <= 50; seed++) {
  const rng = makeRng(seed);
  const board = randomBoard(rng);
  for (const dir of ai.DIR_NAMES) {
    const sim = ai.simulateMove(board, dir);
    game.setGrid(board);
    queueRands(0, 0.5); // 生成位置取第 1 个空格，值固定为 2
    game.move(dir);
    const real = game.getGrid();
    const realScore = game.getScore();

    if (sim.moved) {
      let spawnFound = false;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (real[r][c] !== 0 && sim.grid[r][c] === 0) {
            assert.ok(!spawnFound, '应恰好生成一个新方块');
            spawnFound = true;
            real[r][c] = 0;
          }
        }
      }
      assert.ok(spawnFound, '移动后应生成一个新方块');
    }

    assert.deepStrictEqual(real, sim.grid, `方向 ${dir} seed=${seed} 棋盘不一致`);
    assert.strictEqual(realScore, sim.gained, `方向 ${dir} seed=${seed} 得分不一致`);
    comparisons++;
  }
}
console.log(`一致性模糊测试通过：${comparisons} 组方向/棋盘对比 ✔`);

// ---------- bestMove 基本行为 ----------
assert.strictEqual(ai.bestMove([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), null, '空棋盘无合法移动');
const someBoard = [[2, 2, 4, 8], [0, 4, 2, 4], [8, 0, 8, 2], [2, 4, 0, 16]];
const dir = ai.bestMove(someBoard);
assert.ok(ai.DIR_NAMES.includes(dir), `应返回合法方向，实际 ${dir}`);
assert.ok(ai.simulateMove(someBoard, dir).moved, 'bestMove 返回的方向必须真实可移动');

// ---------- 整局强度基准 ----------
const GAMES = 6;
const results = [];
for (let i = 0; i < GAMES; i++) {
  Math.random = makeRng(1000 + i);
  // timeoutMs 传很大值，避免截止时间受机器负载影响，保证基准可复现
  const r = ai.playGame({ timeoutMs: 60000 });
  results.push(r);
  console.log(`基准 game ${i + 1}: max=${r.maxTile} score=${r.score} moves=${r.moves}`);
}
Math.random = nativeRandom;

const maxTiles = results.map((r) => r.maxTile);
const wins = maxTiles.filter((v) => v >= 2048).length;
const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
const avgMoves = Math.round(results.reduce((s, r) => s + r.moves, 0) / results.length);
const maxBest = Math.max(...maxTiles);

console.log(`基准：${GAMES} 局 → 最高方块分布 [${maxTiles.join(', ')}]`);
console.log(`基准：平均得分 ${avgScore}，平均步数 ${avgMoves}，最好成绩 ${maxBest}，达到 2048 的局数 ${wins}/${GAMES}`);

assert.ok(wins >= 4, `至少 4/6 局应达到 2048，实际 ${wins}/6`);
assert.ok(maxBest >= 4096, `最好成绩应达到 4096，实际 ${maxBest}`);

console.log('All 2048 AI tests passed ✔');
