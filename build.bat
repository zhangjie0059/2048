@echo off
rem Build 2048ai.exe (C++ strong AI).
rem
rem Prefers MinGW-w64 (MSYS2 UCRT64 or WinLibs). If not found, tries MSVC
rem (requires a Developer Command Prompt with the Windows SDK installed).
setlocal

set FOUND=
for %%G in (
  "C:\msys64\ucrt64\bin\g++.exe"
  "C:\msys64\mingw64\bin\g++.exe"
  "C:\mingw64\bin\g++.exe"
) do (
  if exist %%G (
    set FOUND=1
    echo Using %%G
    "%%~G" -O2 -std=c++17 -D_CRT_SECURE_NO_WARNINGS 2048ai.cpp -o 2048ai.exe
    if errorlevel 1 goto :fail
    goto :done
  )
)

where cl >nul 2>nul
if not errorlevel 1 (
  echo Using MSVC cl.exe
  cl /O2 /EHsc /std:c++17 /D_CRT_SECURE_NO_WARNINGS 2048ai.cpp
  if errorlevel 1 goto :fail
  goto :done
)

echo No compiler found. Install MSYS2 (https://www.msys2.org/), then in the
echo "MSYS2 UCRT64" terminal run:
echo   pacman -S --needed mingw-w64-ucrt-x86_64-gcc
echo Afterwards this script will find g++.exe at C:\msys64\ucrt64\bin.
exit /b 1

:fail
echo Build failed. If using MSVC, make sure the Windows 10 SDK is installed
echo (Visual Studio Installer -^> Modify -^> Individual components -^> Windows 10 SDK).
exit /b 1

:done
echo Build OK: 2048ai.exe
endlocal
