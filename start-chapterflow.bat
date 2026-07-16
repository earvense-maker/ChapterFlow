@echo off
chcp 65001 > nul
cd /d "%~dp0"
rem NOTE: Keep this file ASCII with CRLF line endings. cmd mis-parses batch files
rem that mix UTF-8 multibyte comments with LF-only endings (the set line below
rem was silently skipped when this header was written in Japanese).
rem Data-dir choice is delegated to resolveDefaultDataDir in src/server/config.ts
rem (auto-detects Documents\ChapterFlow or legacy Documents\Yumeweaving by real
rem works, so an empty new folder never hides old ones). Do not pick a folder here.
rem This flag only disables the repo-fixture default (data\) in scripts/dev-server.mjs.
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
