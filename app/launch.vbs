Set WshShell = CreateObject("WScript.Shell")
' 0 hides the window, False means don't wait for it to finish
WshShell.Run "node agent.js", 0, False