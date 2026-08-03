@echo off
rem Web 2048 autoplay launcher (double-click to run).
rem Usage:
rem   web-run.bat
rem       -> play the bundled local web version (default)
rem   web-run.bat https://xxx/2048/
rem       -> play the given web 2048 URL
rem   web-run.bat <url> --headed
rem       -> show the browser window (default is headless)
rem   web-run.bat <url> --budget 1000000
rem       -> override C++ per-move search budget (default 2097152)
rem   web-run.bat --headless
rem       -> run in the background without a visible window
setlocal

set "NODE=C:\Users\zhangjie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

set "P=%~dp0index.html"
set "DEFAULT_URL=file:///%P:\=/%"

set "FIRST=%~1"
set "URL=%FIRST%"
set "EXTRA="
if "%FIRST%"=="" set "URL=%DEFAULT_URL%"
if "%FIRST:~0,1%"=="-" (
  set "URL=%DEFAULT_URL%"
  set "EXTRA=%*"
) else if not "%FIRST%"=="" (
  set "EXTRA=%2 %3 %4 %5 %6 %7 %8 %9"
)

echo Starting web autoplay: %URL%
"%NODE%" "%~dp0web-autoplay.js" --url "%URL%" --budget 2097152 --headed %EXTRA%
endlocal
