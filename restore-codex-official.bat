@echo off
setlocal
cd /d "%~dp0"

echo Restore Codex to the built-in OpenAI provider.
echo Fully quit Codex desktop and Codex CLI before continuing.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Restore-CodexOfficial.ps1"
if errorlevel 1 (
  echo.
  echo Codex official configuration restore failed.
  pause
  exit /b 1
)

echo.
echo Restore completed. Restart Codex desktop to apply it.
pause

