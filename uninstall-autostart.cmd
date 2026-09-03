@echo off
setlocal
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LightsApp.vbs"
if exist "%VBS%" (
  del "%VBS%"
  echo Removed autostart entry.
) else (
  echo No autostart entry found.
)
pause
