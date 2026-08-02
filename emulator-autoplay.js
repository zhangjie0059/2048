#!/usr/bin/env node
/*
 * 雷电模拟器（LDPlayer）2048 App 自动游玩脚本
 *
 * 原理：通过 ldconsole/adb 截取模拟器屏幕 -> 按颜色识别 4x4 棋盘 ->
 *       复用 ai.js 计算最佳方向 -> adb input swipe 模拟滑动。
 *
 * 用法：
 *   node emulator-autoplay.js --calibrate    # 校准：识别棋盘并输出 16 格颜色
 *   node emulator-autoplay.js --once         # 只走一步
 *   node emulator-autoplay.js --moves 50     # 自动玩 50 步
 *   node emulator-autoplay.js --depth 5      # 指定 AI 搜索深度（默认自适应 3~4）
 *   node emulator-autoplay.js --cpp          # 使用 C++ 强 AI（2048ai.exe，未编译时自动回退 JS）
 *   node emulator-autoplay.js --cpp --budget 500000
 *                                           # 指定 C++ AI 每步节点预算（越大越强，默认 400000）
 *   node emulator-autoplay.js                # 自动玩到游戏结束
 *
 * 可选环境变量：
 *   LDCONSOLE   ldconsole.exe 路径（默认 E:/leidian/LDPlayer9/ldconsole.exe）
 *   LD_INDEX    模拟器实例索引（默认 0）
 *   DELAY       每步之间的等待毫秒数（默认 250）
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let pngModule;
try {
  pngModule = require('pngjs');
} catch (e) {
  pngModule = require(
    'C:/Users/zhangjie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pngjs'
  );
}
const PNG = pngModule.PNG || pngModule;

const ai = require('./ai.js');
const EXE = process.env.AI_EXE || path.join(__dirname, '2048ai.exe');

const LDCONSOLE = process.env.LDCONSOLE || 'E:/leidian/LDPlayer9/ldconsole.exe';
const INDEX = process.env.LD_INDEX || '0';
const DELAY = parseInt(process.env.DELAY, 10) || 350;

function bestMoveCpp(values, budget) {
  if (!fs.existsSync(EXE)) return null;
  const input = values.flat().join(' ') + '\n';
  const args = ['move'];
  if (budget > 0) args.push('--budget', String(budget));
  const out = execFileSync(EXE, args, {
    input,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const code = parseInt(out.trim(), 10);
  if (!Number.isFinite(code) || code < 0 || code > 3) return null;
  return ['up', 'down', 'left', 'right'][code];
}

// 标准 2048 方块色板（该 App 的 4 号方块实测为 rgb(236,220,190)，与标准色非常接近）
const PALETTE = [
  { v: 2, rgb: [238, 228, 218] },
  { v: 4, rgb: [237, 224, 200] },
  { v: 8, rgb: [242, 177, 121] },
  { v: 16, rgb: [245, 149, 99] },
  { v: 32, rgb: [246, 124, 95] },
  { v: 64, rgb: [246, 94, 59] },
  { v: 128, rgb: [237, 207, 114] },
  { v: 256, rgb: [237, 204, 97] },
  { v: 512, rgb: [237, 200, 80] },
  { v: 1024, rgb: [237, 197, 63] },
  { v: 2048, rgb: [237, 194, 46] },
];
// 运行期自动学习到的颜色（以游戏物理模拟结果为真值）
const PALETTE_EXTRA = [];

// 实测棋盘底色
const BOARD_BG = [200, 188, 175];
const BG_TOL = 24;
// 该 App 在当前分辨率下的实测棋盘位置（动态检测失败时的兜底）
const KNOWN_BOARD = { x: 52, y: 552, w: 798, h: 828 };

function adbCmd(cmd, binary = false) {
  const args = ['adb', '--index', INDEX, '--command', cmd];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return execFileSync(LDCONSOLE, args, {
        encoding: binary ? null : 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      lastErr = e;
      // 模拟器 adb 偶发 "device not found"，稍等重试
      const start = Date.now();
      while (Date.now() - start < 500) { /* busy wait */ }
    }
  }
  throw lastErr;
}

function capture() {
  const buf = adbCmd('exec-out screencap -p', true);
  return { png: PNG.sync.read(buf), buf };
}

function sleepSync(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) { /* busy wait */ }
}

/**
 * 自动定位棋盘：找出大片接近棋盘底色 (200,188,175) 的矩形区域。
 */
function findBoard(png) {
  try {
    const W = png.width;
    const H = png.height;
    const step = 2;
    const rowFrac = new Array(H).fill(0);
    const colFrac = new Array(W).fill(0);
    const maxR = W / step;
    const maxC = H / step;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const i = (W * y + x) * 4;
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        const dBg =
          Math.abs(r - BOARD_BG[0]) + Math.abs(g - BOARD_BG[1]) + Math.abs(b - BOARD_BG[2]);
        const dFrame = Math.abs(r - 184) + Math.abs(g - 168) + Math.abs(b - 168);
        if (dBg < BG_TOL * 3 || dFrame < 70) {
          rowFrac[y]++;
          colFrac[x]++;
        }
      }
    }
    for (let y = 0; y < H; y++) rowFrac[y] /= maxR;
    for (let x = 0; x < W; x++) colFrac[x] /= maxC;
    const longestRun = (arr, frac) => {
      let bestS = -1, bestE = -1, best = 0, s = -1;
      for (let i = 0; i <= arr.length; i++) {
        const ok = i < arr.length && arr[i] > frac;
        if (ok && s === -1) s = i;
        if (!ok && s !== -1) {
          if (i - s > best) {
            best = i - s;
            bestS = s;
            bestE = i;
          }
          s = -1;
        }
      }
      return [bestS, bestE];
    };
    const [y0, y1] = longestRun(rowFrac, 0.35);
    const [x0, x1] = longestRun(colFrac, 0.25);
    if (y0 !== -1 && x0 !== -1) {
      const b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (b.w > 400 && b.h > 400 && b.w / b.h > 0.7 && b.w / b.h < 1.4) {
        return b;
      }
    }
  } catch (e) {
    /* 回退到已知位置 */
  }
  return { ...KNOWN_BOARD };
}

function matchValue(r, g, b) {
  const bgD = Math.abs(r - BOARD_BG[0]) + Math.abs(g - BOARD_BG[1]) + Math.abs(b - BOARD_BG[2]);
  if (bgD < 60) return 0;
  let best = null;
  let bestD = 40; // 与色板距离超过 40 视为“未知”，宁可重试也不误判
  for (const p of PALETTE) {
    const d = Math.hypot(r - p.rgb[0], g - p.rgb[1], b - p.rgb[2]);
    if (d < bestD) {
      bestD = d;
      best = p.v;
    }
  }
  for (const p of PALETTE_EXTRA) {
    const d = Math.hypot(r - p.rgb[0], g - p.rgb[1], b - p.rgb[2]);
    if (d < bestD) {
      bestD = d;
      best = p.v;
    }
  }
  return best || -1; // -1 表示未知颜色
}

/**
 * 学习一个颜色 -> 数值的映射（仅当该值在色板/已学颜色中都不存在时）。
 */
function learnColor(value, rgb) {
  if (!value || !rgb || rgb[0] + rgb[1] + rgb[2] < 200) return;
  const all = PALETTE.concat(PALETTE_EXTRA);
  for (const p of all) {
    if (Math.hypot(rgb[0] - p.rgb[0], rgb[1] - p.rgb[1], rgb[2] - p.rgb[2]) < 25) return;
  }
  PALETTE_EXTRA.push({ v: value, rgb: [rgb[0], rgb[1], rgb[2]] });
  console.log(`已学习颜色: 方块 ${value} -> rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
}

function readBoard(png, board) {
  const W = png.width;
  const grid = [];
  const cellW = board.w / 4;
  const cellH = board.h / 4;
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const cx = board.x + c * cellW;
      const cy = board.y + r * cellH;
      // 采集格子中心 70% 区域的主色（像素直方图众数），抗数字字形与边缘干扰
      const x0 = Math.round(cx + cellW * 0.15);
      const x1 = Math.round(cx + cellW * 0.85);
      const y0 = Math.round(cy + cellH * 0.15);
      const y1 = Math.round(cy + cellH * 0.85);
      const buckets = new Map();
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (W * y + x) * 4;
          const R = png.data[i];
          const G = png.data[i + 1];
          const B = png.data[i + 2];
          const key = ((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4);
          const bkt = buckets.get(key);
          if (bkt) {
            bkt.n++;
            bkt.r += R;
            bkt.g += G;
            bkt.b += B;
          } else {
            buckets.set(key, { n: 1, r: R, g: G, b: B });
          }
        }
      }
      let mode = null;
      for (const bkt of buckets.values()) {
        if (!mode || bkt.n > mode.n) mode = bkt;
      }
      const rgb = mode ? [Math.round(mode.r / mode.n), Math.round(mode.g / mode.n), Math.round(mode.b / mode.n)] : [0, 0, 0];
      const bgD =
        Math.abs(rgb[0] - BOARD_BG[0]) + Math.abs(rgb[1] - BOARD_BG[1]) + Math.abs(rgb[2] - BOARD_BG[2]);
      const v = bgD < 45 ? 0 : matchValue(rgb[0], rgb[1], rgb[2]);
      row.push({ v, rgb });
    }
    grid.push(row);
  }
  return grid;
}

function gridValues(grid) {
  return grid.map((row) => row.map((cell) => cell.v));
}

function swipe(board, dir) {
  const cx = board.x + board.w / 2;
  const cy = board.y + board.h / 2;
  const dist = Math.min(board.w, board.h) * 0.42;
  const vec = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  }[dir];
  const x1 = Math.round(cx - (vec[0] * dist) / 2);
  const y1 = Math.round(cy - (vec[1] * dist) / 2);
  const x2 = Math.round(cx + (vec[0] * dist) / 2);
  const y2 = Math.round(cy + (vec[1] * dist) / 2);
  adbCmd(`shell input swipe ${x1} ${y1} ${x2} ${y2} 120`);
}

function hasLegalMove(grid) {
  return ai.legalMoves(grid).length > 0;
}

function maxTile(grid) {
  let m = 0;
  for (const row of grid) for (const v of row) if (v > m) m = v;
  return m;
}

/**
 * 读取当前棋盘，直到读到“干净”的状态（未知格子 <= 3）。
 * 遇到广告/弹窗遮挡时等待后重试；持续异常返回 null。
 */
function readGridUntilClean() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const shot = capture();
    const boardNow = findBoard(shot.png);
    const grid = readBoard(shot.png, boardNow);
    const values = gridValues(grid);
    const unknown = values.flat().filter((v) => v === -1).length;
    if (unknown <= 3) return { values, boardNow, cells: grid };
    sleepSync(1500);
  }
  return null;
}

const args = process.argv.slice(2);
const depthArg = args.includes('--depth')
  ? parseInt(args[args.indexOf('--depth') + 1], 10)
  : null;
const useCpp = args.includes('--cpp') || process.env.AI_CPP === '1';
const budgetArg = args.includes('--budget')
  ? parseInt(args[args.indexOf('--budget') + 1], 10)
  : 400000;

function main() {
  const calibrate = args.includes('--calibrate');
  const once = args.includes('--once');
  const movesArg = args.includes('--moves') ? parseInt(args[args.indexOf('--moves') + 1], 10) : null;
  const verbose = args.includes('--verbose');

  const { png, buf } = capture();
  const board = findBoard(png);
  console.log(`棋盘区域: x=${board.x} y=${board.y} w=${board.w} h=${board.h}`);

  if (calibrate) {
    const grid = readBoard(png, board);
    fs.writeFileSync('emulator-shot.png', buf);
    console.log('已保存截图 emulator-shot.png');
    console.log('16 格识别结果 (value, rgb):');
    for (let r = 0; r < 4; r++) {
      const line = grid[r]
        .map((c) => `${c.v === -1 ? '?' : c.v}(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]})`)
        .join('  ');
      console.log(`  ${line}`);
    }
    return;
  }

  let prevGrid = null;
  let lastDir = null;
  let moves = 0;
  let maxV = 0;
  let bad = 0;

  while (true) {
    const clean = readGridUntilClean();
    if (!clean) {
      console.log(`屏幕持续异常（可能是广告/弹窗或游戏结束界面），已停止。共 ${moves} 步, 最大方块 ${maxV}`);
      break;
    }
    let { values, boardNow, cells } = clean;
    maxV = Math.max(maxV, maxTile(values));

    // 物理一致性门禁：上一步的结果应等于“上一步棋盘的模拟移动 + 一个新生成的方块”，
    // 不符合就等待动画/界面稳定后重读，最多重试 4 次
    if (prevGrid && lastDir) {
      const sim = ai.simulateMove(prevGrid, lastDir);
      if (sim.moved) {
        const diffCells = (g) => {
          const d = [];
          for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
              if (g[r][c] !== sim.grid[r][c]) {
                d.push({ r, c, next: g[r][c], sim: sim.grid[r][c] });
              }
            }
          }
          return d;
        };
        const isOk = (d) =>
          d.length === 1 && sim.grid[d[0].r][d[0].c] === 0 && (d[0].next === 2 || d[0].next === 4);

        let diffs = diffCells(values);
        if (!isOk(diffs)) {
          let retried = false;
          for (let t = 0; t < 4 && !isOk(diffs); t++) {
            sleepSync(1200);
            const retry = readGridUntilClean();
            if (!retry) break;
            values = retry.values;
            boardNow = retry.boardNow;
            cells = retry.cells;
            maxV = Math.max(maxV, maxTile(values));
            diffs = diffCells(values);
            retried = true;
          }
          if (!isOk(diffs)) {
            bad++;
            console.log(`一致性警告 step ${moves} (dir=${lastDir}): ${JSON.stringify(diffs)}`);
          } else if (retried) {
            if (verbose) console.log(`step ${moves}: 重读后一致性通过`);
          }
          // 自校准：以模拟结果为真值，学习未识别/误读格子的真实颜色
          for (const d of diffs) {
            if (sim.grid[d.r][d.c] !== 0) {
              learnColor(sim.grid[d.r][d.c], cells[d.r][d.c].rgb);
            }
          }
        }
      }
    }

    if (movesArg !== null && moves >= movesArg) {
      console.log(`达到步数上限: ${moves} 步, 最大方块 ${maxV}, 警告数 ${bad}`);
      break;
    }
    if (!hasLegalMove(values)) {
      console.log(`游戏结束: 共 ${moves} 步, 最大方块 ${maxV}, 警告数 ${bad}`);
      break;
    }

    let dir = null;
    if (useCpp) {
      dir = bestMoveCpp(values, budgetArg);
      if (!dir && verbose) console.log('2048ai.exe 不可用，回退到 JS AI');
    }
    if (!dir) dir = ai.bestMove(values, { depth: depthArg || undefined, timeoutMs: 250 });
    if (!dir) {
      console.log(`游戏结束: 共 ${moves} 步, 最大方块 ${maxV}, 警告数 ${bad}`);
      break;
    }
    if (verbose) console.log(`step ${moves}: dir=${dir} max=${maxV}`);
    swipe(boardNow, dir);
    prevGrid = values;
    lastDir = dir;
    moves++;
    if (once) {
      console.log(`已走一步（方向 ${dir}），最大方块 ${maxV}`);
      break;
    }
    sleepSync(DELAY);
  }
}

main();
