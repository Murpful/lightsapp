@echo off
rem LightsApp launcher. Node lives in the user profile (no admin install), so the
rem explicit path below is a fallback in case PATH has not been picked up yet.
setlocal
set "NODE_DIR=%LOCALAPPDATA%\Programs\node-v24.19.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

cd /d "%~dp0"

rem Give the server a moment to bind before the browser opens.
start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8420"

node server.js
if errorlevel 1 (
  echo.
  echo LightsApp exited with an error. Press any key to close.
  pause >nul
)
