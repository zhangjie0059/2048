'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 搭建最小 DOM 桩，加载 game.js（浏览器耦合部分全部被替换），
 * 并通过 window.__game2048 钩子驱动真实游戏逻辑。
 */
module.exports = function setupDomStub() {
  const ids = {};

  const makeEl = (tag = 'div') => ({
    tag,
    className: '',
    textContent: '',
    value: '',
    children: [],
    clientWidth: 500,
    _listeners: {},
    style: {
      setProperty(k, v) { this[k] = v; },
    },
    classList: {
      _set: new Set(),
      add(...cs) { cs.forEach((c) => this._set.add(c)); },
      remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    appendChild(child) { this.children.push(child); },
    remove() { this._removed = true; },
  });

  [
    'board', 'board-grid', 'tiles', 'score', 'best',
    'overlay', 'overlay-title', 'overlay-text', 'overlay-btn', 'restart',
    'autoplay-btn', 'autoplay-speed', 'autoplay-status',
  ].forEach((id) => { ids[id] = makeEl(); });

  const docListeners = {};
  global.document = {
    getElementById(id) { return ids[id]; },
    createElement: (tag) => makeEl(tag),
    body: makeEl('body'),
    addEventListener(type, fn) {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
  };

  global.window = {
    addEventListener(type, fn) {
      (this._listeners = this._listeners || {})[type] = this._listeners[type] || [];
      this._listeners[type].push(fn);
    },
    _listeners: {},
  };

  global.localStorage = {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
  };

  // 确定性随机：[生成位置比例, 生成值比例]
  let randQueue = [];
  Math.random = () => (randQueue.length ? randQueue.shift() : 0.5);
  const queueRands = (...xs) => { randQueue = xs; };

  const loadScript = (relPath) => {
    const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    // eslint-disable-next-line no-eval
    eval(src);
  };

  return { ids, docListeners, queueRands, loadScript };
};
