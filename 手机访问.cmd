@echo off
chcp 65001 >nul
title 智能选股 · 手机访问
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo.
  echo 未找到 Node.js。请先安装 Node.js 20 或更高版本：
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo 正在启动智能选股手机访问模式...
echo 请让手机连接与电脑相同的 Wi-Fi，再打开下方显示的“手机访问”地址。
echo 使用期间请不要关闭这个窗口。
echo.
"%NODE_EXE%" server.js --lan --open
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方错误信息。
  pause
)