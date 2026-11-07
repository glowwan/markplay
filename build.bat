@echo off
chcp 65001 >nul
setlocal
title MarkPlay 一键构建

echo ================================
echo   MarkPlay 一键构建
echo ================================
echo.

rem ---------- 1/4 检查 Node.js ----------
echo [1/4] 检查 Node.js ...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js。
    echo 请先安装 Node.js 18 或更高版本的 LTS：
    echo   https://nodejs.org/
    echo 安装完成后，重新双击 build.bat。
    pause
    exit /b 1
)
echo      已安装：
node -v
echo.

rem ---------- 2/4 npm install ----------
echo [2/4] 安装项目依赖（npm install），可能需要几分钟，请稍候 ...
call npm install
if %errorlevel% neq 0 (
    echo [错误] npm install 失败，请检查网络连接后重试。
    pause
    exit /b 1
)
echo.

rem ---------- 3/4 下载 mpv / ffmpeg ----------
echo [3/4] 下载 mpv.exe 与 ffmpeg.exe ...
call node tools\fetch-binaries.js
if %errorlevel% neq 0 (
    echo [错误] 二进制下载失败，请按上面的提示手动下载后，再重新运行 build.bat。
    pause
    exit /b 1
)
echo.

rem ---------- 4/4 electron-builder 打包 ----------
echo [4/4] 正在构建安装包（electron-builder），首次构建约 5-15 分钟 ...
call npx electron-builder --win
if %errorlevel% neq 0 (
    echo [错误] 构建失败，请把上面的错误信息发给开发者。
    pause
    exit /b 1
)
echo.
echo ================================
echo   构建成功！
echo   安装包在 dist\ 目录下：
echo ================================
dir /b dist\*.exe
echo.
pause
