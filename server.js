#!/usr/bin/env node
/*
 * 2048 网页版 + C++ 引擎 本地服务器。
 * 作用：网页里的“自动”按钮通过 /api/move 调用 2048ai.exe（浏览器不能直接运行 exe）。
 *
 * 启动：node server.js   （默认端口 8123）
 * 用法：浏览器打开 http://localhost:8123/
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { bestMoveCpp } = require('./engine.js');

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT, 10) || 8123;
const BUDGET = parseInt(process.env.BUDGET, 10) || 2097152;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/move') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const { grid } = JSON.parse(body);
        const move = bestMoveCpp(grid, BUDGET);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ move }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  // 静态文件
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`2048 C++ 服务器已启动: http://localhost:${PORT}/ （预算 ${BUDGET}）`);
});
