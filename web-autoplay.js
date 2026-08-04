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
 *   --set-grid "16个数"  从指定棋盘接着玩（4x4，从上到下、从左到右，本仓库游戏专用）
 *   --moves N           最多走 N 步（调试用）
 *   --once              只走一步
 *   --headed            显示浏览器窗口（web-run.bat 默认已加；直接跑脚本时默认无头）
 *   --headless          强制无头（优先级高于 --headed）
 *   --autorestart       游戏结束后自动点“新游戏”重开（默认关闭；不加则结束后停止）
 *   --delay MS          每步后等待动画的毫秒数（默认 160）
 *   --verbose           打印每步信息
 *
 * 棋盘读取兼容两种常见 DOM：
 *   1) Cirulli 系（.tile + tile-position-x-y class）
 *   2) transform 定位系（.tile + style.transform: translate(x,y)）
 * 找不到 DOM 棋盘时会明确报错，而不是瞎猜。
 */
'use strict';

const fs = require('fs');
const path = require('path');
let chromium;
try {
  ({ chromium } = require('C:/Users/zhangjie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
} catch (e) {
  try {
    ({ chromium } = require('playwright'));
  } catch (e2) {
    console.error('未找到 Playwright 浏览器自动化库。请安装：npm install playwright');
    process.exit(1);
  }
}
const ai = require('./ai.js');
const { bestMoveCpp } = require('./engine.js');

const KEYMAP = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.lastIndexOf(k);
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
    setGrid: get('--set-grid', null),
    headed: has('--headed') && !has('--headless'),
    autorestart: has('--autorestart'),
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
  // 使用固定配置目录，localStorage（游戏进度/最高分）在重启后仍保留；
  // 配置目录被占用（另一个实例在跑）时退回临时配置
  const PROFILE = path.join(__dirname, '.chrome-profile');
  let context;
  let closed = false;
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chrome',
      headless: !opt.headed,
      viewport: { width: 900, height: 1600 },
    });
  } catch (e) {
    const browser = await chromium.launch({ channel: 'chrome', headless: !opt.headed });
    context = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  }
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('close', () => {
    closed = true;
  });
  context.on('close', () => {
    closed = true;
  });

  console.log(`打开 ${opt.url} ...`);
  await page.goto(opt.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let board = await waitBoard(page);
  if (board) board = await readBoardStable(page, 300);
  if (!board) {
    console.error('未在页面中找到 2048 棋盘（.tile 元素）。请确认 URL 是网页版 2048 游戏。');
    await context.close();
    process.exit(1);
  }
  if (opt.setGrid) {
    const nums = opt.setGrid
      .split(/[\s,，]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    if (nums.length !== 16) {
      console.error('--set-grid 需要恰好 16 个数字（4x4，从上到下、从左到右，0 表示空格）。');
      await context.close();
      process.exit(1);
    }
    const injected = await page.evaluate((g) => {
      if (window.__game2048 && typeof window.__game2048.setGrid === 'function') {
        window.__game2048.setGrid(g);
        return true;
      }
      return false;
    }, [nums.slice(0, 4), nums.slice(4, 8), nums.slice(8, 12), nums.slice(12, 16)]);
    if (!injected) {
      console.error('该页面没有 __game2048.setGrid 钩子，无法从指定棋盘继续。');
      await context.close();
      process.exit(1);
    }
    await page.waitForTimeout(300);
    board = await readBoardStable(page, 300);
    console.log(`已载入指定棋盘（最大方块 ${maxTile(board)}），继续自动玩。`);
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
      if (!opt.autorestart) {
        // 保持窗口并监视棋盘：用户用「消除最小」救活后自动继续
        console.log('等待你使用「消除最小」救活（或关闭窗口退出）...');
        let rescued = false;
        while (!closed) {
          let cur = null;
          try {
            cur = await readBoardStable(page, 250);
          } catch (e) {
            break; // 页面/浏览器已被关闭
          }
          if (cur && ai.legalMoves(cur).length > 0) {
            board = cur;
            rescued = true;
            break;
          }
          await page.waitForTimeout(1000);
        }
        if (rescued) {
          console.log('检测到救活，继续自动玩！');
          prevGrid = null;
          lastDir = null;
          continue;
        }
        break;
      }
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

  console.log('================ 最终结果 ================');
  console.log(`最大方块: ${bestOverall}`);
  console.log(`总分: ${score}`);
  console.log(`总步数: ${moves}`);
  console.log(`自动重开: ${games} 局（本局不计）`);
  console.log(`一致性告警: ${bad}`);
  console.log('==========================================');
  if (opt.headed) {
    // 保持窗口打开，让用户能看到最终棋盘/分数；按 Ctrl+C 或关闭窗口后脚本退出。
    console.log('游戏已结束，浏览器窗口保持打开供查看结果。按 Ctrl+C 或直接关闭窗口退出。');
    await new Promise((resolve) => {
      if (closed) return resolve();
      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          resolve();
        }
      }, 1000);
      context.once('close', () => {
        clearInterval(timer);
        resolve();
      });
      page.once('close', () => {
        clearInterval(timer);
        resolve();
      });
    });
  } else {
    await context.close();
  }
}

main().catch((e) => {
  console.error('运行出错:', e.message);
  process.exit(1);
});
