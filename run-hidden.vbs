' Starts the LightsApp server with no console window.
' Used by the desktop launcher; the sign-in Startup entry has its own copy.
Set s = CreateObject("WScript.Shell")
root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
s.CurrentDirectory = root
s.Run "cmd /c """ & root & "start-silent.cmd""", 0, False
