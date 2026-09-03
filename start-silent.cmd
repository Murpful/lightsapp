@echo off
rem Starts the LightsApp server only -- no browser window.
rem This is what runs at sign-in; use start.cmd to also open the page.
setlocal
set "NODE_DIR=%LOCALAPPDATA%\Programs\node-v24.19.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0"
node server.js
