@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org ^(version 20 or newer^).
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing packages, this only happens once...
  call npm install
)
node src/manager/index.js
pause
