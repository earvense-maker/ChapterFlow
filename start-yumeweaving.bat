@echo off
chcp 65001 > nul
cd /d "C:\Users\Yuhei\Desktop\Yumeweaving"
rem NOTE: 執筆データはリポジトリ外に置く。未設定だと data\ にフォールバックし、
rem 開発用フィクスチャと実データが混ざるので必ずここで指定する。
set "YUMEWEAVING_DATA_DIR=C:\Users\Yuhei\Documents\Yumeweaving"
npm run dev
if errorlevel 1 (
  echo.
  echo [Yumeweaving startup failed]
  echo Common cause: port 3001 is already in use by a leftover node process.
  echo Fix in PowerShell:
  echo   Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001).OwningProcess -Force
  pause
)

