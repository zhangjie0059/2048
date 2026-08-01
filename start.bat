@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在打开 2048 游戏...
start "" "%~dp0index.html"
