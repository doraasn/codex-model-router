@echo off
rem Start the local model router in background (127.0.0.1:4010).
rem If it is already running, exits with a notice.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Background.ps1"
if errorlevel 1 (
  echo.
  echo Router startup failed. Check logs\router.err.log
  pause
  exit /b 1
)
