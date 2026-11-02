@echo off
cd /d "%~dp0"
title 理财产品聚焦 本地服务 8766
echo.
echo 正在启动本地服务（实时抓取银行净值）...
echo 启动后请用浏览器打开： http://localhost:8766/
echo 关闭本窗口即停止服务。
echo.
rem node 查找顺序：① 本目录自带 node.exe（便携）→ ② 系统 PATH → ③ WorkBuddy 运行时
set "NODE_EXE="
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul && set "NODE_EXE=node"
)
if not defined NODE_EXE (
  for /f "delims=" %%d in ('dir /b /ad /o-n "C:\Users\a\.workbuddy\binaries\node\versions\22.*" 2^>nul') do (
    if not defined NODE_EXE if exist "C:\Users\a\.workbuddy\binaries\node\versions\%%d\node.exe" set "NODE_EXE=C:\Users\a\.workbuddy\binaries\node\versions\%%d\node.exe"
  )
)
if not defined NODE_EXE (
  echo [错误] 未找到 node：请把 node.exe 放在本目录，或先安装 Node.js。
  pause
  exit /b 1
)
"%NODE_EXE%" serve.mjs 8766
pause
