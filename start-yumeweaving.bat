@echo off
chcp 65001 > nul
cd /d "C:\Users\Yuhei\Desktop\Yumeweaving"
npm run dev
if errorlevel 1 (
  echo.
  echo [Yumeweaving startup failed]
  echo Common cause: port 3001 is already in use by a leftover node process.
  echo Fix in PowerShell:
  echo   Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001).OwningProcess -Force
  pause
)

