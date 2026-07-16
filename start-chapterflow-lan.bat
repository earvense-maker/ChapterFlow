@echo off
chcp 65001 > nul
cd /d "%~dp0"
rem NOTE: 保存先の選択は src/server/config.ts の resolveDefaultDataDir に任せる
rem （作品の入った Documents\ChapterFlow / 旧 Yumeweaving を自動検出）。
rem dist のサーバーはフィクスチャ既定を持たないため、環境変数の設定は不要。

if not exist "dist\server\index.js" (
  echo [LAN] dist not found. Building...
  call npm run build
  if errorlevel 1 goto fail
)

echo [LAN] The URL for your phone will appear in the startup log below.
echo [LAN] On first launch, allow "Private network" in the Windows Firewall dialog.
call npm run start:lan
if errorlevel 1 goto fail
goto :eof

:fail
echo.
echo [ChapterFlow LAN startup failed]
echo Common cause: port 3001 is already in use.
echo Fix in PowerShell:
echo   Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001).OwningProcess -Force
pause
