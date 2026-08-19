@echo off
rem Start the local C++ AI server, then open the web game.
rem The auto-play button in the page uses 2048ai.exe through this server.
set "NODE=C:\Users\zhangjie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
start "2048-CppServer" /min "%NODE%" "%~dp0server.js"
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:8123/"
