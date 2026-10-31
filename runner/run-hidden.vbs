' Scheduled task launcher: runs the Update-all runner once, hidden (no console window flash).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "G:\Dropbox\alan ranger photography\Website Code\apps-dashboard"
sh.Run "node runner\update-all-runner.mjs --once", 0, True
