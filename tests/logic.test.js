'use strict';

const assert = require('assert');
const setupDomStub = require('./dom-stub');

const { ids, queueRands, loadScript } = setupDomStub();
// 让动画计时器同步执行，加快测试
global.setTimeout = (fn) => { fn(); return 0; };
global.clearTimeout = () => {};
loadScript('game.js');

const game = window.__game2048;
const overlay = ids['overlay'];
const tilesEl = ids['tiles'];

function countTiles(g) { return g.flat().filter(Boolean).length; }

function checkDomMatchesGrid() {
  const grid = game.getGrid();
  const n = countTiles(grid);
  const domCount = tilesEl.children.filter((el) => !el._removed).length;
  assert.strictEqual(domCount, n, `DOM tile count ${domCount} should equal grid tiles ${n}`);
}

// A: 2 2 2 2 left -> 4 4 (score 8)
game.setGrid([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
queueRands(0, 0);
game.move('left');
assert.deepStrictEqual(game.getGrid(), [[4, 4, 2, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
assert.strictEqual(game.getScore(), 8);
checkDomMatchesGrid();

// B: 2 2 2 4 left -> 4 2 4 0 (regression: merge then re-slide)
game.setGrid([[2, 2, 2, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
queueRands(0, 0);
game.move('left');
assert.deepStrictEqual(game.getGrid(), [[4, 2, 4, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
assert.strictEqual(game.getScore(), 4);
checkDomMatchesGrid();

// C: 4 4 8 8 left -> 8 16 (score 24)
game.setGrid([[4, 4, 8, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
queueRands(0, 0);
game.move('left');
assert.deepStrictEqual(game.getGrid(), [[8, 16, 2, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
assert.strictEqual(game.getScore(), 24);
checkDomMatchesGrid();

// D: vertical 2 2 4 4 up -> 4 8 (score 12)
game.setGrid([[2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]]);
queueRands(0, 0);
game.move('up');
assert.deepStrictEqual(game.getGrid(), [[4, 2, 0, 0], [8, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
assert.strictEqual(game.getScore(), 12);
checkDomMatchesGrid();

// E: 2 2 4 0 right -> 0 0 4 4 (score 4)
game.setGrid([[2, 2, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
queueRands(0, 0);
game.move('right');
assert.deepStrictEqual(game.getGrid(), [[2, 0, 4, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
assert.strictEqual(game.getScore(), 4);
checkDomMatchesGrid();

// F: game-over overlay on a dead board, restart via button
game.setGrid([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
game.move('left');
assert.strictEqual(game.getScore(), 0);
assert.ok(!overlay.classList.contains('hidden'), 'overlay should be visible on game over');
assert.strictEqual(ids['overlay-title'].textContent, '游戏结束');
ids['overlay-btn'].onclick(); // 再来一局
assert.ok(overlay.classList.contains('hidden'));
assert.strictEqual(countTiles(game.getGrid()), 2);

// G: winning shows overlay, continue keeps playing, best score persists
game.setGrid([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
queueRands(0, 0);
game.move('left');
assert.ok(!overlay.classList.contains('hidden'));
assert.strictEqual(ids['overlay-title'].textContent, '你赢了！');
assert.strictEqual(game.getScore(), 2048);
assert.strictEqual(localStorage.getItem('best-2048'), '2048');
ids['overlay-btn'].onclick(); // 继续游戏
assert.ok(overlay.classList.contains('hidden'));
queueRands(0, 0);
game.move('right');
assert.ok(overlay.classList.contains('hidden'), 'game continues after dismissing win overlay');
checkDomMatchesGrid();

// H: 4倍模式——初始方块恒为 4，合成 8192 获胜，最高分按倍数分开保存
game.setMultiplier(4);
let initTiles = game.getGrid().flat().filter(Boolean);
assert.ok(initTiles.every((v) => v === 4), '4倍模式初始方块应恒为 4');
game.setGrid([[4096, 4096, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
queueRands(0, 0);
game.move('left');
assert.ok(!overlay.classList.contains('hidden'));
assert.strictEqual(ids['overlay-title'].textContent, '你赢了！');
assert.ok(ids['overlay-text'].textContent.includes('8192'), '4倍模式胜利目标应为 8192');
assert.strictEqual(game.getScore(), 8192);
assert.strictEqual(localStorage.getItem('best-2048-4'), '8192');
const winEl = tilesEl.children.find((el) => String(el.textContent) === '8192');
assert.ok(winEl && winEl.className.includes('tile-super'), '8192 应使用超高方块样式');
ids['overlay-btn'].onclick();
assert.ok(overlay.classList.contains('hidden'));

// I: 16倍模式——初始方块恒为 16
game.setMultiplier(16);
initTiles = game.getGrid().flat().filter(Boolean);
assert.ok(initTiles.every((v) => v === 16), '16倍模式初始方块应恒为 16');
assert.strictEqual(String(ids['target'].textContent), '32768');

// 恢复 1 倍模式
game.setMultiplier(1);
initTiles = game.getGrid().flat().filter(Boolean);
assert.ok(initTiles.every((v) => v === 2 || v === 4), '恢复 1 倍后初始方块应为 2 或 4');

console.log('All 2048 logic tests passed ✔');
