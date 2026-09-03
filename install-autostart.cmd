@echo off
rem Registers LightsApp to launch at sign-in via the per-user Startup folder.
rem No admin rights and no scheduled task required. Run uninstall-autostart.cmd
rem to undo.
setlocal

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\LightsApp.vbs"

rem Launches the server only, with no console and no browser window. Window
rem style 0 keeps it invisible; start.cmd remains the way to open the page.
> "%VBS%" echo Set s = CreateObject("WScript.Shell")
>> "%VBS%" echo s.CurrentDirectory = "%~dp0"
>> "%VBS%" echo s.Run "cmd /c """"%~dp0start-silent.cmd""""", 0, False

echo Installed: %VBS%
echo.
echo LightsApp will start automatically when you sign in, in the background.
echo Open it at http://127.0.0.1:8420
echo Run uninstall-autostart.cmd to undo.
pause
