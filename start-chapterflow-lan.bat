@echo off
chcp 65001 > nul
cd /d "%~dp0"
rem NOTE: Keep this file ASCII with CRLF line endings (see start-chapterflow.bat).
rem Data-dir choice is delegated to resolveDefaultDataDir in src/server/config.ts.
rem The dist server has no repo-fixture default, so no env var is needed here.

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
