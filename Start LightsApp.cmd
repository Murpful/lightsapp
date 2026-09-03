@echo off
rem Double-click target for the desktop icon. Starts the server if it is not
rem already running, then opens the app. Safe to run twice.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
if errorlevel 1 pause
