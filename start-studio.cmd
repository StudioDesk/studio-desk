@echo off
cd /d "%~dp0"
node -e "if(Number(process.versions.node.split('.')[0])<24) process.exit(1)"
if errorlevel 1 (
  echo Install Node.js 24 or later from https://nodejs.org/ and run this launcher again.
  pause
  exit /b 1
)
node scripts/supervisor.mjs
pause
