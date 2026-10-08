@echo off
cd /d "%~dp0"
if exist "release\AlphaCode-win32-x64\AlphaCode.exe" (
  start "" "release\AlphaCode-win32-x64\AlphaCode.exe"
) else (
  call npm start
)
