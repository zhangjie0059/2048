(() => {
  'use strict';

  const SIZE = 4;
  const GAP = 15;

  const boardEl = document.getElementById('board');
  const boardGridEl = document.getElementById('board-grid');
  const tilesEl = document.getElementById('tiles');
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const overlayEl = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayText = document.getElementById('overlay-text');
  const overlayBtn = document.getElementById('overlay-btn');
  const restartBtn = document.getElementById('restart');
  const autoplayBtn = document.getElementById('autoplay-btn');
  const autoplaySpeed = document.getElementById('autoplay-speed');
  const autoplayStatus = document.getElementById('autoplay-status');
  const multiplierSelect = document.getElementById('multiplier');
  const targetEl = document.getElementById('target');

  const KEY_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', a: 'left', s: 'down', d: 'right',
    W: 'up', A: 'left', S: 'down', D: 'right',
  };

  const DIRS = {
    up: { dr: -1, dc: 0 },
    down: { dr: 1, dc: 0 },
    left: { dr: 0, dc: -1 },
    right: { dr: 0, dc: 1 },
  };

  let grid = null;
  let score = 0;
  let best = 0;
  let won = false;
  let over = false;
  let busy = false;
  let nextId = 1;
  let CELL = 0;
  let multiplier = 1;

  const els = new Map(); // tileId -> DOM element
  const autoplay = { running: false, timer: null, steps: 0 };
  let fastMode = false;

  function bestKey() {
    return multiplier === 1 ? 'best-2048' : 'best-2048-' + multiplier;
  }

  function loadBest() {
    try {
      best = parseInt(localStorage.getItem(bestKey()), 10) || 0;
    } catch (e) {
      best = 0;
    }
  }

  function saveBest() {
    try {
      localStorage.setItem(bestKey(), String(best));
    } catch (e) {
      /* localStorage unavailable (e.g. some privacy modes) */
    }
  }

  function winTarget() {
    return 2048 * multiplier;
  }

  function computeCellSize() {
    const w = boardEl.clientWidth;
    CELL = (w - GAP * (SIZE + 1)) / SIZE;
  }

  function newGame() {
    grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    score = 0;
    won = false;
    over = false;
    busy = false;
    hideOverlay();
    targetEl.textContent = winTarget();

    for (const el of els.values()) el.remove();
    els.clear();

    addRandomTile();
    addRandomTile();
    computeCellSize();
    render();
    updateScore();
  }

  function addRandomTile() {
    const empty = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!grid[r][c]) empty.push([r, c]);
      }
    }
    if (!empty.length) return null;
    const [r, c] = empty[Math.floor(Math.random() * empty.length)];
    const tile = {
      id: nextId++,
      row: r,
      col: c,
      // 1倍保持原版 90% 出 2 / 10% 出 4；4/8/16 倍则恒定刷新倍数本身
      value: multiplier === 1 ? (Math.random() < 0.9 ? 2 : 4) : multiplier,
      isNew: true,
      merged: false,
      absorbed: null,
    };
    grid[r][c] = tile;
    return tile;
  }

  // 颜色阶梯按倍数等比缩放：基数方块（multiplier）始终对应普通模式的 2
  function colorKey(value) {
    const cv = multiplier === 1 ? value : (value * 2) / multiplier;
    if (cv >= 2048) return 'tile-super';
    return 'tile-' + cv;
  }

  function tileClass(tile) {
    let cls = 'tile ' + colorKey(tile.value);
    if (tile.value === winTarget()) cls += ' tile-win';
    if (tile.isNew) cls += ' tile-new';
    if (tile.merged) cls += ' tile-merged';
    return cls;
  }

  function tileFontSize(tile) {
    const digits = String(tile.value).length;
    if (digits <= 2) return CELL * 0.48;
    if (digits === 3) return CELL * 0.42;
    if (digits === 4) return CELL * 0.36;
    return CELL * 0.28;
  }

  function ensureEl(tile) {
    let el = els.get(tile.id);
    if (!el) {
      el = document.createElement('div');
      els.set(tile.id, el);
      tilesEl.appendChild(el);
    }
    return el;
  }

  function placeTile(el, tile) {
    el.style.width = CELL + 'px';
    el.style.height = CELL + 'px';
    const pos = `translate(${tile.col * (CELL + GAP)}px, ${tile.row * (CELL + GAP)}px)`;
    el.style.setProperty('--pos', pos);
    el.style.transform = pos;
  }

  function render(opts = {}) {
    const alive = new Set();
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r][c];
        if (!t) continue;
        alive.add(t.id);
        if (opts.keepAbsorbed && t.absorbed) alive.add(t.absorbed.id);
      }
    }

    for (const [id, el] of els) {
      if (!alive.has(id)) {
        el.remove();
        els.delete(id);
      }
    }

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r][c];
        if (!t) continue;
        const el = ensureEl(t);
        el.className = tileClass(t);
        el.textContent = t.value;
        el.style.fontSize = tileFontSize(t) + 'px';
        placeTile(el, t);
      }
    }

    if (opts.keepAbsorbed) {
      // Absorbed tiles slide to the surviving tile's position before removal.
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const t = grid[r][c];
          if (t && t.absorbed) {
            const absorbedEl = ensureEl(t.absorbed);
            placeTile(absorbedEl, { row: r, col: c });
          }
        }
      }
    }
  }

  function updateScore() {
    scoreEl.textContent = score;
    if (score > best) {
      best = score;
      bestEl.textContent = best;
      saveBest();
    }
  }

  function move(dirName) {
    if (busy || over) return;
    const dir = DIRS[dirName];

    // Traverse cells in the direction of movement so the front tiles are handled first.
    const order = [];
    for (let i = 0; i < SIZE; i++) {
      for (let j = 0; j < SIZE; j++) {
        if (dir.dc === -1) order.push([i, j]);                 // left:  rows, L -> R
        else if (dir.dc === 1) order.push([i, SIZE - 1 - j]);  // right: rows, R -> L
        else if (dir.dr === -1) order.push([j, i]);            // up:    cols, T -> B
        else order.push([SIZE - 1 - j, i]);                    // down:  cols, B -> T
      }
    }

    let moved = false;

    // Phase 1: slide every tile to the farthest empty cell in the direction.
    for (const [r, c] of order) {
      const tile = grid[r][c];
      if (!tile) continue;

      let nr = r, nc = c;
      let fr = r, fc = c; // farthest empty cell in this direction

      while (true) {
        const tr = nr + dir.dr;
        const tc = nc + dir.dc;
        if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) break;

        const target = grid[tr][tc];
        if (!target) {
          fr = tr;
          fc = tc;
          nr = tr;
          nc = tc;
          continue;
        }
        break;
      }

      if (fr !== r || fc !== c) {
        grid[r][c] = null;
        tile.row = fr;
        tile.col = fc;
        grid[fr][fc] = tile;
        moved = true;
      }
    }

    // Phase 2: merge adjacent equal tiles (front tile survives, rear tile is absorbed).
    for (const [r, c] of order) {
      const tile = grid[r][c];
      if (!tile || tile.merged) continue;
      const tr = r + dir.dr;
      const tc = c + dir.dc;
      if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) continue;
      const target = grid[tr][tc];
      if (target && !target.merged && target.value === tile.value) {
        tile.value *= 2;
        tile.merged = true;
        tile.absorbed = target;
        target.merged = true;
        grid[tr][tc] = null;
        score += tile.value;
        moved = true;
      }
    }

    // Phase 3: slide again so remaining tiles fill the gaps left by merges.
    for (const [r, c] of order) {
      const tile = grid[r][c];
      if (!tile) continue;

      let nr = r, nc = c;
      let fr = r, fc = c;

      while (true) {
        const tr = nr + dir.dr;
        const tc = nc + dir.dc;
        if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) break;

        const target = grid[tr][tc];
        if (!target) {
          fr = tr;
          fc = tc;
          nr = tr;
          nc = tc;
          continue;
        }
        break;
      }

      if (fr !== r || fc !== c) {
        grid[r][c] = null;
        tile.row = fr;
        tile.col = fc;
        grid[fr][fc] = tile;
        moved = true;
      }
    }

    if (!moved) {
      checkEnd();
      return;
    }

    busy = true;
    addRandomTile();
    updateScore();
    render({ keepAbsorbed: true });

    const settleMs = fastMode ? 30 : 220;
    setTimeout(() => {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const t = grid[r][c];
          if (t) {
            t.merged = false;
            t.isNew = false;
            t.absorbed = null;
          }
        }
      }
      render();
      busy = false;
      checkEnd();
    }, settleMs);
  }

  function canMove() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r][c];
        if (!t) return true;
        if (c + 1 < SIZE && grid[r][c + 1] && grid[r][c + 1].value === t.value) return true;
        if (r + 1 < SIZE && grid[r + 1][c] && grid[r + 1][c].value === t.value) return true;
      }
    }
    return false;
  }

  function checkEnd() {
    if (!won) {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const t = grid[r][c];
          if (t && t.value === winTarget()) {
            won = true;
            showOverlay('你赢了！', `成功合成 ${winTarget()}！还要继续挑战更高分数吗？`, '继续游戏', hideOverlay);
            return;
          }
        }
      }
    }

    if (!canMove()) {
      over = true;
      showOverlay('游戏结束', `没有可移动的方块了，最终分数 ${score} 分`, '再来一局', newGame);
    }
  }

  function showOverlay(title, text, btnText, onClick) {
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    overlayBtn.textContent = btnText;
    overlayBtn.onclick = onClick;
    overlayEl.classList.remove('hidden');
  }

  function hideOverlay() {
    overlayEl.classList.add('hidden');
  }

  function gridValues() {
    return grid.map((row) => row.map((t) => (t ? t.value : 0)));
  }

  function maxTileValue() {
    let m = 0;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const t = grid[r][c];
        if (t && t.value > m) m = t.value;
      }
    }
    return m;
  }

  function updateAutoplayUI() {
    autoplayBtn.textContent = autoplay.running ? '⏸ 停止自动' : '▶ 自动模式';
    autoplayStatus.textContent = autoplay.running
      ? `自动运行中 · 已走 ${autoplay.steps} 步 · 最大 ${maxTileValue()}`
      : '';
  }

  function stopAutoplay() {
    autoplay.running = false;
    clearTimeout(autoplay.timer);
    autoplay.timer = null;
    fastMode = false;
    document.body.classList.remove('fast-mode');
    updateAutoplayUI();
  }

  function autoplayTick() {
    if (!autoplay.running) return;
    if (over) {
      stopAutoplay();
      return;
    }
    if (busy) {
      autoplay.timer = setTimeout(autoplayTick, 50);
      return;
    }
    // 自动模式遇到胜利弹窗时自动关闭并继续挑战更高分
    if (!overlayEl.classList.contains('hidden')) hideOverlay();

    if (!window.Twenty48AI) {
      stopAutoplay();
      autoplayStatus.textContent = 'AI 模块未加载';
      return;
    }
    const speedRaw = parseInt(autoplaySpeed.value, 10);
    const speed = Number.isFinite(speedRaw) ? speedRaw : 260;
    fastMode = speed === 0;
    document.body.classList.toggle('fast-mode', fastMode);
    const dir = window.Twenty48AI.bestMove(gridValues(), { timeoutMs: 120 });
    if (!dir) {
      stopAutoplay();
      return;
    }
    autoplay.steps++;
    updateAutoplayUI();
    move(dir);
    autoplay.timer = setTimeout(autoplayTick, speed);
  }

  function startAutoplay() {
    autoplay.running = true;
    autoplay.steps = 0;
    updateAutoplayUI();
    autoplayTick();
  }

  function toggleAutoplay() {
    if (autoplay.running) {
      stopAutoplay();
      return;
    }
    if (over) newGame();
    startAutoplay();
  }

  document.addEventListener('keydown', (e) => {
    const dir = KEY_MAP[e.key];
    if (!dir) return;
    e.preventDefault();
    move(dir);
  });

  let touchStart = null;
  boardEl.addEventListener('touchstart', (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });

  boardEl.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const dx = e.changedTouches[0].clientX - touchStart.x;
    const dy = e.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (Math.max(ax, ay) < 24) return;
    const dir = ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    move(dir);
  }, { passive: true });

  window.addEventListener('resize', () => {
    computeCellSize();
    render();
  });

  restartBtn.addEventListener('click', newGame);
  autoplayBtn.addEventListener('click', toggleAutoplay);
  multiplierSelect.addEventListener('change', () => {
    multiplier = parseInt(multiplierSelect.value, 10) || 1;
    try {
      localStorage.setItem('multiplier-2048', String(multiplier));
    } catch (e) {
      /* ignore */
    }
    loadBest();
    bestEl.textContent = best;
    newGame();
  });

  // Build the 4x4 background grid once.
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    boardGridEl.appendChild(cell);
  }

  try {
    multiplier = parseInt(localStorage.getItem('multiplier-2048'), 10) || 1;
  } catch (e) {
    multiplier = 1;
  }
  multiplierSelect.value = String(multiplier);
  loadBest();
  bestEl.textContent = best;
  newGame();

  // Testing/debug hook (harmless in production).
  if (typeof window !== 'undefined') {
    window.__game2048 = {
      newGame,
      move,
      getGrid: () => grid.map((row) => row.map((t) => (t ? t.value : 0))),
      getScore: () => score,
      getMultiplier: () => multiplier,
      setMultiplier(m) {
        multiplier = m || 1;
        try {
          localStorage.setItem('multiplier-2048', String(multiplier));
        } catch (e) {
          /* ignore */
        }
        loadBest();
        bestEl.textContent = best;
        newGame();
      },
      setGrid(values) {
        grid = values.map((row, r) =>
          row.map((v, c) =>
            v
              ? { id: nextId++, row: r, col: c, value: v, isNew: false, merged: false, absorbed: null }
              : null
          )
        );
        score = 0;
        won = false;
        over = false;
        busy = false;
        hideOverlay();
        for (const el of els.values()) el.remove();
        els.clear();
        computeCellSize();
        render();
        updateScore();
      },
    };
  }
})();
