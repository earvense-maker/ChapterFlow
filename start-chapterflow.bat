@echo off
chcp 65001 > nul
cd /d "%~dp0"
rem NOTE: 保存先の選択は src/server/config.ts の resolveDefaultDataDir に任せる
rem （作品の入った Documents\ChapterFlow / 旧 Yumeweaving を自動検出し、
rem 空の新フォルダが旧作品を隠さない）。ここでフォルダを直接選ぶと判定が二重になる。
rem このフラグは dev-server.mjs のフィクスチャ既定（リポジトリ内 data\）だけを無効化する。
set "CHAPTERFLOW_USE_DEFAULT_DATA_DIR=1"
call npm run dev
if errorlevel 1 (
  echo.
  echo [ChapterFlow startup failed]
  echo Common cause: port 3001 is already in use by a leftover node process.
  echo Fix in PowerShell:
  echo   Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001).OwningProcess -Force
  pause
)
