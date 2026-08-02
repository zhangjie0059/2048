/*
 * 2048 AI — 纯逻辑模块（浏览器 / Node 通用）
 *
 * 算法：期望最大化搜索（expectimax）+ 启发式评估
 * - 内部使用 16 元素扁平数组表示棋盘，克隆与遍历开销极低
 * - 模拟移动与真实游戏逻辑保持一致（滑动 -> 合并 -> 补位）
 * - 启发式参考 ovolve/2048-AI：平滑度 + 单调性 + 空格数 + 最大方块
 * - 期望最大化搜索：根节点随机抽样生成位置，内部节点剪枝 + 抽样，
 *   配合置换表缓存，按空格数自适应搜索深度
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Twenty48AI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 4;
  const N = SIZE * SIZE;
  const LOST_PENALTY = 200000;
  const SPAWN_2_RATIO = 0.9;
  const CHANCE_SAMPLE = Math.round(envNum('AI_SAMPLE', 3)); // 机会节点抽样数
  const PRUNE_K = 3;       // 玩家节点保留的候选方向数
  const ROOT_SAMPLE = Math.round(envNum('AI_ROOT_SAMPLE', 8)); // 根节点机会抽样数

  // 可通过环境变量调节（Node 基准调参用；浏览器中使用默认值）
  function envNum(name, def) {
    if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
      const v = parseFloat(process.env[name]);
      if (!Number.isNaN(v)) return v;
    }
    return def;
  }
  const DIRS = {
    up: { dr: -1, dc: 0 },
    down: { dr: 1, dc: 0 },
    left: { dr: 0, dc: -1 },
    right: { dr: 0, dc: 1 },
  };
  const DIR_NAMES = ['up', 'down', 'left', 'right'];

  // 方块值恒为 2 的幂：31 - clz32(v) 即为 log2(v)，比 Math.log2 快得多
  function kOf(v) {
    return v ? 31 - Math.clz32(v) : 0;
  }

  function flatten(g2d) {
    const f = new Array(N);
    for (let i = 0; i < N; i++) f[i] = g2d[i >> 2][i & 3];
    return f;
  }

  function unflatten(f) {
    const g = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    for (let i = 0; i < N; i++) g[i >> 2][i & 3] = f[i];
    return g;
  }

  function countEmpty(f) {
    let n = 0;
    for (let i = 0; i < N; i++) if (!f[i]) n++;
    return n;
  }

  function emptyIndices(f) {
    const out = [];
    for (let i = 0; i < N; i++) if (!f[i]) out.push(i);
    return out;
  }

  // 预计算四个方向的遍历顺序
  const ORDERS = {};
  for (const dirName of ['up', 'down', 'left', 'right']) {
    const { dr, dc } = DIRS[dirName];
    const order = [];
    for (let i = 0; i < SIZE; i++) {
      for (let j = 0; j < SIZE; j++) {
        if (dc === -1) order.push(i * SIZE + j);                 // left:  rows, L -> R
        else if (dc === 1) order.push(i * SIZE + (SIZE - 1 - j)); // right: rows, R -> L
        else if (dr === -1) order.push(j * SIZE + i);            // up:    cols, T -> B
        else order.push((SIZE - 1 - j) * SIZE + i);              // down:  cols, B -> T
      }
    }
    ORDERS[dirName] = order;
  }

  // 复用的合并标记缓冲（moveFlat 同步执行、不会嵌套，可安全共享）
  const MERGED = new Uint8Array(N);

  /**
   * 在扁平棋盘上模拟一次移动。返回 { grid, moved, gained }（grid 为浅拷贝）。
   */
  function moveFlat(f0, dirName) {
    const dir = DIRS[dirName];
    if (!dir) throw new Error('moveFlat: invalid direction ' + dirName);
    const f = f0.slice();
    const order = ORDERS[dirName];
    const { dr, dc } = dir;
    let moved = false;
    let gained = 0;

    // 阶段 1：滑向最远空格
    for (const idx of order) {
      const v = f[idx];
      if (!v) continue;
      const r = (idx / SIZE) | 0;
      const c = idx % SIZE;
      let fr = r, fc = c;
      let nr = r, nc = c;
      while (true) {
        const tr = nr + dr;
        const tc = nc + dc;
        if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) break;
        if (!f[tr * SIZE + tc]) {
          fr = tr;
          fc = tc;
          nr = tr;
          nc = tc;
          continue;
        }
        break;
      }
      if (fr !== r || fc !== c) {
        f[idx] = 0;
        f[fr * SIZE + fc] = v;
        moved = true;
      }
    }

    // 阶段 2：相邻等值合并（靠后一方保留，靠前一方被吸收）
    MERGED.fill(0);
    for (const idx of order) {
      const v = f[idx];
      if (!v || MERGED[idx]) continue;
      const r = (idx / SIZE) | 0;
      const c = idx % SIZE;
      const tr = r + dr;
      const tc = c + dc;
      if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) continue;
      const tidx = tr * SIZE + tc;
      if (f[tidx] === v && !MERGED[tidx]) {
        f[idx] = v * 2;
        MERGED[idx] = 1;
        MERGED[tidx] = 1;
        f[tidx] = 0;
        gained += v * 2;
        moved = true;
      }
    }

    // 阶段 3：再次滑向最远空格，填补合并留下的空位
    for (const idx of order) {
      const v = f[idx];
      if (!v) continue;
      const r = (idx / SIZE) | 0;
      const c = idx % SIZE;
      let fr = r, fc = c;
      let nr = r, nc = c;
      while (true) {
        const tr = nr + dr;
        const tc = nc + dc;
        if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) break;
        if (!f[tr * SIZE + tc]) {
          fr = tr;
          fc = tc;
          nr = tr;
          nc = tc;
          continue;
        }
        break;
      }
      if (fr !== r || fc !== c) {
        f[idx] = 0;
        f[fr * SIZE + fc] = v;
        moved = true;
      }
    }

    return { grid: f, moved, gained };
  }

  function legalMovesFlat(f) {
    const out = [];
    for (const dir of DIR_NAMES) {
      const res = moveFlat(f, dir);
      if (res.moved) out.push({ dir, grid: res.grid, gained: res.gained });
    }
    return out;
  }

  /**
   * 启发式评估（参考 ovolve/2048-AI 的成熟配置）：
   * smoothness * 0.1 + monotonicity2 * 1.0 + log(空格数+1) * 2.7 + maxValue * 1.0
   */
  function evaluateFlat(f) {
    let smooth = 0;
    for (let idx = 0; idx < N; idx++) {
      const v = f[idx];
      if (!v) continue;
      const k = kOf(v);
      const r = (idx / SIZE) | 0;
      const c = idx % SIZE;
      for (let nc = c + 1; nc < SIZE; nc++) { // 向右找下一个占用格
        const nv = f[r * SIZE + nc];
        if (nv) {
          smooth -= Math.abs(k - kOf(nv));
          break;
        }
      }
      for (let nr = r + 1; nr < SIZE; nr++) { // 向下找下一个占用格
        const nv = f[nr * SIZE + c];
        if (nv) {
          smooth -= Math.abs(k - kOf(nv));
          break;
        }
      }
    }

    // monotonicity2：每一行/列应尽量单调（升或降均可，取更优方向）
    let t0 = 0; // 列：递减累计
    let t1 = 0; // 列：递增累计
    let t2 = 0; // 行：递减累计
    let t3 = 0; // 行：递增累计
    for (let x = 0; x < SIZE; x++) {
      let current = 0;
      let next = current + 1;
      while (next < SIZE) {
        while (next < SIZE && !f[x * SIZE + next]) next++;
        if (next >= SIZE) next--;
        const cv = f[x * SIZE + current] ? kOf(f[x * SIZE + current]) : 0;
        const nv = f[x * SIZE + next] ? kOf(f[x * SIZE + next]) : 0;
        if (cv > nv) t0 += nv - cv;
        else if (nv > cv) t1 += cv - nv;
        current = next;
        next++;
      }
    }
    for (let y = 0; y < SIZE; y++) {
      let current = 0;
      let next = current + 1;
      while (next < SIZE) {
        while (next < SIZE && !f[next * SIZE + y]) next++;
        if (next >= SIZE) next--;
        const cv = f[current * SIZE + y] ? kOf(f[current * SIZE + y]) : 0;
        const nv = f[next * SIZE + y] ? kOf(f[next * SIZE + y]) : 0;
        if (cv > nv) t2 += nv - cv;
        else if (nv > cv) t3 += cv - nv;
        current = next;
        next++;
      }
    }
    const mono = Math.max(t0, t1) + Math.max(t2, t3);

    let empty = 0;
    let maxK = 0;
    for (let i = 0; i < N; i++) {
      const v = f[i];
      if (!v) {
        empty++;
      } else {
        const k = kOf(v);
        if (k > maxK) maxK = k;
      }
    }

    return smooth * 0.1 + mono + Math.log(empty + 1) * 2.7 + maxK;
  }

  function sampleIndices(cells, limit) {
    if (cells.length <= limit) return cells;
    // 部分 Fisher-Yates 洗牌：随机无偏地取前 limit 个
    const out = cells.slice();
    for (let i = 0; i < limit; i++) {
      const j = i + Math.floor(Math.random() * (cells.length - i));
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out.slice(0, limit);
  }

  function chanceNode(f, depth, deadline, tt, limit) {
    if (Date.now() > deadline) return evaluateFlat(f);
    const cells = emptyIndices(f);
    if (!cells.length) return evaluateFlat(f);
    const sampled = cells.length <= limit ? cells : sampleIndices(cells, limit);
    let total = 0;
    for (const idx of sampled) {
      const g2 = f.slice();
      g2[idx] = 2;
      total += SPAWN_2_RATIO * search(g2, depth - 1, deadline, tt);
      g2[idx] = 4;
      total += (1 - SPAWN_2_RATIO) * search(g2, depth - 1, deadline, tt);
    }
    return total / sampled.length;
  }

  function topK(moves, k) {
    return moves
      .map((mv) => ({ mv, e: evaluateFlat(mv.grid) }))
      .sort((a, b) => b.e - a.e)
      .slice(0, k)
      .map((x) => x.mv);
  }

  function search(f, depth, deadline, tt) {
    if (Date.now() > deadline) return evaluateFlat(f);
    if (depth === 0) return evaluateFlat(f);
    const key = depth + ':' + f.join(',');
    const cached = tt.get(key);
    if (cached !== undefined) return cached;
    const moves = legalMovesFlat(f);
    if (!moves.length) {
      const v = evaluateFlat(f) - LOST_PENALTY;
      tt.set(key, v);
      return v;
    }
    const pruned = topK(moves, PRUNE_K);
    let best = -Infinity;
    for (const mv of pruned) {
      const v = depth === 1
        ? evaluateFlat(mv.grid)
        : chanceNode(mv.grid, depth, deadline, tt, CHANCE_SAMPLE);
      if (v > best) best = v;
    }
    tt.set(key, best);
    return best;
  }

  function bestMoveFlat(f, opts) {
    opts = opts || {};
    const empty = countEmpty(f);
    const depth = opts.depth || (empty > 3 ? 3 : 4);
    const moves = legalMovesFlat(f);
    if (!moves.length) return null;

    const deadline = Date.now() + (opts.timeoutMs || 150);
    const tt = new Map();
    const rootLimit = depth >= 4 ? Math.min(ROOT_SAMPLE, 5) : ROOT_SAMPLE;
    let best = -Infinity;
    let bestDir = null;
    for (const mv of moves) {
      const v = depth <= 1
        ? evaluateFlat(mv.grid)
        : chanceNode(mv.grid, depth, deadline, tt, rootLimit);
      if (v > best) {
        best = v;
        bestDir = mv.dir;
      }
    }
    return bestDir;
  }

  function randomSpawn(f) {
    const cells = emptyIndices(f);
    if (!cells.length) return false;
    const idx = cells[Math.floor(Math.random() * cells.length)];
    f[idx] = Math.random() < SPAWN_2_RATIO ? 2 : 4;
    return true;
  }

  /**
   * 用纯模拟跑完整局，返回统计结果（用于基准测试/强度验证）。
   */
  function playGame(opts) {
    opts = opts || {};
    let f = new Array(N).fill(0);
    randomSpawn(f);
    randomSpawn(f);
    let score = 0;
    let moves = 0;
    let maxTile = 0;

    while (true) {
      const dir = bestMoveFlat(f, { depth: opts.depth, timeoutMs: opts.timeoutMs });
      if (!dir) break;
      const res = moveFlat(f, dir);
      score += res.gained;
      moves++;
      if (!randomSpawn(res.grid)) break;
      for (let i = 0; i < N; i++) {
        if (res.grid[i] > maxTile) maxTile = res.grid[i];
      }
      f = res.grid;
    }
    return { score, moves, maxTile };
  }

  // ---------- 对外 API（统一使用 4x4 二维数组） ----------

  function simulateMove(grid2d, dirName) {
    const res = moveFlat(flatten(grid2d), dirName);
    return { grid: unflatten(res.grid), moved: res.moved, gained: res.gained };
  }

  function legalMoves(grid2d) {
    return legalMovesFlat(flatten(grid2d)).map((mv) => ({
      dir: mv.dir,
      grid: unflatten(mv.grid),
      gained: mv.gained,
    }));
  }

  function bestMove(grid2d, opts) {
    return bestMoveFlat(flatten(grid2d), opts);
  }

  function evaluate(grid2d) {
    return evaluateFlat(flatten(grid2d));
  }

  function cloneGrid(grid2d) {
    return grid2d.map((row) => row.slice());
  }

  function emptyCells(grid2d) {
    const cells = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!grid2d[r][c]) cells.push({ r, c });
      }
    }
    return cells;
  }

  return {
    SIZE,
    DIR_NAMES,
    cloneGrid,
    emptyCells,
    simulateMove,
    legalMoves,
    evaluate,
    bestMove,
    playGame,
  };
});
