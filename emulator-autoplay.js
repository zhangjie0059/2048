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
const os = require('os');

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
const { bestMoveCpp } = require('./engine.js');

const LDCONSOLE = process.env.LDCONSOLE || 'E:/leidian/LDPlayer9/ldconsole.exe';
const ADB = process.env.LD_ADB || 'E:/leidian/LDPlayer9/adb.exe';
const INDEX = process.env.LD_INDEX || '0';
const DELAY = parseInt(process.env.DELAY, 10) || 350;

// 全民投资人内嵌 2048：方块 = 填充色 + 描边色，两者成对唯一确定数值。
// 实测/用户确认：2=米底+青边，4=橙底+紫边，8=蓝底+品红边，512=深底+品红边，1024=深底+蓝边。
// 其余数值由脚本在每次合成新数值时自动学习（底色+描边）。
const PALETTE = [
  { v: 2, fill: [234, 204, 154], border: [86, 195, 213] },
  { v: 4, fill: [188, 139, 82], border: [173, 142, 223] },
  { v: 8, fill: [61, 104, 173], border: [228, 130, 208] },
  { v: 16, fill: [81, 59, 60], border: [96, 120, 189] },
  { v: 32, fill: [186, 48, 48], border: [224, 87, 87] },
  { v: 64, fill: [62, 33, 27], border: [226, 206, 125] },
  { v: 128, fill: [150, 160, 168], border: [86, 195, 213] },
  { v: 512, fill: [50, 34, 29], border: [228, 130, 208] },
  { v: 1024, fill: [50, 35, 29], border: [96, 120, 189] },
  { v: 4096, fill: [81, 59, 60], border: [226, 206, 125] },
  { v: 8192, fill: [245, 206, 116], border: [86, 195, 213] },
  { v: 16384, fill: [112, 103, 158], border: [173, 142, 223] },
];
// 运行期自动学习到的颜色（以游戏物理模拟结果为真值）
const LEARNED_FILE = path.join(__dirname, 'emulator-learned.json');
let lastGridHadUnknown = false;
const PALETTE_EXTRA = (() => {
  try {
    const arr = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
})();

// 实测棋盘底色（空格）
const BOARD_BG = [176, 128, 96];
const BG_TOL = 24;
// 全民投资人 2048 棋盘位置（900x1600 竖屏，动态检测失败时的兜底）
const KNOWN_BOARD = { x: 88, y: 640, w: 725, h: 730 };
// 实际格子几何（非均匀：167px 格 + 18px 间隔）
const CELL_X = [88, 274, 460, 646];
const CELL_Y = [640, 820, 1006, 1192];

function adbCmd(cmd) {
  // 直连 adb（ldconsole 的滑动/点击偶发静默失效），带重连重试
  const port = 5555 + parseInt(INDEX, 10) * 2;
  const device = `127.0.0.1:${port}`;
  const args = ['-s', device, ...cmd.split(' ')];
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const out = execFileSync(ADB, args, {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const s = String(out);
      if (!/not found|error:|unable to connect|closed/i.test(s)) return s;
      lastErr = new Error(s.trim().slice(0, 120));
    } catch (e) {
      lastErr = e;
    }
    try {
      execFileSync(ADB, ['connect', device], {
        encoding: 'utf8',
        timeout: 15000,
      });
    } catch (e) {
      /* 重连失败也继续重试 */
    }
    {
      const start = Date.now();
      while (Date.now() - start < 600) { /* busy wait */ }
    }
  }
  throw lastErr;
}

// 截图走直连 adb（ldconsole 传大文件会截断），带重连与 PNG 完整性校验
function binaryAdb(cmd) {
  const port = 5555 + parseInt(INDEX, 10) * 2;
  const device = `127.0.0.1:${port}`;
  const tmpRemote = `/sdcard/scr_${Date.now()}_${Math.floor(Math.random() * 10000)}.png`;
  const tmpLocal = path.join(os.tmpdir(), `scr_${Date.now()}_${Math.floor(Math.random() * 10000)}.png`);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      execFileSync(ADB, ['-s', device, 'shell', 'screencap', '-p', tmpRemote], { timeout: 30000 });
      execFileSync(ADB, ['-s', device, 'pull', tmpRemote, tmpLocal], { timeout: 30000 });
      const out = fs.readFileSync(tmpLocal);
      const ok =
        out &&
        out.length > 40 &&
        out[0] === 0x89 &&
        out[1] === 0x50 &&
        out[out.length - 8] === 0x49 &&
        out[out.length - 7] === 0x45 &&
        out[out.length - 6] === 0x4e &&
        out[out.length - 5] === 0x44 &&
        out[out.length - 4] === 0xae &&
        out[out.length - 3] === 0x42 &&
        out[out.length - 2] === 0x60 &&
        out[out.length - 1] === 0x82;
      if (ok) {
        try {
          execFileSync(ADB, ['-s', device, 'shell', 'rm', '-f', tmpRemote], { timeout: 10000 });
        } catch (e) { /* 忽略 */ }
        return out;
      }
    } catch (e) {
      /* 重试 */
    }
    try {
      fs.unlinkSync(tmpLocal);
    } catch (e) { /* 忽略 */ }
    try {
      execFileSync(ADB, ['connect', device], { encoding: 'utf8', timeout: 15000 });
    } catch (e) {
      /* 重连失败也继续重试 */
    }
    const start = Date.now();
    while (Date.now() - start < 600) { /* busy wait */ }
  }
  throw new Error('截图失败（adb 无法连接）');
}

function capture() {
  const buf = binaryAdb('screencap -p');
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

// 区域主色（众数）
function modeColor(png, W, cx, cy, half) {
  const buckets = new Map();
  for (let y = cy - half; y <= cy + half; y += 2) {
    for (let x = cx - half; x <= cx + half; x += 2) {
      const i = (W * y + x) * 4;
      const R = png.data[i], G = png.data[i + 1], B = png.data[i + 2];
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
  for (const bkt of buckets.values()) if (!mode || bkt.n > mode.n) mode = bkt;
  return mode ? [Math.round(mode.r / mode.n), Math.round(mode.g / mode.n), Math.round(mode.b / mode.n)] : [0, 0, 0];
}

// 底色 + 描边 成对匹配数值
function matchValuePair(fill, border) {
  const bgD = Math.abs(fill[0] - BOARD_BG[0]) + Math.abs(fill[1] - BOARD_BG[1]) + Math.abs(fill[2] - BOARD_BG[2]);
  if (bgD < 25) return 0; // 空格
  let best = null;
  let bestD = 60;
  for (const p of PALETTE.concat(PALETTE_EXTRA)) {
    const fd = Math.hypot(fill[0] - p.fill[0], fill[1] - p.fill[1], fill[2] - p.fill[2]);
    const bd = Math.hypot(border[0] - p.border[0], border[1] - p.border[1], border[2] - p.border[2]);
    if (fd < 30 && bd < 30) {
      const d = fd + bd;
      if (d < bestD) {
        bestD = d;
        best = p.v;
      }
    }
  }
  return best || -1; // -1 = 未知（等待学习）
}

/**
 * 学习一个 (底色, 描边) -> 数值 的映射（仅当该值尚未被学习）。
 */
function learnColorPair(value, fill, border) {
  if (!value || !fill || !border) return false;
  const bgD = Math.abs(fill[0] - BOARD_BG[0]) + Math.abs(fill[1] - BOARD_BG[1]) + Math.abs(fill[2] - BOARD_BG[2]);
  if (bgD < 30) return false; // 底色不算方块
  const all = PALETTE.concat(PALETTE_EXTRA);
  for (const p of all) {
    if (p.v === value) return false;
    if (
      Math.hypot(fill[0] - p.fill[0], fill[1] - p.fill[1], fill[2] - p.fill[2]) < 20 &&
      Math.hypot(border[0] - p.border[0], border[1] - p.border[1], border[2] - p.border[2]) < 20
    ) {
      return false;
    }
  }
  PALETTE_EXTRA.push({ v: value, fill: [fill[0], fill[1], fill[2]], border: [border[0], border[1], border[2]] });
  try {
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(PALETTE_EXTRA));
  } catch (e) {
    /* 忽略 */
  }
  console.log(`已学习方块 ${value}: 底色(${fill.join(',')}) 描边(${border.join(',')})`);
  return true;
}

function readBoard(png, board) {
  const W = png.width;
  const grid = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      // 填充色：格子上部偏下（避开顶部窄条与数字）；描边色：格子左边缘内侧、垂直居中
      const fill = modeColor(png, W, CELL_X[c] + 83, CELL_Y[r] + 36, 8);
      const border = modeColor(png, W, CELL_X[c] + 10, CELL_Y[r] + 84, 4);
      const v = matchValuePair(fill, border);
      row.push({ v, rgb: fill, fill, border });
    }
    grid.push(row);
  }
  return grid;
}

function gridValues(grid) {
  return grid.map((row) => row.map((cell) => cell.v));
}

// 把识别出的棋盘排版成 4x4 文本（? 表示未知色）
function formatBoard(grid) {
  return grid
    .map((row) => row.map((c) => (c.v === -1 ? '?' : String(c.v)).padStart(5)).join(' '))
    .join('\n');
}

// 未知颜色（-1）在喂给 AI/引擎前按空格处理，避免 -1 污染搜索与模拟
function sanitizeValues(values) {
  return values.map((row) => row.map((v) => (v === -1 ? 0 : v)));
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
  for (let attempt = 0; attempt < 12; attempt++) {
    const shot = capture();
    const boardNow = findBoard(shot.png);
    const grid = readBoard(shot.png, boardNow);
    const values = gridValues(grid);
    const unknown = values.flat().filter((v) => v === -1).length;
    if (unknown > 0) lastGridHadUnknown = true;
    if (unknown === 0) {
      // 等待动画稳定：间隔后重读，连续两次一致才算干净
      sleepSync(300);
      const shot2 = capture();
      const grid2 = readBoard(shot2.png, findBoard(shot2.png));
      const values2 = gridValues(grid2);
      const unknown2 = values2.flat().filter((v) => v === -1).length;
      if (unknown2 === 0 && JSON.stringify(values) === JSON.stringify(values2)) {
        return { values, boardNow, cells: grid };
      }
    }
    sleepSync(800);
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
const restartTap = (() => {
  const raw = args.includes('--restart-tap')
    ? args[args.indexOf('--restart-tap') + 1]
    : process.env.RESTART_TAP;
  if (!raw) return null;
  const m = raw.split(/[,，]/).map((s) => parseInt(s.trim(), 10));
  if (m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1])) return { x: m[0], y: m[1] };
  return null;
})();

function main() {
  const calibrate = args.includes('--calibrate');
  const once = args.includes('--once');
  const movesArg = args.includes('--moves') ? parseInt(args[args.indexOf('--moves') + 1], 10) : null;
  const verbose = args.includes('--verbose');

  const { png, buf } = capture();
  const board = findBoard(png);
  console.log(`棋盘区域: x=${board.x} y=${board.y} w=${board.w} h=${board.h}`);

  if (!calibrate) {
    const g0 = readBoard(png, board);
    const v0 = sanitizeValues(gridValues(g0));
    if (!hasLegalMove(v0)) {
      console.log('当前棋盘已无法继续（无路可走），脚本已暂停，游戏界面保持不动。');
      console.log('请使用道具消除方块后，重新运行本脚本继续玩。');
      return;
    }
    console.log('检测到已有棋盘，从残局继续自动玩。');
  }

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
  let prevClean = false;
  let moves = 0;
  let maxV = 0;
  let bad = 0;
  let lastBoardKey = '';
  let stuckSteps = 0;

  while (true) {
    const stepStart = Date.now();
  const clean = readGridUntilClean();
  if (!clean) {
    if (lastGridHadUnknown) {
      console.log(`棋盘出现未识别的方块颜色（显示为 ?），为防出错已停止自动玩。共 ${moves} 步, 最大方块 ${maxV}`);
      console.log('请把当前棋盘上最大的数字告诉我，我学习它的颜色后重新运行。');
    } else {
      console.log(`屏幕持续异常（可能是广告/弹窗或游戏结束界面），已停止。共 ${moves} 步, 最大方块 ${maxV}`);
    }
    break;
  }
    let { values, boardNow, cells } = clean;
    // 上一步棋盘是否完全干净（无未知色）——只有干净棋盘才做一致性校验/学习，杜绝误学
    let readClean = cells.flat().every((c) => c.v !== -1);
    values = sanitizeValues(values);
    maxV = Math.max(maxV, maxTile(values));
    // 显示当前识别出的棋盘（每步一屏）
    console.log(formatBoard(cells));
    console.log('----------------');

    // 物理一致性门禁：上一步的结果应等于“上一步棋盘的模拟移动 + 一个新生成的方块”，
    // 不符合就等待动画/界面稳定后重读，最多重试 4 次
    if (prevGrid && lastDir && prevClean) {
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
        // 兼容 1 倍（新方块 2/4）与 4 倍（新方块 8）模式
        const isOk = (d) =>
          d.length === 1 &&
          sim.grid[d[0].r][d[0].c] === 0 &&
          (d[0].next === 2 || d[0].next === 4 || d[0].next === 8);

        let diffs = diffCells(values);
        if (!isOk(diffs)) {
          let retried = false;
          for (let t = 0; t < 4 && !isOk(diffs); t++) {
            sleepSync(1200);
            const retry = readGridUntilClean();
            if (!retry) break;
            values = sanitizeValues(retry.values);
            boardNow = retry.boardNow;
            cells = retry.cells;
            readClean = cells.flat().every((c) => c.v !== -1);
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
          // 自校准：以模拟结果为真值，学习未识别/误读格子的真实颜色。
          // 每次合成新数值（尤其是新的最大数）必须立刻学习，否则误读会打乱 AI 决策。
          for (const d of diffs) {
            const sv = sim.grid[d.r][d.c];
            if (sv === 0) continue;
            const cell = cells[d.r][d.c];
            if (!cell || !cell.fill) continue;
            const isBg =
              Math.abs(cell.fill[0] - BOARD_BG[0]) +
                Math.abs(cell.fill[1] - BOARD_BG[1]) +
                Math.abs(cell.fill[2] - BOARD_BG[2]) <
              30;
            if (isBg) continue; // 空格不学
            const learned = learnColorPair(sv, cell.fill, cell.border);
            if (learned && sv > maxV) {
              console.log(`发现新最大方块 ${sv}，已学习颜色，继续自动玩。`);
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
      console.log(`游戏无法继续（无路可走）: 共 ${moves} 步, 最大方块 ${maxV}, 警告数 ${bad}`);
      console.log('脚本已暂停，游戏界面保持不动。请使用道具消除方块后，重新运行脚本继续玩。');
      if (restartTap) {
        console.log(`点击重开按钮 (${restartTap.x},${restartTap.y}) ...`);
        adbCmd(`shell input tap ${restartTap.x} ${restartTap.y}`);
        sleepSync(1200);
        prevGrid = null;
        lastDir = null;
        continue;
      }
      break;
    }

    let dir = null;
    if (useCpp) {
      dir = bestMoveCpp(values, budgetArg);
      if (!dir && verbose) console.log('2048ai.exe 不可用，回退到 JS AI');
    }
    if (!dir) dir = ai.bestMove(values, { depth: depthArg || undefined, timeoutMs: 250 });
    if (!dir) {
      console.log(`无可用方向（可能已无法继续）: 共 ${moves} 步, 最大方块 ${maxV}, 警告数 ${bad}`);
      console.log('脚本已暂停，游戏界面保持不动。请使用道具消除方块后，重新运行脚本继续玩。');
      break;
    }
    // 卡死检测：棋盘连续多步不变则暂停（避免引擎基于误读无限空转；不擅自改变方向）
    const boardKey = JSON.stringify(values);
    if (boardKey === lastBoardKey) {
      stuckSteps++;
      if (stuckSteps >= 12) {
        console.log(`棋盘连续 ${stuckSteps} 步无变化（可能是识别异常或需要道具消除），脚本已暂停。共 ${moves} 步, 最大方块 ${maxV}`);
        console.log('游戏界面保持不动。若游戏还能走，请重新运行脚本；若已无法走，请用道具消除后重新运行。');
        break;
      }
    } else {
      stuckSteps = 0;
      lastBoardKey = boardKey;
    }
    swipe(boardNow, dir);
    prevGrid = values;
    prevClean = readClean;
    lastDir = dir;
    moves++;
    if (once) {
      console.log(`已走一步（方向 ${dir}），最大方块 ${maxV}，用时 ${((Date.now() - stepStart) / 1000).toFixed(1)}s`);
      break;
    }
    sleepSync(DELAY);
    console.log(`第 ${moves} 步: ${dir} | 最大=${maxV} | 用时 ${((Date.now() - stepStart) / 1000).toFixed(1)}s`);
  }
}

main();
