#!/usr/bin/env node
/*
 * 网页版 2048 自动玩脚本（Playwright 驱动浏览器 + C++ 强 AI 决策）。
 *
 * 用法：
 *   node web-autoplay.js --url https://example.com/2048/ --budget 2097152
 *   node web-autoplay.js --url http://localhost:8123/ --budget 2097152 --headed
 *
 * 可选参数：
 *   --url URL           网页 2048 地址（必填）
 *   --budget N          C++ AI 单步搜索预算（越大越强越慢，冲 32768 建议 2097152）
 *   --engine cpp|js     决策引擎（默认 cpp，失败自动回退 js）
 *   --target-tile N     达到该方块即停止（默认 32768）
 *   --moves N           最多走 N 步（调试用）
 *   --once              只走一步
 *   --headed            显示浏览器窗口（默认无头）
 *   --autorestart       游戏结束后自动点“新游戏”重开（默认开启）
 *   --no-autorestart    关闭自动重开
 *   --delay MS          每步后等待动画的毫秒数（默认 160）
 *   --verbose           打印每步信息
 *
 * 棋盘读取兼容两种常见 DOM：
 *   1) Cirulli 系（.tile + tile-position-x-y class）
 *   2) transform 定位系（.tile + style.transform: translate(x,y)）
 * 找不到 DOM 棋盘时会明确报错，而不是瞎猜。
 */
'use strict';

const { chromium } = require('C:/Users/zhangjie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const ai = require('./ai.js');
const { bestMoveCpp } = require('./engine.js');

const KEYMAP = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf(k);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : d;
  };
  const has = (k) => a.includes(k);
  return {
    url: get('--url', null),
    budget: parseInt(get('--budget', '2097152'), 10),
    engine: get('--engine', 'cpp'),
    targetTile: parseInt(get('--target-tile', '32768'), 10),
    moves: has('--moves') ? parseInt(get('--moves', '0'), 10) : null,
    once: has('--once'),
    headed: has('--headed'),
    autorestart: !has('--no-autorestart'),
    delay: parseInt(get('--delay', '160'), 10),
    verbose: has('--verbose'),
  };
}

const opt = parseArgs();
if (!opt.url) {
  console.error('用法: node web-autoplay.js --url <网页2048地址> [--budget 2097152] [--headed]');
  process.exit(1);
}

function gridToValues(grid) {
  return grid;
}

async function readBoard(page) {
  // 优先使用游戏自身的调试钩子（本仓库的 2048 提供 __game2048.getGrid()，
  // 100% 精确，不受动画影响）；其他网页回退到 DOM 读取。
  const hooked = await page.evaluate(() => {
    if (window.__game2048 && typeof window.__game2048.getGrid === 'function') {
      const g = window.__game2048.getGrid();
      if (Array.isArray(g) && g.length === 4 && Array.isArray(g[0]) && g[0].length === 4) {
        return g;
      }
    }
    return null;
  });
  if (hooked) return hooked;
  return page.evaluate(() => {
    const grid = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const all = Array.from(document.querySelectorAll('.tile'));
    if (!all.length) return null;
    let placed = 0;
    for (const el of all) {
      if (el.classList.contains('tile-container')) continue;
      const inner = el.querySelector('.tile-inner');
      const textEl = inner || el;
      const value = parseInt(textEl.textContent.trim().replace(/[,_]/g, ''), 10);
      if (!Number.isFinite(value) || value <= 0) continue;
      let row = null;
      let col = null;
      const pm = el.className.match(/tile-position-(\d+)-(\d+)/);
      if (pm) {
        col = parseInt(pm[1], 10) - 1;
        row = parseInt(pm[2], 10) - 1;
      } else {
        const tr = el.style.transform.match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/);
        if (tr) {
          if (!window.__tileStep) {
            const xs = [];
            const ys = [];
            for (const e2 of all) {
              const t2 = e2.style.transform.match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/);
              if (t2) {
                xs.push(parseFloat(t2[1]));
                ys.push(parseFloat(t2[2]));
              }
            }
            const stepFrom = (arr) => {
              const sorted = [...new Set(arr.map((v) => Math.round(v * 10) / 10))].sort((p, q) => p - q);
              let min = null;
              for (let i = 1; i < sorted.length; i++) {
                const d = sorted[i] - sorted[i - 1];
                if (d > 1 && (min === null || d < min)) min = d;
              }
              return min;
            };
            window.__tileStep = stepFrom(xs) || stepFrom(ys);
          }
          const step = window.__tileStep;
          if (step) {
            col = Math.round(parseFloat(tr[1]) / step);
            row = Math.round(parseFloat(tr[2]) / step);
          }
        }
      }
      if (row === null || col === null || row < 0 || row > 3 || col < 0 || col > 3) continue;
      if (value > grid[row][col]) grid[row][col] = value;
      placed++;
    }
    if (!placed) return null;
    return grid;
  });
}

/**
 * 等待棋盘进入稳定状态：先等一小段动画时间，再连续读到两次完全一致的
 * 棋盘才返回（动画中间态会变化，稳定态不变）。也顺带解决了部分游戏
 * “动画期间忽略按键”导致的丢键问题（丢键时棋盘不变，由调用方重发）。
 */
async function readBoardStable(page, minWaitMs = 180) {
  await page.waitForTimeout(minWaitMs);
  let prev = null;
  let stable = 0;
  for (let i = 0; i < 12; i++) {
    const cur = await readBoard(page);
    if (cur && prev && JSON.stringify(cur) === JSON.stringify(prev)) {
      stable++;
      if (stable >= 2) return cur;
    } else {
      stable = 0;
    }
    prev = cur;
    await page.waitForTimeout(70);
  }
  return prev;
}

async function readScore(page) {
  return page.evaluate(() => {
    const sels = ['#score', '.score-container', '.score', '.scores .value', '[data-score]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        const v = parseInt(el.textContent.trim().replace(/[,_\s]/g, ''), 10);
        if (Number.isFinite(v)) return v;
      }
    }
    return null;
  });
}

function maxTile(grid) {
  let m = 0;
  for (const row of grid) for (const v of row) if (v > m) m = v;
  return m;
}

function diffExpected(prev, dir, cur) {
  const sim = ai.simulateMove(prev, dir);
  if (!sim.moved) return { ok: false, sim: null, reason: 'no-move' };
  let diffs = 0;
  let ok = true;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const s = sim.grid[r][c];
      const v = cur[r][c];
      if (s !== 0) {
        if (v !== s) {
          ok = false;
          break;
        }
      } else if (v !== 0) {
        diffs++;
      }
    }
    if (!ok) break;
  }
  // 恰好一个空格被新方块填上，其余一致
  return { ok: ok && diffs === 1, sim: sim.grid, reason: ok && diffs === 1 ? 'ok' : `diffs=${diffs}` };
}

async function waitBoard(page, tries = 30, waitMs = 300) {
  for (let i = 0; i < tries; i++) {
    const g = await readBoard(page);
    if (g && maxTile(g) > 0) return g;
    await page.waitForTimeout(waitMs);
  }
  return null;
}

async function restartGame(page) {
  const selectors = [
    '#restart',
    'button.restart-button',
    '.restart-button',
    '#overlay-btn',
    'button:has-text("新游戏")',
    'button:has-text("再来一局")',
    'button:has-text("New Game")',
    'button:has-text("Play Again")',
    'button:has-text("重玩")',
    'a:has-text("New Game")',
    '.retry-button',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 2000 });
        return true;
      }
    } catch (e) {
      /* 继续尝试下一个 */
    }
  }
  try {
    await page.keyboard.press('KeyR');
  } catch (e) {
    /* 部分游戏支持 R 重开 */
  }
  return false;
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: !opt.headed });
  const context = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  console.log(`打开 ${opt.url} ...`);
  await page.goto(opt.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let board = await waitBoard(page);
  if (board) board = await readBoardStable(page, 300);
  if (!board) {
    console.error('未在页面中找到 2048 棋盘（.tile 元素）。请确认 URL 是网页版 2048 游戏。');
    await browser.close();
    process.exit(1);
  }
  console.log('棋盘读取成功，开始自动玩。');

  let prevGrid = null;
  let lastDir = null;
  let moves = 0;
  let games = 0;
  let bestOverall = 0;
  let gameMax = 0;
  let bad = 0;
  let score = 0;
  let stuck = 0;

  while (true) {
    board = await readBoardStable(page, 180);
    if (!board) {
      console.log(`棋盘读取失败（可能有弹窗/加载页），已停止。共 ${moves} 步。`);
      break;
    }
    const mx = maxTile(board);
    gameMax = Math.max(gameMax, mx);
    bestOverall = Math.max(bestOverall, mx);
    const sc = await readScore(page);
    if (sc !== null) score = sc;

    if (opt.once) {
      console.log(`已读取棋盘，最大方块 ${mx}。`);
      if (prevGrid) {
        console.log(`上一步 ${lastDir} 后未继续。`);
      }
      break;
    }
    if (opt.moves !== null && moves >= opt.moves) {
      console.log(`达到步数上限: ${moves} 步, 最大方块 ${gameMax}, 分数 ${score}, 告警 ${bad}`);
      break;
    }
    if (ai.legalMoves(board).length === 0) {
      console.log(`游戏结束: 共 ${moves} 步, 本局最大方块 ${gameMax}, 最高方块 ${bestOverall}, 分数 ${score}, 告警 ${bad}`);
      if (!opt.autorestart) break;
      const r = await restartGame(page);
      if (opt.verbose) console.log(`尝试重开: ${r ? '已点击' : '已按 R/刷新'}`);
      await page.waitForTimeout(800);
      board = await waitBoard(page);
      if (!board) {
        console.log('重开后棋盘不可读，停止。');
        break;
      }
      games++;
      gameMax = 0;
      prevGrid = null;
      lastDir = null;
      continue;
    }

    let dir = null;
    if (opt.engine === 'cpp') {
      dir = bestMoveCpp(gridToValues(board), opt.budget);
      if (!dir && opt.verbose) console.log('2048ai.exe 不可用，回退 JS AI');
    }
    if (!dir) dir = ai.bestMove(board, { timeoutMs: 250 });
    if (!dir) {
      console.log(`无可用方向，已停止。共 ${moves} 步。`);
      break;
    }

    prevGrid = board.map((row) => row.slice());
    lastDir = dir;

    // 发送按键；若棋盘未变化（动画期间按键被游戏忽略），重发同方向。
    // 多次重发仍无变化时交给外层循环重新读取并重新决策（自愈），而不是死磕同一方向。
    let applied = false;
    for (let attempt = 0; attempt < 3 && !applied; attempt++) {
      await page.keyboard.press(KEYMAP[dir]);
      const after = await readBoardStable(page, Math.max(opt.delay, 180));
      if (!after) {
        bad++;
        break;
      }
      if (JSON.stringify(after) === JSON.stringify(prevGrid)) continue; // 被吞/无效，重发
      const check = diffExpected(prevGrid, dir, after);
      if (check.ok) {
        applied = true;
        board = after;
      } else {
        // 稳定读取仍不一致：记为告警，但以实际棋盘为准继续
        bad++;
        if (opt.verbose) {
          console.log(`一致性告警 step ${moves} (dir=${dir})`);
          const sim = ai.simulateMove(prevGrid, dir);
          console.log(`  prev=${JSON.stringify(prevGrid)}`);
          console.log(`  sim =${JSON.stringify(sim.grid)}`);
          console.log(`  cur =${JSON.stringify(after)}`);
          const raw = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.tile')).map((el) => ({
              cls: el.className.replace('tile', '').trim(),
              txt: el.textContent.trim(),
              tr: el.style.transform,
            }))
          );
          console.log('  rawTiles=' + JSON.stringify(raw));
        }
        applied = true;
        board = after;
      }
    }
    if (!applied) {
      stuck++;
      if (opt.verbose) console.log(`棋盘未响应方向 ${dir}，重新读取并重新决策（${stuck}）`);
      if (stuck >= 8) {
        console.log('棋盘连续无响应，疑似读取异常或游戏卡死，已停止。');
        break;
      }
      continue; // 重新读棋盘、重新算方向
    }
    stuck = 0;
    moves++;

    if (opt.verbose) {
      console.log(`step ${moves}: dir=${dir} max=${maxTile(board)} score=${sc ?? '-'}`);
    }
    if (maxTile(board) >= opt.targetTile) {
      console.log(`!!!! 达成目标: 出现 ${maxTile(board)} 方块！共 ${moves} 步, 分数 ${score}`);
      break;
    }
  }

  console.log(`汇总: ${games} 局(不含当前), 总步数 ${moves}, 历史最高方块 ${bestOverall}, 告警 ${bad}`);
  await browser.close();
}

main().catch((e) => {
  console.error('运行出错:', e.message);
  process.exit(1);
});
