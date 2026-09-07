@echo off
rem Single entry for ALL project functions: double-click opens the menu.
rem Skip the menu by passing an action name, e.g.: start-router.bat restart
cd /d "%~dp0"

set "ACTION_ARG="
if not "%~1"=="" set "ACTION_ARG=-Action %~1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-router.ps1" %ACTION_ARG%
if errorlevel 1 (
  echo.
  echo Action failed. Check the message above.
  pause
  exit /b 1
)
