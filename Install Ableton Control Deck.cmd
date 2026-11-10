@echo off
rem Double-click installer for Ableton Control Deck on Windows.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
echo.
echo   ABLETON CONTROL DECK - INSTALLER
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed yet, and Control Deck needs it to run.
  echo.
  echo   1. Your browser is opening https://nodejs.org - download the LTS
  echo      version and run its installer ^(all default options are fine^).
  echo   2. When it finishes, double-click this installer again.
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)
node scripts\setup.mjs
if errorlevel 1 (
  echo.
  echo   Something went wrong - see the lines marked with an X above. It is safe
  echo   to run this installer again after fixing the issue.
) else (
  echo   Opening the connection guide in your browser...
  timeout /t 2 >nul
  start "" "http://127.0.0.1:50713/connect"
)
echo.
pause